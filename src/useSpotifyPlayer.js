/**
 * React hook for Spotify playback via YouTube audio streams.
 *
 * Spotify API supplies metadata/playlists; audio is fetched from YouTube
 * in the main process (cupid-audio:// protocol) and played via HTML5 Audio.
 *
 * Same interface as useAudioPlayer.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { takeShuffleIndex } from './shuffleBag.js';

export default function useSpotifyPlayer(tracks, playMode = 'normal') {
  const audioRef = useRef(new Audio());
  const playModeRef = useRef(playMode);
  playModeRef.current = playMode;
  // Shared between prefetch, next(), and onEnded so we play what we warmed
  const nextIdxRef = useRef(null);
  const nextPickRef = useRef(null);
  const shuffleBagRef = useRef([]);
  const [trackIndex, setTrackIndex] = useState(0);

  // Reset to track 0 on playlist change, otherwise the stale index can be
  // out of bounds for the new playlist
  const prevTracksRef = useRef(tracks);
  if (prevTracksRef.current !== tracks) {
    prevTracksRef.current = tracks;
    nextIdxRef.current = null;
    nextPickRef.current = null;
    shuffleBagRef.current = [];
    setTrackIndex(0);
  }
  const [isPlaying, setIsPlaying] = useState(false);
  const wantsPlayRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [loading, setLoading] = useState(false);
  const [volume, setVolumeState] = useState(() => {
    const saved = localStorage.getItem('cupid-volume');
    return saved !== null ? parseFloat(saved) : 1;
  });
  const [muted, setMuted] = useState(false);

  const audio = audioRef.current;
  audio.volume = muted ? 0 : volume;
  audio.preload = 'auto';

  const track = tracks[trackIndex] ?? {
    title: 'No track',
    artist: '',
    art: null,
    uri: null,
  };

  // ── Load track when index or tracks change ────────────────
  useEffect(() => {
    if (tracks.length === 0) return;
    const t = tracks[trackIndex];
    if (!t) return;

    let cancelled = false;
    setLoading(true);

    async function loadStream() {
      try {
        const url = t.videoId
          ? await window.cupid.getStreamUrlById(t.videoId)
          : await window.cupid.getStreamUrl(t.title, t.artist);
        if (cancelled) return;
        // setting src triggers loading; an explicit audio.load() would reset it
        audio.src = url;
        if (wantsPlayRef.current) {
          audio.play().catch(() => {});
        }
      } catch (err) {
        console.error('Failed to get stream:', err.message);
        if (!cancelled) {
          wantsPlayRef.current = false;
          setIsPlaying(false);
          setLoading(false);
        }
      } finally {
        if (!cancelled && !wantsPlayRef.current) setLoading(false);
      }
    }

    loadStream();

    return () => { cancelled = true; };
  }, [trackIndex, tracks]);

  // ── Precompute next index + prefetch surrounding tracks ───
  useEffect(() => {
    if (tracks.length === 0) {
      nextIdxRef.current = null;
      nextPickRef.current = null;
      return;
    }

    const prefetched = new Set([trackIndex]);
    const prefetch = (idx) => {
      if (idx < 0 || idx >= tracks.length || prefetched.has(idx)) return;
      const t = tracks[idx];
      if (!t) return;
      prefetched.add(idx);
      if (t.videoId) {
        window.cupid.getStreamUrlById(t.videoId).catch(() => {});
      } else {
        window.cupid.getStreamUrl(t.title, t.artist).catch(() => {});
      }
    };

    let nextIdx;
    if (playMode === 'shuffle' && tracks.length > 1) {
      const pick = takeShuffleIndex(shuffleBagRef.current, tracks.length, trackIndex);
      nextPickRef.current = pick;
      nextIdx = pick.index;
    } else {
      nextPickRef.current = null;
      nextIdx = (trackIndex + 1) % tracks.length;
    }
    nextIdxRef.current = nextIdx;

    prefetch(nextIdx);

    // Shuffle's second hop is unpredictable, so only look ahead in linear mode
    if (playMode !== 'shuffle') {
      prefetch((trackIndex + 2) % tracks.length);
      prefetch((trackIndex - 1 + tracks.length) % tracks.length);
    }
  }, [trackIndex, tracks, playMode]);

  // ── Audio event listeners ─────────────────────────────────
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

    const onPlaying = () => {
      setLoading(false);
      setIsPlaying(true);
    };

    const onWaiting = () => {
      if (wantsPlayRef.current) setLoading(true);
    };

    const onEnded = () => {
      setIsPlaying(false);
      if (playModeRef.current === 'repeat') {
        audio.currentTime = 0;
        wantsPlayRef.current = true;
        audio.play().catch(() => {});
        return;
      }
      setTrackIndex((prev) => {
        if (nextIdxRef.current !== null && nextIdxRef.current !== prev) {
          const next = nextIdxRef.current;
          if (nextPickRef.current?.index === next) {
            shuffleBagRef.current = nextPickRef.current.bag;
          }
          nextIdxRef.current = null;
          nextPickRef.current = null;
          return next;
        }
        if (playModeRef.current === 'shuffle' && tracks.length > 1) {
          const next = takeShuffleIndex(shuffleBagRef.current, tracks.length, prev);
          shuffleBagRef.current = next.bag;
          return next.index;
        }
        return (prev + 1) % tracks.length;
      });
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('ended', onEnded);
    };
  }, [tracks.length]);

  // ── Playback controls ────────────────────────────────────

  const pause = useCallback(() => {
    wantsPlayRef.current = false;
    audio.pause();
    setLoading(false);
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlaying || loading) {
      pause();
    } else {
      wantsPlayRef.current = true;
      if (!audio.src || audio.readyState < 3) setLoading(true);
      audio.play().catch(() => {});
    }
  }, [isPlaying, loading, pause]);

  const next = useCallback(() => {
    setTrackIndex((prev) => {
      // Prefer the precomputed next (matches what prefetch warmed)
      if (nextIdxRef.current !== null && nextIdxRef.current !== prev) {
        const next = nextIdxRef.current;
        if (nextPickRef.current?.index === next) {
          shuffleBagRef.current = nextPickRef.current.bag;
        }
        nextIdxRef.current = null;
        nextPickRef.current = null;
        return next;
      }
      if (playModeRef.current === 'shuffle' && tracks.length > 1) {
        const next = takeShuffleIndex(shuffleBagRef.current, tracks.length, prev);
        shuffleBagRef.current = next.bag;
        return next.index;
      }
      return (prev + 1) % tracks.length;
    });
    wantsPlayRef.current = true;
    setLoading(true);
    setIsPlaying(false);
  }, [tracks.length]);

  const prev = useCallback(() => {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
    } else {
      setTrackIndex((prev) => (prev - 1 + tracks.length) % tracks.length);
    }
    wantsPlayRef.current = true;
    setLoading(true);
    setIsPlaying(false);
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
    seek,
    volume,
    setVolume,
    muted,
    toggleMute,
    loading,
  };
}
