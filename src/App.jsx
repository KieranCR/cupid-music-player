import { useCallback, useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './App.css';
import useAudioPlayer from './useAudioPlayer';
import useSpotifyPlayer from './useSpotifyPlayer';
import useTheme from './useTheme';
import {
  login as spotifyLogin,
  handleCallback,
  isLoggedIn as isSpotifyLoggedIn,
  logout as spotifyLogout,
  getClientId as getSpotifyClientId,
  setClientId as setSpotifyClientId,
  isConfigured as isSpotifyConfigured,
} from './spotify/auth.js';
import { fetchPlaylistTracks as fetchSpotifyTracks, fetchMyPlaylists as fetchSpotifyPlaylists } from './spotify/api.js';
import { login as appleLogin, logout as appleLogout, isLoggedIn as isAppleLoggedIn, initMusicKit } from './apple/auth.js';
import { fetchMyPlaylists as fetchApplePlaylists, fetchPlaylistTracks as fetchAppleTracks } from './apple/api.js';
import {
  login as youtubeLogin,
  logout as youtubeLogout,
  isLoggedIn as isYouTubeLoggedIn,
  isConfigured as isYouTubeConfigured,
  cancelLogin as cancelYouTubeLogin,
} from './youtube/auth.js';
import {
  parsePlaylistUrl as parseYouTubePlaylistUrl,
  fetchPlaylistByUrl as fetchYouTubePlaylistByUrl,
  fetchMyPlaylists as fetchYouTubePlaylists,
  fetchPlaylistTracks as fetchYouTubeTracks,
} from './youtube/api.js';

import progressBarStars from '../assets/progress_bar_stars.png';
import star from '../assets/star.png';
import starSelected from '../assets/star_selected.png';

function useResize(corner) {
  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    window.cupid?.resizeStart({ x: e.screenX, y: e.screenY, corner });

    const onMouseMove = (e) => {
      window.cupid?.resize({ x: e.screenX, y: e.screenY });
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.cupid?.resizeEnd();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [corner]);

  return onMouseDown;
}

function formatTime(seconds) {
  if (!seconds || !isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatCountdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const SLEEP_TIMER_OPTIONS = [
  { value: 'off', label: 'off' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '60 minutes' },
];

const RESUME_KEY = 'cupid-player-resume';
const NIGHT_MODE_KEY = 'cupid-player-night-mode';
const SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:5173/callback';
const APPLE_KEYS_URL = 'https://developer.apple.com/account/resources/authkeys/list';

function readResumeState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function SettingsDropdown({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;

    const updateRect = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setMenuRect({ top: r.bottom, left: r.left, width: r.width });
    };
    updateRect();

    const onMouseDown = (e) => {
      if (!triggerRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', updateRect);
    // Close on scroll anywhere — positions become stale fast
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className={`settings-dropdown ${open ? 'open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="settings-dropdown-trigger"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current?.label ?? value}</span>
        <span className="settings-dropdown-chevron" aria-hidden="true">▾</span>
      </button>
      {open && menuRect && createPortal(
        <div
          ref={menuRef}
          className="settings-dropdown-menu"
          role="listbox"
          style={{
            position: 'fixed',
            top: `${menuRect.top + 2}px`,
            left: `${menuRect.left}px`,
            width: `${menuRect.width}px`,
          }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`settings-dropdown-item ${o.value === value ? 'active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </div>,
        // Portal to .player so CSS custom properties (--color-primary, etc.)
        // and the theme class still cascade. document.body would orphan them.
        document.querySelector('.player') ?? document.body,
      )}
    </div>
  );
}

function PlaylistList({ loading, playlists, loadingPlaylist, onSelect, emptyMessage = 'no playlists found' }) {
  return (
    <div className="settings-playlist-list">
      {loading ? (
        <div className="settings-label">loading...</div>
      ) : playlists.length === 0 ? (
        <div className="settings-label">{emptyMessage}</div>
      ) : (
        playlists.map((p) => (
          <button
            key={p.id}
            className={`settings-playlist-item ${loadingPlaylist ? 'disabled' : ''}`}
            onClick={() => onSelect(p.id)}
            disabled={loadingPlaylist}
          >
            {p.name}
          </button>
        ))
      )}
    </div>
  );
}

function AboutLink({ href, label, detail }) {
  return (
    <a className="settings-about-link" href={href} target="_blank" rel="noreferrer">
      <span>{label}</span>
      <strong>{detail}</strong>
    </a>
  );
}

function SpotifySetupHelp() {
  return (
    <div className="settings-help">
      <div className="settings-help-copy">
        create a spotify app, copy its client id, then paste it into cupid player.
      </div>
      <div className="settings-help-list">
        <span>1. open the spotify developer dashboard</span>
        <span>2. create an app and choose web api if asked</span>
        <span>3. add this redirect uri exactly</span>
        <code>{SPOTIFY_REDIRECT_URI}</code>
        <span>4. save, then copy the client id</span>
      </div>
      <div className="settings-help-copy">you do not need the client secret.</div>
      <a
        className="settings-theme-btn settings-help-link"
        href="https://developer.spotify.com/dashboard"
        target="_blank"
        rel="noreferrer"
      >
        open dashboard
      </a>
    </div>
  );
}

function AppleSetupHelp() {
  return (
    <div className="settings-help">
      <div className="settings-help-copy">
        apple music needs a developer key so cupid player can create a musickit token.
      </div>
      <div className="settings-help-list">
        <span>1. open apple developer keys</span>
        <span>2. create a key with musickit enabled</span>
        <span>3. copy your team id and key id</span>
        <span>4. open the downloaded .p8 file and paste its contents</span>
      </div>
      <div className="settings-help-copy">
        this requires an apple developer account. the key stays on this computer.
      </div>
      <a
        className="settings-theme-btn settings-help-link"
        href={APPLE_KEYS_URL}
        target="_blank"
        rel="noreferrer"
      >
        open keys
      </a>
    </div>
  );
}

function TrackList({ tracks, activeIndex, playMode, onSelect }) {
  const activeRef = useRef(null);
  const nextIndex = playMode === 'normal' && tracks.length > 1
    ? (activeIndex + 1) % tracks.length
    : null;

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (tracks.length === 0) {
    return <div className="settings-track-empty">no tracks loaded</div>;
  }

  return (
    <div className="settings-track-list">
      {tracks.map((track, index) => {
        const trackState = index === activeIndex
          ? 'playing'
          : index === nextIndex
            ? 'next'
            : '';

        return (
          <button
            key={`${track.id ?? track.uri ?? track.file ?? track.title}-${index}`}
            ref={index === activeIndex ? activeRef : null}
            className={`settings-track-item ${index === activeIndex ? 'active' : ''}`}
            onClick={() => onSelect(index)}
          >
            <span className="settings-track-title">{track.title}</span>
            <span className="settings-track-meta">
              {track.artist && <small>{track.artist}</small>}
              {trackState && <small>{trackState}</small>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MarqueeText({ className, text }) {
  const outerRef = useRef(null);
  const textRef = useRef(null);
  const [shouldScroll, setShouldScroll] = useState(false);

  useEffect(() => {
    const outer = outerRef.current;
    const textEl = textRef.current;
    if (!outer || !textEl) return;
    setShouldScroll(textEl.offsetWidth > outer.clientWidth);
  }, [text]);

  return (
    <div className={`${className} marquee-container`} ref={outerRef}>
      {/* Hidden span to measure true text width */}
      <span ref={textRef} className="marquee-measure">{text}</span>
      <span className={shouldScroll ? 'marquee-scroll' : ''}>
        {text}
        {shouldScroll && <span className="marquee-gap">{text}</span>}
      </span>
    </div>
  );
}

export default function App() {
  // ── Source state ─────────────────────────────────────────
  const [resumeState] = useState(readResumeState);
  const [source, setSource] = useState(() => (
    resumeState?.source === 'streaming' && Array.isArray(resumeState.streamTracks) && resumeState.streamTracks.length > 0
      ? 'streaming'
      : 'local'
  )); // 'local' | 'streaming'
  const [spotifyConnected, setSpotifyConnected] = useState(isSpotifyLoggedIn());
  const [spotifyClientId, setSpotifyClientIdState] = useState(getSpotifyClientId);
  const [appleConnected, setAppleConnected] = useState(isAppleLoggedIn());
  const [appleConfigReady, setAppleConfigReady] = useState(false);
  const [appleConfigSource, setAppleConfigSource] = useState(null);
  const [appleTeamId, setAppleTeamId] = useState('');
  const [appleKeyId, setAppleKeyId] = useState('');
  const [applePrivateKey, setApplePrivateKey] = useState('');
  const [youtubeConnected, setYoutubeConnected] = useState(isYouTubeLoggedIn());
  const [youtubeLoggingIn, setYoutubeLoggingIn] = useState(false);
  const [youtubeUrlInput, setYoutubeUrlInput] = useState('');
  const [streamTracks, setStreamTracks] = useState(() => (
    Array.isArray(resumeState?.streamTracks) ? resumeState.streamTracks : []
  ));
  const [streamAutoplayKey, setStreamAutoplayKey] = useState(0);
  const [spotifyPlaylists, setSpotifyPlaylists] = useState([]);
  const [applePlaylists, setApplePlaylists] = useState([]);
  const [youtubePlaylists, setYoutubePlaylists] = useState([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [loadingPlaylist, setLoadingPlaylist] = useState(false);
  const [settingsError, setSettingsError] = useState(null);
  const [musicService, setMusicService] = useState(() => {
    try {
      if (resumeState?.musicService === 'spotify' || resumeState?.musicService === 'apple' || resumeState?.musicService === 'youtube' || resumeState?.musicService === 'local') {
        return resumeState.musicService;
      }
      const stored = localStorage.getItem('cupid-player-music-service');
      if (stored === 'spotify' || stored === 'apple' || stored === 'youtube' || stored === 'local') return stored;
    } catch {
      // ignore
    }
    return 'local';
  }); // 'spotify' | 'apple' | 'youtube' | 'local'
  const [playMode, setPlayMode] = useState('normal'); // 'normal' | 'shuffle' | 'repeat'
  const [sleepTimer, setSleepTimer] = useState('off');
  const [sleepEndsAt, setSleepEndsAt] = useState(null);
  const [sleepNow, setSleepNow] = useState(Date.now());
  const [showSleepCountdown, setShowSleepCountdown] = useState(true);
  const [nightMode, setNightMode] = useState(() => {
    try {
      return localStorage.getItem(NIGHT_MODE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [volumeHovered, setVolumeHovered] = useState(false);
  const [volumeDragging, setVolumeDragging] = useState(false);
  const volumeBarRef = useRef(null);
  const [showDebug] = useState(false);
  const [localTracks, setLocalTracks] = useState([]);

  const loadLocalPlaylist = useCallback(async () => {
    if (!window.cupid?.getLocalPlaylist) return;
    try {
      const tracks = await window.cupid.getLocalPlaylist();
      setLocalTracks(Array.isArray(tracks) ? tracks : []);
    } catch (err) {
      console.error('Failed to load local playlist:', err);
    }
  }, []);

  useEffect(() => { loadLocalPlaylist(); }, [loadLocalPlaylist]);

  const loadAppleConfig = useCallback(async () => {
    if (!window.cupid?.getAppleMusicConfig) return;

    const config = await window.cupid.getAppleMusicConfig();
    setAppleConfigReady(!!config?.configured);
    setAppleConfigSource(config?.source || null);
    setAppleTeamId(config?.teamId || '');
    setAppleKeyId(config?.keyId || '');
  }, []);

  useEffect(() => {
    loadAppleConfig().catch((err) => {
      console.warn('Failed to load Apple Music config:', err);
    });
  }, [loadAppleConfig]);

  const saveAppleConfig = useCallback(async () => {
    if (!window.cupid?.saveAppleMusicConfig) {
      throw new Error('Apple Music setup is unavailable in this build.');
    }

    const config = await window.cupid.saveAppleMusicConfig({
      teamId: appleTeamId,
      keyId: appleKeyId,
      privateKey: applePrivateKey,
    });

    setAppleConfigReady(!!config?.configured);
    setAppleConfigSource(config?.source || null);
    setAppleTeamId(config?.teamId || appleTeamId);
    setAppleKeyId(config?.keyId || appleKeyId);
    setApplePrivateKey('');
    return config;
  }, [appleKeyId, applePrivateKey, appleTeamId]);

  const resumeAutoplay = resumeState
    ? resumeState.wasPlaying !== false
    : false;

  const local = useAudioPlayer(localTracks, playMode, window.cupid?.getLocalAudioPath, {
    trackIndex: resumeState?.source === 'local' ? resumeState.trackIndex : 0,
    currentTime: resumeState?.source === 'local' ? resumeState.currentTime : 0,
    autoplay: resumeState?.source === 'local' && resumeAutoplay,
  });
  const streaming = useSpotifyPlayer(streamTracks, playMode, {
    trackIndex: resumeState?.source === 'streaming' ? resumeState.trackIndex : 0,
    currentTime: resumeState?.source === 'streaming' ? resumeState.currentTime : 0,
    autoplay: resumeState?.source === 'streaming' && resumeAutoplay,
    autoplayKey: streamAutoplayKey,
  });
  const player = source === 'streaming' ? streaming : local;

  const {
    track,
    isPlaying,
    progress,
    duration,
    currentTime,
    togglePlay,
    pause,
    next,
    prev,
    selectTrack,
    seek,
    volume,
    setVolume,
    muted,
    toggleMute,
    loading = false,
    playbackStatus,
    trackIndex,
  } = player;
  const queueTracks = source === 'streaming' ? streamTracks : localTracks;

  const cyclePlayMode = useCallback(() => {
    setPlayMode((m) => m === 'normal' ? 'shuffle' : m === 'shuffle' ? 'repeat' : 'normal');
  }, []);

  const updateSpotifyClientId = useCallback((value) => {
    setSpotifyClientIdState(value);
    setSpotifyClientId(value);
  }, []);

  const pauseRef = useRef(pause);
  useEffect(() => { pauseRef.current = pause; }, [pause]);

  useEffect(() => {
    if (sleepTimer === 'off') {
      setSleepEndsAt(null);
      return;
    }

    const endsAt = Date.now() + Number(sleepTimer) * 60 * 1000;
    setSleepEndsAt(endsAt);
    setSleepNow(Date.now());

    const timeout = setTimeout(() => {
      pauseRef.current();
      setSleepTimer('off');
    }, Number(sleepTimer) * 60 * 1000);

    return () => clearTimeout(timeout);
  }, [sleepTimer]);

  useEffect(() => {
    if (!sleepEndsAt || !showSleepCountdown) return;

    setSleepNow(Date.now());
    const interval = setInterval(() => setSleepNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [sleepEndsAt, showSleepCountdown]);

  const sleepRemaining = sleepEndsAt ? Math.max(0, sleepEndsAt - sleepNow) : 0;
  const spotifyReady = spotifyClientId.trim().length > 0 || isSpotifyConfigured();
  const appleReady = appleConfigReady || (
    appleTeamId.trim().length > 0 &&
    appleKeyId.trim().length > 0 &&
    applePrivateKey.trim().length > 0
  );

  useEffect(() => {
    try {
      localStorage.setItem(NIGHT_MODE_KEY, nightMode ? '1' : '0');
    } catch {
      // ignore
    }
  }, [nightMode]);

  useEffect(() => {
    if (source === 'local' && localTracks.length === 0) return;
    if (source === 'streaming' && streamTracks.length === 0) return;

    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify({
        source,
        musicService,
        trackIndex,
        currentTime,
        wasPlaying: isPlaying,
        streamTracks: source === 'streaming' ? streamTracks : [],
        savedAt: Date.now(),
      }));
    } catch {
      // ignore
    }
  }, [source, musicService, trackIndex, currentTime, isPlaying, streamTracks, localTracks.length]);

  // ── Fetch Spotify playlists ────────────────────────────
  const loadSpotifyPlaylists = useCallback((silent = false) => {
    setLoadingPlaylists(true);
    if (!silent) setSettingsError(null);
    fetchSpotifyPlaylists()
      .then((p) => { setSpotifyPlaylists(p); setSettingsError(null); })
      .catch((err) => { if (!silent) setSettingsError(err.message); })
      .finally(() => setLoadingPlaylists(false));
  }, []);

  // ── Fetch Apple Music playlists ────────────────────────
  const loadApplePlaylists = useCallback((silent = false) => {
    setLoadingPlaylists(true);
    if (!silent) setSettingsError(null);
    fetchApplePlaylists()
      .then((p) => { setApplePlaylists(p); setSettingsError(null); })
      .catch((err) => { if (!silent) setSettingsError(err.message); })
      .finally(() => setLoadingPlaylists(false));
  }, []);

  // ── Fetch YouTube playlists (Data API, requires sign-in) ─
  const loadYoutubePlaylists = useCallback((silent = false) => {
    setLoadingPlaylists(true);
    if (!silent) setSettingsError(null);
    fetchYouTubePlaylists()
      .then((p) => { setYoutubePlaylists(p); setSettingsError(null); })
      .catch((err) => { if (!silent) setSettingsError(err.message); })
      .finally(() => setLoadingPlaylists(false));
  }, []);

  // ── Load a playlist from a YouTube URL (no sign-in) ─────
  const loadYoutubePlaylistFromUrl = useCallback(async (rawInput) => {
    setSettingsError(null);
    const parsed = parseYouTubePlaylistUrl(rawInput);
    if (!parsed) {
      setSettingsError('Not a recognised YouTube playlist URL');
      return;
    }
    setLoadingPlaylist(true);
    try {
      const tracks = await fetchYouTubePlaylistByUrl(rawInput);
      if (tracks.length === 0) {
        setSettingsError('Playlist is empty or private');
        return;
      }
      setStreamTracks(tracks);
      setSource('streaming');
      setStreamAutoplayKey((key) => key + 1);
      setYoutubeUrlInput('');
    } catch (err) {
      setSettingsError(err.message);
    } finally {
      setLoadingPlaylist(false);
    }
  }, []);

  // ── Handle Spotify OAuth callback on mount ─────────────
  useEffect(() => {
    async function checkCallback() {
      const params = new URLSearchParams(window.location.search);
      if (params.has('code')) {
        try {
          await handleCallback();
          setSpotifyConnected(true);
          // Small delay to let token settle before fetching
          setTimeout(() => loadSpotifyPlaylists(true), 500);
        } catch (err) {
          setSettingsError(err.message);
        }
      } else {
        if (isSpotifyLoggedIn()) loadSpotifyPlaylists(true);
        if (isAppleLoggedIn()) loadApplePlaylists(true);
        if (isYouTubeLoggedIn()) loadYoutubePlaylists(true);
      }
    }
    checkCallback();
  }, []);

  // ── Load a playlist by ID (works for all services) ────
  const loadPlaylist = useCallback(async (id, service) => {
    setLoadingPlaylist(true);
    setSettingsError(null);
    try {
      const fetcher = service === 'apple'
        ? fetchAppleTracks
        : service === 'youtube'
          ? fetchYouTubeTracks
          : fetchSpotifyTracks;
      const tracks = await fetcher(id);
      if (tracks.length === 0) {
        setSettingsError('Playlist is empty');
        return;
      }
      setStreamTracks(tracks);
      setSource('streaming');
      setStreamAutoplayKey((key) => key + 1);
    } catch (err) {
      setSettingsError(err.message);
    } finally {
      setLoadingPlaylist(false);
    }
  }, []);

  const loadCurrentPlaylist = useCallback((id) => {
    if (musicService !== 'spotify' && musicService !== 'apple' && musicService !== 'youtube') return;
    loadPlaylist(id, musicService);
  }, [loadPlaylist, musicService]);

  const currentPlaylists = musicService === 'spotify'
    ? spotifyPlaylists
    : musicService === 'apple'
      ? applePlaylists
      : musicService === 'youtube'
        ? youtubePlaylists
        : [];

  const refreshCurrentPlaylists = musicService === 'spotify'
    ? loadSpotifyPlaylists
    : musicService === 'apple'
      ? loadApplePlaylists
      : musicService === 'youtube'
        ? loadYoutubePlaylists
        : null;

  const { theme, toggleTheme, assets } = useTheme();

  const [recordFrame, setRecordFrame] = useState(0);
  const [needleFrame, setNeedleFrame] = useState(0);
  const [isPink, setIsPink] = useState(theme === 'pink');
  const [swapping, setSwapping] = useState(false);
  const [needleLifted, setNeedleLifted] = useState(false);
  const [starHovered, setStarHovered] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showTrackView, setShowTrackView] = useState(false);
  const [showPlaylistView, setShowPlaylistView] = useState(false);
  const [showSpotifyHelp, setShowSpotifyHelp] = useState(false);
  const [showAppleHelp, setShowAppleHelp] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverProgress, setHoverProgress] = useState(null);
  const seekRef = useRef(null);

  const toggleSettings = useCallback(() => {
    if (showSettings) {
      setShowAbout(false);
      setShowSpotifyHelp(false);
      setShowAppleHelp(false);
    }
    setShowTrackView(false);
    setShowPlaylistView(false);
    setShowSettings((v) => !v);
  }, [showSettings]);

  const toggleTrackView = useCallback(() => {
    setShowAbout(false);
    setShowSettings(false);
    setShowPlaylistView(false);
    setShowSpotifyHelp(false);
    setShowAppleHelp(false);
    setShowTrackView((v) => !v);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMouseMove = (e) => {
      const rect = seekRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setHoverProgress(pct);
      seek(pct);
    };
    const onMouseUp = () => {
      setDragging(false);
      setStarHovered(false);
      setHoverProgress(null);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragging, seek]);

  useEffect(() => {
    if (!volumeDragging) return;
    const onMouseMove = (e) => {
      if (!volumeBarRef.current) return;
      const rect = volumeBarRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      setVolume(pct);
    };
    const onMouseUp = () => {
      setVolumeDragging(false);
      setVolumeHovered(false);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [volumeDragging, setVolume]);
  const [needleChangeFrame, setNeedleChangeFrame] = useState(0);
  // null sentinel = haven't seen any track yet; 'No track' = placeholder while
  // tracks load async. Both should silently set the ref without animating.
  const prevTrackRef = useRef(null);

  const currentFrames = isPink ? assets.recordFramesA : assets.recordFramesB;
  const incomingFrames = isPink ? assets.recordFramesB : assets.recordFramesA;

  // Spin animation while playing
  useEffect(() => {
    if (!isPlaying || swapping) return;
    const interval = setInterval(() => {
      setRecordFrame((f) => (f + 1) % currentFrames.length);
      setNeedleFrame((f) => (f + 1) % assets.needlePlayFrames.length);
    }, 400);
    return () => clearInterval(interval);
  }, [isPlaying, swapping, currentFrames.length]);

  // Detect song change and trigger swap
  // Sequence: needle lifts (0→1→2) → records swap → needle lowers (2→1→0)
  useEffect(() => {
    if (prevTrackRef.current === track.title) return;
    const wasInitialOrPlaceholder = prevTrackRef.current === null || prevTrackRef.current === 'No track';
    prevTrackRef.current = track.title;
    if (track.title === 'No track') return;
    if (wasInitialOrPlaceholder) return;
    if (needleLifted) return;

    setNeedleLifted(true);
    setNeedleChangeFrame(0);

    // Show needle lifted (frame 1 = index 1)
    setTimeout(() => setNeedleChangeFrame(1), 200);

    // Start record swap
    setTimeout(() => setSwapping(true), 400);

    // Finish swap, switch color
    setTimeout(() => {
      setIsPink((p) => !p);
      setRecordFrame(0);
      setSwapping(false);
    }, 1000);

    // Needle lower after swap is done, reset to frame 1
    setTimeout(() => {
      setNeedleChangeFrame(0);
      setNeedleLifted(false);
      setNeedleFrame(0);
    }, 1100);

  }, [track.title, needleLifted]);

  const resizeTL = useResize('top-left');
  const resizeTR = useResize('top-right');
  const resizeBL = useResize('bottom-left');
  const resizeBR = useResize('bottom-right');

  return (
    <div className={`player ${theme === 'blue' ? 'theme-blue' : ''} ${nightMode ? 'night-mode' : ''}`}>
      {/* Base frame */}
      <img src={assets.frame} className="layer" alt="" draggable={false} />

      {/* Window title */}
      <div className="window-title">cupid player</div>

      {/* Record player centered in frame */}
      <img src={assets.recordPlayer} className="record-player" alt="" draggable={false} />
      <img
        src={currentFrames[recordFrame]}
        className={`record-player ${swapping ? 'record-slide-out' : ''}`}
        alt=""
        draggable={false}
      />
      {swapping && (
        <img
          src={incomingFrames[0]}
          className="record-player record-slide-in"
          alt=""
          draggable={false}
        />
      )}
      <img
        src={needleLifted ? assets.needleChangeFrames[needleChangeFrame] : assets.needlePlayFrames[needleFrame]}
        className="record-player"
        alt=""
        draggable={false}
      />

      {/* Frame overlay (no background) to clip sliding records */}
      <img src={assets.frameNoBg} className="layer frame-overlay" alt="" draggable={false} />

      {/* Decorative */}
      <img src={assets.plant} className="layer layer-ui" alt="" draggable={false} />

      {/* Progress bar layers */}
      <img src={assets.progressBar} className="layer layer-ui" alt="" draggable={false} />
      <img
        src={progressBarStars}
        className="layer layer-ui"
        alt=""
        draggable={false}
        style={{
          clipPath: `inset(0 ${(1 - (131 + (hoverProgress ?? progress) * 226 + 10) / 512) * 100}% 0 0)`,
        }}
      />
      <img
        src={starHovered ? starSelected : star}
        className={`layer layer-ui star-indicator ${starHovered ? 'star-hovered' : ''}`}
        alt=""
        draggable={false}
        style={{
          transform: `translateX(calc(-3 / 306 * 100vw + ${(hoverProgress ?? progress) * (226 / 512) * 171.9}vw))`,
        }}
      />

      {/* Playback control layers (visual only) */}
      <img src={assets.backwardsButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={isPlaying ? assets.pauseButton : assets.playButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={assets.forwardsButton} className="layer layer-ui" alt="" draggable={false} />

      {/* Volume/mute button layer */}
      <img
        src={muted ? assets.muteButton : assets.volumeButton}
        className="layer layer-ui"
        alt=""
        draggable={false}
        style={{ opacity: 0.8 }}
      />

      {/* Shuffle/repeat button layer */}
      <img
        src={playMode === 'repeat' ? assets.repeatButton : assets.shuffleButton}
        className="layer layer-ui"
        alt=""
        draggable={false}
        style={{ opacity: playMode === 'normal' ? 0.4 : 0.8 }}
      />

      {/* Window control layers (visual only) */}
      <img src={assets.minimizerButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={assets.windowButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={assets.exitButton} className="layer layer-ui" alt="" draggable={false} />

      {/* Settings button layer */}
      <img src={assets.settings} className="layer layer-ui settings-layer" alt="" draggable={false} />
      <img src={assets.tracks} className="track-view-layer" alt="" draggable={false} />

      {/* SVG clip-path for pixel-art album mask */}
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <clipPath id="album-mask" clipPathUnits="objectBoundingBox">
            {/* 35x41 centered vertically */}
            <rect x="0.07317" y="0" width="0.85366" height="1" />
            {/* 37x39 */}
            <rect x="0.04878" y="0.02439" width="0.90244" height="0.95122" />
            {/* 39x37 */}
            <rect x="0.02439" y="0.04878" width="0.95122" height="0.90244" />
            {/* 41x35 */}
            <rect x="0" y="0.07317" width="1" height="0.85366" />
          </clipPath>
        </defs>
      </svg>

      {/* Album art clipped to pixel mask */}
      {track.art && (
        <div className="album-mask">
          <img src={track.art} className="album-art" alt="" draggable={false} />
        </div>
      )}

      {/* Album frame overlay */}
      <img src={assets.albumFrame} className="layer album-frame-layer" alt="" draggable={false} />

      {/* Now playing section */}
      <div className="now-playing">
        <div className="track-info">
          <div className="now-playing-label">
            {playbackStatus === 'failed' ? 'not found...' : loading ? 'loading...' : 'now playing...'}
          </div>
          <MarqueeText className="track-title" text={track.title} />
          <div className="track-artist">by {track.artist}</div>
        </div>
      </div>

      {/* Time display */}
      <div className="time-display">
        <span className="time-current">{loading ? '...' : formatTime(currentTime)}</span>
        <span className="time-remaining">{loading ? '...' : formatTime(duration - currentTime)}</span>
      </div>

      {/* Drag region for moving the window */}
      <div className="drag-region" />

      {/* Custom resize handles at frame corners */}
      <div className="resize-handle top-left" onMouseDown={resizeTL} />
      <div className="resize-handle top-right" onMouseDown={resizeTR} />
      <div className="resize-handle bottom-left" onMouseDown={resizeBL} />
      <div className="resize-handle bottom-right" onMouseDown={resizeBR} />

      {/* Progress bar seek target */}
      <div
        className="progress-seek"
        ref={seekRef}
        onMouseEnter={() => setStarHovered(true)}
        onMouseLeave={() => { if (!dragging) { setStarHovered(false); } }}
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          setHoverProgress(pct);
          seek(pct);
        }}
      />

      {/* Playback control click targets */}
      <div className="btn btn-prev" onClick={prev} />
      <div className="btn btn-play" onClick={togglePlay} />
      <div className="btn btn-next" onClick={next} />

      {/* Volume bar layers — shown on hover or drag */}
      {(volumeHovered || volumeDragging) && (
        <>
          <img src={assets.volumeBarLow} className="layer layer-ui volume-bar-layer" alt="" draggable={false} />
          <img
            src={assets.volumeBarHigh}
            className="layer layer-ui volume-bar-layer"
            alt=""
            draggable={false}
            style={{
              clipPath: `inset(${((1 - (muted ? 0 : volume)) * (420 - 338) / 512 + 338 / 512) * 100}% 0 0 0)`,
            }}
          />
        </>
      )}

      {/* Volume icon — hover to reveal bar */}
      <div
        className={`volume-hover-zone ${(volumeHovered || volumeDragging) ? 'expanded' : ''}`}
        onMouseLeave={() => { if (!volumeDragging) setVolumeHovered(false); }}
      >
        <div
          className="btn-volume-icon"
          onClick={toggleMute}
          onMouseEnter={() => setVolumeHovered(true)}
        />
        {(volumeHovered || volumeDragging) && (
          <div
            className="volume-bar-area"
            ref={volumeBarRef}
            onMouseDown={(e) => {
              e.preventDefault();
              setVolumeDragging(true);
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
              setVolume(pct);
            }}
          />
        )}
      </div>

      {/* Shuffle/repeat click target */}
      <div className="btn btn-playmode" onClick={cyclePlayMode} title={playMode} />

      {/* Window control click targets */}
      <div className="btn btn-minimize" onClick={() => window.cupid?.minimize()} />
      <div className="btn btn-window" onClick={() => window.cupid?.maximize()} />
      <div className="btn btn-exit" onClick={() => window.cupid?.close()} />

      {/* Settings button */}
      <div className="btn btn-settings" onClick={toggleSettings} />
      <div className="btn btn-track-view" onClick={toggleTrackView} />

      {/* Debug overlays — toggle with showDebug state */}
      {showDebug && (
        <>
          <div className="debug-overlay btn btn-prev" />
          <div className="debug-overlay btn btn-play" />
          <div className="debug-overlay btn btn-next" />
          <div className="debug-overlay volume-hover-zone" />
          <div className="debug-overlay volume-bar-area-debug" />
          <div className="debug-overlay btn btn-playmode" />
        </>
      )}

      {/* Settings panel */}
      {(showSettings || showTrackView || showPlaylistView || showSpotifyHelp || showAppleHelp) && (
        <div className="settings-panel">
          <div className={`settings-panel-inner ${(showTrackView || showPlaylistView || showSpotifyHelp || showAppleHelp) ? 'track-picker' : ''}`}>
            {showTrackView ? (
              <>
                <button
                  className="settings-theme-btn"
                  onClick={() => setShowTrackView(false)}
                >
                  back
                </button>
                <div className="settings-track-heading">
                  <span>tracks</span>
                  <small>{queueTracks.length}</small>
                </div>
                <TrackList
                  tracks={queueTracks}
                  activeIndex={trackIndex}
                  playMode={playMode}
                  onSelect={selectTrack}
                />
              </>
            ) : showPlaylistView ? (
              <>
                <button
                  className="settings-theme-btn"
                  onClick={() => setShowPlaylistView(false)}
                >
                  back
                </button>
                <div className="settings-panel-heading">
                  <span>playlists</span>
                  <small>{currentPlaylists.length}</small>
                </div>
                <PlaylistList
                  loading={loadingPlaylists}
                  playlists={currentPlaylists}
                  loadingPlaylist={loadingPlaylist}
                  onSelect={loadCurrentPlaylist}
                />
                {refreshCurrentPlaylists && (
                  <button
                    className={`settings-theme-btn ${loadingPlaylists ? 'disabled' : ''}`}
                    disabled={loadingPlaylists}
                    onClick={() => refreshCurrentPlaylists()}
                  >
                    refresh
                  </button>
                )}
              </>
            ) : showSpotifyHelp ? (
              <>
                <button
                  className="settings-theme-btn"
                  onClick={() => setShowSpotifyHelp(false)}
                >
                  back
                </button>
                <div className="settings-panel-heading">
                  <span>spotify setup</span>
                </div>
                <SpotifySetupHelp />
              </>
            ) : showAppleHelp ? (
              <>
                <button
                  className="settings-theme-btn"
                  onClick={() => setShowAppleHelp(false)}
                >
                  back
                </button>
                <div className="settings-panel-heading">
                  <span>apple setup</span>
                </div>
                <AppleSetupHelp />
              </>
            ) : showAbout ? (
              <>
                <button
                  className="settings-theme-btn"
                  onClick={() => setShowAbout(false)}
                >
                  back
                </button>
                <div className="settings-about">
                  <div className="settings-about-title">cupid player</div>
                  <div className="settings-about-copy">a tiny desktop music player</div>
                  <div className="settings-about-list">
                    <AboutLink
                      href="https://github.com/cupidbity/cupid-music-player"
                      label="original app"
                      detail="cupidity"
                    />
                    <AboutLink
                      href="https://github.com/KieranCR/cupid-music-player"
                      label="fork repo"
                      detail="KieranCR"
                    />
                    <AboutLink
                      href="https://kierancr.com"
                      label="site"
                      detail="kierancr.com"
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
            <div className="settings-label">theme</div>
            <div className="settings-theme-row">
              <button
                className={`settings-theme-btn ${theme === 'pink' ? 'active' : ''}`}
                onClick={() => { if (theme !== 'pink') toggleTheme(); }}
              >
                pink
              </button>
              <button
                className={`settings-theme-btn ${theme === 'blue' ? 'active' : ''}`}
                onClick={() => { if (theme !== 'blue') toggleTheme(); }}
              >
                blue
              </button>
            </div>
            <button
              className={`settings-theme-btn ${nightMode ? 'active' : ''}`}
              onClick={() => setNightMode((v) => !v)}
            >
              night {nightMode ? 'on' : 'off'}
            </button>
            <button
              className="settings-theme-btn"
              onClick={() => setShowAbout(true)}
            >
              about
            </button>
            <div className="settings-label">music</div>
            <SettingsDropdown
              value={musicService}
              options={[
                { value: 'local', label: 'local' },
                { value: 'spotify', label: 'spotify' },
                { value: 'apple', label: 'apple' },
                { value: 'youtube', label: 'youtube' },
              ]}
              onChange={(next) => {
                setMusicService(next);
                try { localStorage.setItem('cupid-player-music-service', next); } catch { /* ignore */ }
                if (next === 'local') setSource('local');
              }}
            />

            <div className="settings-label">sleep</div>
            <SettingsDropdown
              value={sleepTimer}
              options={SLEEP_TIMER_OPTIONS}
              onChange={setSleepTimer}
            />
            {sleepTimer !== 'off' && (
              <>
                <button
                  className={`settings-theme-btn ${showSleepCountdown ? 'active' : ''}`}
                  onClick={() => setShowSleepCountdown((v) => !v)}
                >
                  countdown {showSleepCountdown ? 'on' : 'off'}
                </button>
                {showSleepCountdown && (
                  <div className="settings-label">sleep in {formatCountdown(sleepRemaining)}</div>
                )}
              </>
            )}

            {musicService === 'local' && (
              <button
                className="settings-theme-btn"
                onClick={loadLocalPlaylist}
              >
                reload
              </button>
            )}

            {musicService === 'spotify' && (
              !spotifyConnected ? (
                <>
                  <input
                    className="settings-input"
                    type="text"
                    placeholder="spotify client id"
                    value={spotifyClientId}
                    onChange={(e) => updateSpotifyClientId(e.target.value)}
                  />
                  <div className="settings-theme-row">
                    <button
                      className={`settings-theme-btn ${!spotifyReady ? 'disabled' : ''}`}
                      disabled={!spotifyReady}
                      onClick={async () => {
                        setSettingsError(null);
                        try {
                          await spotifyLogin();
                        } catch (err) {
                          setSettingsError(err.message);
                        }
                      }}
                    >
                      log in
                    </button>
                    <button
                      className="settings-theme-btn"
                      onClick={() => setShowSpotifyHelp(true)}
                    >
                      setup help
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    className="settings-theme-btn"
                    onClick={() => setShowPlaylistView(true)}
                  >
                    playlists ({spotifyPlaylists.length})
                  </button>
                  <div className="settings-theme-row">
                    <button
                      className={`settings-theme-btn ${loadingPlaylists ? 'disabled' : ''}`}
                      disabled={loadingPlaylists}
                      onClick={() => loadSpotifyPlaylists()}
                    >
                      refresh
                    </button>
                    <button className="settings-theme-btn" onClick={() => {
                      spotifyLogout();
                      setSpotifyConnected(false);
                      setSpotifyPlaylists([]);
                      if (source === 'streaming') setSource('local');
                    }}>
                      logout
                    </button>
                  </div>
                </>
              )
            )}

            {musicService === 'apple' && (
              !appleConnected ? (
                <>
                  <input
                    className="settings-input"
                    type="text"
                    placeholder="apple team id"
                    value={appleTeamId}
                    onChange={(e) => setAppleTeamId(e.target.value)}
                  />
                  <input
                    className="settings-input"
                    type="text"
                    placeholder="apple key id"
                    value={appleKeyId}
                    onChange={(e) => setAppleKeyId(e.target.value)}
                  />
                  <textarea
                    className="settings-input settings-textarea"
                    placeholder={appleConfigReady ? 'private key saved' : 'paste .p8 key contents'}
                    value={applePrivateKey}
                    onChange={(e) => setApplePrivateKey(e.target.value)}
                  />
                  {appleConfigReady && (
                    <div className="settings-label">
                      apple setup saved{appleConfigSource === 'env' ? ' from env' : ''}
                    </div>
                  )}
                  <div className="settings-theme-row">
                    <button
                      className={`settings-theme-btn ${!appleReady ? 'disabled' : ''}`}
                      disabled={!appleReady}
                      onClick={async () => {
                        setSettingsError(null);
                        try {
                          if (!appleConfigReady || applePrivateKey.trim()) {
                            await saveAppleConfig();
                          }
                          await appleLogin();
                          setAppleConnected(true);
                          loadApplePlaylists();
                        } catch (err) {
                          setSettingsError(err.message);
                        }
                      }}
                    >
                      log in
                    </button>
                    <button
                      className="settings-theme-btn"
                      onClick={() => setShowAppleHelp(true)}
                    >
                      setup help
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    className="settings-theme-btn"
                    onClick={() => setShowPlaylistView(true)}
                  >
                    playlists ({applePlaylists.length})
                  </button>
                  <div className="settings-theme-row">
                    <button
                      className={`settings-theme-btn ${loadingPlaylists ? 'disabled' : ''}`}
                      disabled={loadingPlaylists}
                      onClick={() => loadApplePlaylists()}
                    >
                      refresh
                    </button>
                    <button className="settings-theme-btn" onClick={() => {
                      appleLogout();
                      setAppleConnected(false);
                      setApplePlaylists([]);
                      if (source === 'streaming') setSource('local');
                    }}>
                      logout
                    </button>
                  </div>
                </>
              )
            )}

            {musicService === 'youtube' && (
              isYouTubeConfigured() ? (
                !youtubeConnected ? (
                  <button
                    className={`settings-theme-btn ${youtubeLoggingIn ? 'disabled' : ''}`}
                    disabled={youtubeLoggingIn}
                    onClick={async () => {
                      setYoutubeLoggingIn(true);
                      setSettingsError(null);
                      try {
                        await youtubeLogin();
                        setYoutubeConnected(true);
                        loadYoutubePlaylists();
                      } catch (err) {
                        setSettingsError(err.message);
                      } finally {
                        setYoutubeLoggingIn(false);
                      }
                    }}
                  >
                    {youtubeLoggingIn ? 'waiting for browser...' : 'log in with google'}
                  </button>
                ) : (
                  <>
                    <button
                      className="settings-theme-btn"
                      onClick={() => setShowPlaylistView(true)}
                    >
                      playlists ({youtubePlaylists.length})
                    </button>
                    <div className="settings-theme-row">
                      <button
                        className={`settings-theme-btn ${loadingPlaylists ? 'disabled' : ''}`}
                        disabled={loadingPlaylists}
                        onClick={() => loadYoutubePlaylists()}
                      >
                        refresh
                      </button>
                      <button className="settings-theme-btn" onClick={() => {
                        youtubeLogout();
                        setYoutubeConnected(false);
                        setYoutubePlaylists([]);
                        if (source === 'streaming') setSource('local');
                      }}>
                        logout
                      </button>
                    </div>
                  </>
                )
              ) : (
                <>
                  <input
                    className="settings-input"
                    type="text"
                    placeholder="paste a youtube playlist link"
                    value={youtubeUrlInput}
                    onChange={(e) => setYoutubeUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && youtubeUrlInput.trim()) {
                        loadYoutubePlaylistFromUrl(youtubeUrlInput.trim());
                      }
                    }}
                    disabled={loadingPlaylist}
                  />
                  <button
                    className={`settings-theme-btn ${loadingPlaylist || !youtubeUrlInput.trim() ? 'disabled' : ''}`}
                    onClick={() => loadYoutubePlaylistFromUrl(youtubeUrlInput.trim())}
                    disabled={loadingPlaylist || !youtubeUrlInput.trim()}
                  >
                    {loadingPlaylist ? 'loading...' : 'load playlist'}
                  </button>
                </>
              )
            )}

            {settingsError && <div className="settings-error">{settingsError}</div>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
