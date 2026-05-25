import { useState, useRef, useEffect, useCallback } from 'react';
import { takeShuffleIndex } from './shuffleBag.js';

/**
 * Local audio player hook (HTML5 Audio).
 *
 * Tracks come from the user's editable playlist (audio/playlist.json),
 * loaded in App via window.cupid.getLocalPlaylist(). Files are resolved
 * to file:// URLs through getAudioPath so spaces/Unicode work correctly.
 */
export default function useAudioPlayer(tracks, playMode = 'normal', getAudioPath, initialState = {}) {
  const audioRef = useRef(new Audio());
  const playModeRef = useRef(playMode);
  playModeRef.current = playMode;
  const shuffleBagRef = useRef([]);
  const restoreTimeRef = useRef(initialState.currentTime || 0);
  const [trackIndex, setTrackIndex] = useState(initialState.trackIndex || 0);

  // Reset index when the playlist array changes (mirrors useSpotifyPlayer)
  const prevTracksRef = useRef(tracks);
  if (prevTracksRef.current !== tracks) {
    prevTracksRef.current = tracks;
    shuffleBagRef.current = [];
    if (trackIndex >= tracks.length) setTrackIndex(0);
  }

  const [isPlaying, setIsPlaying] = useState(!!initialState.autoplay);
  const isPlayingRef = useRef(false);
  isPlayingRef.current = isPlaying;
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolumeState] = useState(() => {
    const saved = localStorage.getItem('cupid-volume');
    return saved !== null ? parseFloat(saved) : 1;
  });
  const [muted, setMuted] = useState(false);

  const track = tracks[trackIndex] ?? { title: 'No track', artist: '', file: '', art: null };
  const audio = audioRef.current;
  audio.volume = muted ? 0 : volume;

  // Load track when index or tracks change
  useEffect(() => {
    const t = tracks[trackIndex];
    if (!t || !t.file) return;

    let cancelled = false;
    let restoreMetadata = null;
    (async () => {
      let src;
      if (getAudioPath) {
        src = await getAudioPath(t.file);
      } else {
        // Browser/preview fallback — Vite serves audio/ as publicDir
        src = `./${t.file}`;
      }
      if (cancelled || !src) return;
      audio.src = src;
      audio.load();
      setProgress(0);
      setCurrentTime(0);
      setDuration(0);
      const restoreTime = restoreTimeRef.current;
      restoreTimeRef.current = 0;
      if (restoreTime > 0) {
        const restore = () => {
          if (cancelled) return;
          if (audio.duration) {
            audio.currentTime = Math.min(restoreTime, Math.max(0, audio.duration - 1));
          }
        };
        if (audio.readyState >= 1) restore();
        else {
          restoreMetadata = restore;
          audio.addEventListener('loadedmetadata', restoreMetadata, { once: true });
        }
      }
      if (isPlayingRef.current) {
        audio.play().catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      if (restoreMetadata) audio.removeEventListener('loadedmetadata', restoreMetadata);
    };
  }, [trackIndex, tracks]);

  // Time update listener
  useEffect(() => {
    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      if (audio.duration) {
        setProgress(audio.currentTime / audio.duration);
      }
    };

    const onLoadedMetadata = () => {
      setDuration(audio.duration);
    };

    const onEnded = () => {
      if (playModeRef.current === 'repeat') {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        return;
      }
      setTrackIndex((prev) => {
        if (tracks.length === 0) return 0;
        if (playModeRef.current === 'shuffle') {
          const next = takeShuffleIndex(shuffleBagRef.current, tracks.length, prev);
          shuffleBagRef.current = next.bag;
          return next.index;
        }
        return (prev + 1) % tracks.length;
      });
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, [tracks]);

  const play = useCallback(() => {
    audio.play().catch(() => {});
    setIsPlaying(true);
  }, []);

  const pause = useCallback(() => {
    audio.pause();
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  const next = useCallback(() => {
    setTrackIndex((prev) => {
      if (tracks.length === 0) return 0;
      if (playModeRef.current === 'shuffle' && tracks.length > 1) {
        const next = takeShuffleIndex(shuffleBagRef.current, tracks.length, prev);
        shuffleBagRef.current = next.bag;
        return next.index;
      }
      return (prev + 1) % tracks.length;
    });
  }, [tracks]);

  const prev = useCallback(() => {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
    } else {
      setTrackIndex((p) => {
        if (tracks.length === 0) return 0;
        return (p - 1 + tracks.length) % tracks.length;
      });
    }
  }, [tracks]);

  const selectTrack = useCallback((index) => {
    if (index < 0 || index >= tracks.length) return;
    shuffleBagRef.current = [];
    audio.pause();
    setProgress(0);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(true);
    setTrackIndex((current) => {
      if (current === index) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      }
      return index;
    });
  }, [tracks.length]);

  const seek = useCallback((fraction) => {
    if (audio.duration) {
      audio.currentTime = Math.min(fraction, 1) * audio.duration;
    }
  }, []);

  const setVolume = useCallback((v) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    audio.volume = clamped;
    localStorage.setItem('cupid-volume', clamped);
    if (clamped > 0) setMuted(false);
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      audio.volume = m ? volume : 0;
      return !m;
    });
  }, [volume]);

  return {
    track,
    trackIndex,
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
  };
}
