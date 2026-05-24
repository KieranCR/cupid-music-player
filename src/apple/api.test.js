import { afterEach, describe, expect, it, vi } from 'vitest';

const music = vi.fn();

vi.mock('./auth.js', () => ({
  getMusicKit: vi.fn(() => ({
    api: { music },
  })),
  initMusicKit: vi.fn(),
}));

const { fetchMyPlaylists, fetchPlaylistTracks } = await import('./api.js');

function page(data, next = null) {
  return Promise.resolve({
    data: { data, next },
  });
}

describe('Apple Music API helpers', () => {
  afterEach(() => {
    music.mockReset();
    vi.unstubAllGlobals();
  });

  it('follows playlist pages', async () => {
    vi.stubGlobal('window', {
      MusicKit: {
        formatArtworkURL: () => 'cover.jpg',
      },
    });

    music
      .mockImplementationOnce(() => page([
        {
          id: 'one',
          attributes: {
            name: 'First playlist',
            artwork: { url: 'one' },
            trackCount: 12,
          },
        },
      ], '/v1/me/library/playlists?offset=100'))
      .mockImplementationOnce(() => page([
        {
          id: 'two',
          attributes: {
            name: 'Second playlist',
            artwork: null,
            trackCount: 8,
          },
        },
      ]));

    const playlists = await fetchMyPlaylists();

    expect(playlists).toEqual([
      { id: 'one', name: 'First playlist', image: 'cover.jpg', trackCount: 12 },
      { id: 'two', name: 'Second playlist', image: null, trackCount: 8 },
    ]);
    expect(music).toHaveBeenNthCalledWith(2, '/v1/me/library/playlists?offset=100');
  });

  it('follows playlist track pages', async () => {
    vi.stubGlobal('window', {
      MusicKit: {
        formatArtworkURL: () => 'track.jpg',
      },
    });

    music
      .mockImplementationOnce(() => page([
        {
          id: 'song-one',
          attributes: {
            name: 'First song',
            artistName: 'Artist One',
            artwork: { url: 'one' },
          },
        },
      ], '/v1/me/library/playlists/pl.tracks/tracks?offset=100'))
      .mockImplementationOnce(() => page([
        {
          id: 'song-two',
          attributes: {
            name: 'Second song',
            artistName: 'Artist Two',
            artwork: null,
          },
        },
      ]));

    const tracks = await fetchPlaylistTracks('pl.tracks');

    expect(tracks).toEqual([
      { title: 'First song', artist: 'Artist One', art: 'track.jpg', uri: 'apple:track:song-one' },
      { title: 'Second song', artist: 'Artist Two', art: null, uri: 'apple:track:song-two' },
    ]);
    expect(music).toHaveBeenNthCalledWith(2, '/v1/me/library/playlists/pl.tracks/tracks?offset=100');
  });
});
