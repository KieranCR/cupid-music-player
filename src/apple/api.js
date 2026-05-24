/**
 * Apple Music API helpers.
 *
 * Fetches user playlists and track data via MusicKit JS.
 */

import { getMusicKit, initMusicKit } from './auth.js';

async function fetchAll(mk, path, params = {}) {
  const items = [];
  let response = await mk.api.music(path, params);

  while (response) {
    items.push(...(response.data.data || []));

    const next = response.data.next;
    response = next ? await mk.api.music(next) : null;
  }

  return items;
}

function playlistFromItem(p) {
  return {
    id: p.id,
    name: p.attributes.name,
    image: p.attributes.artwork
      ? window.MusicKit.formatArtworkURL(p.attributes.artwork, 300, 300)
      : null,
    trackCount: p.attributes.trackCount || 0,
  };
}

function trackFromItem(t) {
  if (!t.attributes) return null;

  return {
    title: t.attributes.name,
    artist: t.attributes.artistName,
    art: t.attributes.artwork
      ? window.MusicKit.formatArtworkURL(t.attributes.artwork, 300, 300)
      : null,
    uri: `apple:track:${t.id}`,
  };
}

/**
 * Fetch the user's Apple Music library playlists.
 *
 * @returns {Promise<Array<{ id: string, name: string, image: string|null, trackCount: number }>>}
 */
export async function fetchMyPlaylists() {
  const mk = getMusicKit() || await initMusicKit();
  const playlists = await fetchAll(mk, '/v1/me/library/playlists', { limit: 100 });

  return playlists.map(playlistFromItem);
}

/**
 * Fetch tracks from an Apple Music library playlist.
 *
 * @param {string} playlistId
 * @returns {Promise<Array<{ title: string, artist: string, art: string|null, uri: string }>>}
 */
export async function fetchPlaylistTracks(playlistId) {
  const mk = getMusicKit() || await initMusicKit();
  const tracks = await fetchAll(mk, `/v1/me/library/playlists/${playlistId}/tracks`, { limit: 100 });

  return tracks
    .map(trackFromItem)
    .filter(Boolean);
}
