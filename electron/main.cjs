require('dotenv').config();
const { app, BrowserWindow, ipcMain, screen, shell, protocol, net } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');

const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const execFileAsync = promisify(execFile);

// Custom protocol used by the renderer's <audio> — main fetches the actual
// stream so we can attach headers and forward Range requests for seeking.
// Must be registered as privileged before app.whenReady fires.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cupid-audio',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
  {
    scheme: 'cupid-local',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

// ── Apple Music developer token ──────────────────────────
let appleMusicToken = null;
let appleMusicTokenExpiry = 0;

function generateAppleMusicToken() {
  if (appleMusicToken && Date.now() < appleMusicTokenExpiry) {
    return appleMusicToken;
  }

  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;

  if (!teamId || !keyId) return null;

  // Find the .p8 key file in project root
  const projectRoot = path.join(__dirname, '..');
  const keyFiles = fs.readdirSync(projectRoot).filter((f) => f.endsWith('.p8'));
  if (keyFiles.length === 0) return null;

  const privateKey = fs.readFileSync(path.join(projectRoot, keyFiles[0]), 'utf8');

  appleMusicToken = jwt.sign({}, privateKey, {
    algorithm: 'ES256',
    expiresIn: '180d',
    issuer: teamId,
    header: {
      alg: 'ES256',
      kid: keyId,
    },
  });

  // Cache for 179 days
  appleMusicTokenExpiry = Date.now() + 179 * 24 * 60 * 60 * 1000;
  return appleMusicToken;
}

// ── yt-dlp stream URL fetcher ────────────────────────────
// streamCache: stream URLs (expire after ~30min on YT's side)
// videoIdCache: title → video ID, persisted so repeat lookups skip search
const streamCache = new Map();
const pendingRequests = new Map();
const videoIdCache = new Map();
const CACHE_TTL = 25 * 60 * 1000;

let videoIdCacheLoaded = false;
let videoIdCacheFile = null;
let videoIdSaveTimer = null;

function loadVideoIdCache() {
  if (videoIdCacheLoaded) return;
  videoIdCacheLoaded = true;
  try {
    videoIdCacheFile = path.join(app.getPath('userData'), 'video-id-cache.json');
    const raw = fs.readFileSync(videoIdCacheFile, 'utf8');
    for (const [k, v] of Object.entries(JSON.parse(raw))) videoIdCache.set(k, v);
  } catch {
    // no cache file yet
  }
}

function persistVideoIdCache() {
  if (!videoIdCacheFile) return;
  clearTimeout(videoIdSaveTimer);
  videoIdSaveTimer = setTimeout(() => {
    const obj = Object.fromEntries(videoIdCache);
    fs.promises.writeFile(videoIdCacheFile, JSON.stringify(obj)).catch(() => {});
  }, 500);
}

function getYtDlpPath() {
  try {
    return require('yt-dlp-exec/src/constants').YOUTUBE_DL_PATH || 'yt-dlp';
  } catch {
    return 'yt-dlp';
  }
}

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// youtubei.js handles YT Music search (audio uploads, not music videos).
// URL extraction stays on yt-dlp — YT now withholds stream URLs from WEB
// client responses without a PoToken, which youtubei.js can't generate.
let innertubePromise = null;
function getInnertube() {
  if (innertubePromise) return innertubePromise;
  innertubePromise = (async () => {
    const { Innertube, UniversalCache } = await import('youtubei.js');
    return Innertube.create({
      cache: new UniversalCache(true, path.join(app.getPath('userData'), 'innertube-cache')),
      generate_session_locally: true,
    });
  })().catch((err) => {
    innertubePromise = null;
    throw err;
  });
  return innertubePromise;
}

async function searchYouTubeMusic(title, artist) {
  const yt = await getInnertube();
  const search = await yt.music.search(`${title} ${artist}`, { type: 'song' });

  let top = search.songs?.contents?.find((c) => c?.id);
  if (!top) {
    for (const shelf of search.contents || []) {
      const item = shelf?.contents?.find?.((c) => c?.id);
      if (item) { top = item; break; }
    }
  }
  if (!top?.id) throw new Error('No song result');
  return top.id;
}

async function ytDlpExtract(target) {
  const { stdout } = await execFileAsync(getYtDlpPath(), [
    target,
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    '-g',
  ], { timeout: 15000 });
  return stdout.trim();
}

async function ytDlpSearch(title, artist) {
  const { stdout } = await execFileAsync(getYtDlpPath(), [
    `ytsearch1:"${title}" ${artist}`,
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    '--print', '%(id)s',
    '-g',
  ], { timeout: 15000 });
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const id = lines.find((l) => YT_ID_RE.test(l));
  const url = lines.find((l) => l.startsWith('http'));
  if (!id || !url) throw new Error('yt-dlp search returned no usable result');
  return { id, url };
}

// videoId → { url, time }. yt-dlp URLs last ~30min — same TTL as streamCache
const decipheredCache = new Map();
const pendingDecipher = new Map();

async function resolveStreamUrl(videoId) {
  const cached = decipheredCache.get(videoId);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.url;

  const inflight = pendingDecipher.get(videoId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const url = await ytDlpExtract(`https://www.youtube.com/watch?v=${videoId}`);
      decipheredCache.set(videoId, { url, time: Date.now() });
      return url;
    } finally {
      pendingDecipher.delete(videoId);
    }
  })();

  pendingDecipher.set(videoId, promise);
  return promise;
}

async function getStreamUrl(title, artist) {
  const cacheKey = `${title}::${artist}`;
  const cached = streamCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.url;

  const inflight = pendingRequests.get(cacheKey);
  if (inflight) return inflight;

  loadVideoIdCache();
  let videoId = videoIdCache.get(cacheKey);

  const promise = (async () => {
    try {
      if (!videoId) {
        try {
          videoId = await searchYouTubeMusic(title, artist);
        } catch (err) {
          console.warn('[youtubei search] fallback to yt-dlp:', err.message);
          const result = await ytDlpSearch(title, artist);
          videoId = result.id;
          // We already have a usable URL from yt-dlp — seed the decipher cache
          decipheredCache.set(videoId, { url: result.url, time: Date.now() });
        }
        videoIdCache.set(cacheKey, videoId);
        persistVideoIdCache();
      }

      // Best-effort pre-warm so the renderer's protocol fetch hits the decipher cache
      resolveStreamUrl(videoId).catch(() => {});

      const url = `cupid-audio://stream?id=${encodeURIComponent(videoId)}`;
      streamCache.set(cacheKey, { url, time: Date.now() });
      return url;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, promise);
  return promise;
}

const isDev = process.env.NODE_ENV === 'development';

// ── Local audio library (user-editable playlist + mp3s) ───
// In dev: read/write directly from the project's audio/ folder so edits
// during development are picked up without a seeding dance.
// In prod: bundled audio/ ships via extraResources to process.resourcesPath;
// on first launch we copy it to userData so users can add/edit freely.
function bundledAudioDir() {
  return path.join(process.resourcesPath, 'audio');
}

function userAudioDir() {
  return isDev
    ? path.join(__dirname, '..', 'audio')
    : path.join(app.getPath('userData'), 'audio');
}

function userPlaylistFile() {
  return path.join(userAudioDir(), 'playlist.json');
}

async function seedUserAudioDirIfMissing() {
  if (isDev) return;
  const dest = userAudioDir();
  try {
    await fs.promises.access(dest);
    return;
  } catch {
    // doesn't exist yet — seed it
  }

  const src = bundledAudioDir();
  await fs.promises.mkdir(dest, { recursive: true });

  try {
    const entries = await fs.promises.readdir(src);
    await Promise.all(entries.map(async (name) => {
      const from = path.join(src, name);
      const to = path.join(dest, name);
      const stat = await fs.promises.stat(from);
      if (stat.isFile()) await fs.promises.copyFile(from, to);
    }));
  } catch (err) {
    console.warn('[seed audio]', err.message);
  }
}

// Scale factor for pixel art
// Actual drawing area within 526x526 canvas: 306x497
// (23px top at bow, 110px left, 110px right, 6px bottom at heart)
const WIDTH = 415;
const HEIGHT = Math.round(415 * (497 / 306)); // maintain 306:497 aspect ratio

function createWindow() {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    icon: path.join(__dirname, '..', 'assets', 'pink', 'favicon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Lock aspect ratio so only proportional resizing is allowed
  const ASPECT = WIDTH / HEIGHT;
  win.setAspectRatio(ASPECT);

  // Window control handlers
  let preMaxBounds = null;

  const onMinimize = () => win.minimize();
  const onMaximize = () => {
    if (preMaxBounds) {
      // Restore to previous size
      win.setBounds(preMaxBounds);
      preMaxBounds = null;
    } else {
      // Fit to screen while maintaining aspect ratio
      preMaxBounds = win.getBounds();
      const { workArea } = screen.getPrimaryDisplay();
      let newWidth = workArea.width;
      let newHeight = Math.round(newWidth / ASPECT);
      if (newHeight > workArea.height) {
        newHeight = workArea.height;
        newWidth = Math.round(newHeight * ASPECT);
      }
      const x = workArea.x + Math.round((workArea.width - newWidth) / 2);
      const y = workArea.y + Math.round((workArea.height - newHeight) / 2);
      win.setBounds({ x, y, width: newWidth, height: newHeight });
    }
  };
  const onClose = () => win.close();

  const onResize = (_e, { dx, dy, corner }) => {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();

    const isRight = corner.includes('right');
    const isBottom = corner.includes('bottom');

    const effectiveDx = isRight ? dx : -dx;
    const effectiveDy = isBottom ? dy : -dy;

    let delta;
    if (Math.abs(effectiveDx) > Math.abs(effectiveDy)) {
      delta = effectiveDx;
    } else {
      delta = effectiveDy;
    }

    const dw = Math.round(delta);
    const newWidth = bounds.width + dw;
    const newHeight = Math.round(newWidth / ASPECT);
    const dh = newHeight - bounds.height;

    const newBounds = {
      x: isRight ? bounds.x : bounds.x - dw,
      y: isBottom ? bounds.y : bounds.y - dh,
      width: newWidth,
      height: newHeight,
    };

    if (newBounds.width >= 200 && newBounds.height >= 200) {
      win.setBounds(newBounds);
    }
  };

  const onOpenExternal = (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      if (url.includes('accounts.spotify.com/authorize')) {
        const authWin = new BrowserWindow({
          width: 500,
          height: 700,
          parent: win,
          modal: true,
          show: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        });
        authWin.loadURL(url);
        const handleAuthRedirect = (event, callbackUrl) => {
          if (callbackUrl.startsWith('http://127.0.0.1:5173/callback')) {
            event.preventDefault();
            const url = new URL(callbackUrl);
            let target;
            if (isDev) {
              target = `http://127.0.0.1:5173/${url.search}`;
            } else {
              const fileUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html'));
              fileUrl.search = url.search;
              target = fileUrl.href;
            }
            win.loadURL(target);
            authWin.close();
          }
        };
        authWin.webContents.on('will-redirect', handleAuthRedirect);
        authWin.webContents.on('will-navigate', handleAuthRedirect);
        return;
      }
      shell.openExternal(url);
    }
  };

  const onSetTheme = (_e, theme) => {
    const iconPath = path.join(__dirname, '..', 'assets', theme, 'favicon.png');
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(iconPath);
    }
    win.setIcon(iconPath);
  };

  ipcMain.on('window-minimize', onMinimize);
  ipcMain.on('window-maximize', onMaximize);
  ipcMain.on('window-close', onClose);
  ipcMain.on('window-resize', onResize);
  ipcMain.on('open-external', onOpenExternal);
  ipcMain.on('set-theme', onSetTheme);

  // Clean up IPC listeners when window is destroyed
  win.on('closed', () => {
    ipcMain.removeListener('window-minimize', onMinimize);
    ipcMain.removeListener('window-maximize', onMaximize);
    ipcMain.removeListener('window-close', onClose);
    ipcMain.removeListener('window-resize', onResize);
    ipcMain.removeListener('open-external', onOpenExternal);
    ipcMain.removeListener('set-theme', onSetTheme);
  });

  // Handle Spotify OAuth callback in production.
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'accounts.spotify.com') {
        event.preventDefault();
        shell.openExternal(url);
        return;
      }
      if (parsed.pathname === '/callback' && parsed.searchParams.has('code')) {
        if (!isDev) {
          event.preventDefault();
          const fileUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html'));
          fileUrl.search = parsed.search;
          win.loadURL(fileUrl.href);
        }
      }
    } catch {
      // ignore invalid URLs
    }
  });

  // Toggle DevTools with Cmd+Shift+I / Ctrl+Shift+I / F12
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const isDevToolsShortcut = input.key.toLowerCase() === 'i' && input.shift && (input.meta || input.control);
    if (isDevToolsShortcut || input.key === 'F12') {
      win.webContents.toggleDevTools({ mode: 'detach' });
    }
  });

  if (isDev) {
    win.loadURL('http://127.0.0.1:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ── Global IPC handlers (persist across window reloads) ──
ipcMain.handle('get-apple-music-token', () => {
  return generateAppleMusicToken();
});

ipcMain.handle('get-stream-url', async (_e, title, artist) => {
  try {
    return await getStreamUrl(title, artist);
  } catch (err) {
    throw new Error(`Failed to get stream: ${err.message}`);
  }
});

ipcMain.handle('get-local-playlist', async () => {
  try {
    const raw = await fs.promises.readFile(userPlaylistFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[playlist.json]', err.message);
    return [];
  }
});

ipcMain.handle('get-local-audio-path', (_e, filename) => {
  if (typeof filename !== 'string' || !filename) return null;
  // Reject path traversal and absolute paths — filename must be a basename
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return null;
  }
  // Use a custom protocol so the dev renderer (served over http://) can play it —
  // <audio> won't load file:// URLs cross-origin.
  return `cupid-local://audio/${encodeURIComponent(filename)}`;
});

ipcMain.handle('open-music-folder', async () => {
  const dir = userAudioDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await shell.openPath(dir);
  return dir;
});

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, '..', 'assets', 'pink', 'favicon.png'));
  }

  seedUserAudioDirIfMissing().catch((err) => console.warn('[seed]', err.message));

  protocol.handle('cupid-local', async (request) => {
    try {
      const u = new URL(request.url);
      const filename = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (!filename || filename.includes('..') || filename.includes('\\') || filename.includes('/')) {
        return new Response('forbidden', { status: 403 });
      }
      const filePath = path.join(userAudioDir(), filename);
      const stat = await fs.promises.stat(filePath);
      const total = stat.size;
      const range = request.headers.get('Range');

      const ext = path.extname(filename).toLowerCase();
      const mimeByExt = {
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.flac': 'audio/flac',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.opus': 'audio/ogg',
      };
      const contentType = mimeByExt[ext] || 'application/octet-stream';

      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        const start = match ? parseInt(match[1], 10) : 0;
        const end = match && match[2] ? parseInt(match[2], 10) : total - 1;
        const nodeStream = fs.createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(nodeStream), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type': contentType,
          },
        });
      }

      return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
          'Content-Type': contentType,
        },
      });
    } catch (err) {
      console.error('[cupid-local]', err.message);
      return new Response('not found', { status: 404 });
    }
  });

  protocol.handle('cupid-audio', async (request) => {
    try {
      const id = new URL(request.url).searchParams.get('id');
      if (!id) return new Response('missing id', { status: 400 });

      const streamUrl = await resolveStreamUrl(id);

      const headers = {
        Origin: 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/',
        'User-Agent': 'Mozilla/5.0',
      };
      const range = request.headers.get('Range');
      if (range) headers.Range = range;

      const upstream = await net.fetch(streamUrl, { headers });
      const respHeaders = new Headers(upstream.headers);
      respHeaders.set('Content-Type', 'audio/mp4');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      console.error('[cupid-audio]', err.message);
      return new Response('failed', { status: 502 });
    }
  });

  createWindow();

  // Pre-warm both engines so the first track load skips cold-start
  getInnertube().catch(() => {});
  execFile(getYtDlpPath(), ['--version'], () => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
