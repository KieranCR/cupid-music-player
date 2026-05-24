import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth.js', () => ({
  getAccessToken: vi.fn(() => Promise.resolve('spotify-token')),
}));

const { fetchPlaylistTracks } = await import('./api.js');

function response(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

describe('fetchPlaylistTracks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('follows Spotify track pages', async () => {
    const nextUrl = 'https://api.spotify.com/v1/playlists/abc/tracks?offset=100';
    const firstPage = {
      tracks: {
        items: [
          {
            track: {
              name: 'First',
              uri: 'spotify:track:first',
              artists: [{ name: 'Artist One' }],
              album: { images: [{ url: 'first.jpg' }] },
            },
          },
        ],
        next: nextUrl,
      },
    };
    const secondPage = {
      items: [
        {
          track: {
            name: 'Second',
            uri: 'spotify:track:second',
            artists: [{ name: 'Artist Two' }],
            album: { images: [{ url: 'second.jpg' }] },
          },
        },
      ],
      next: null,
    };

    const fetchMock = vi.fn()
      .mockImplementationOnce(() => response(firstPage))
      .mockImplementationOnce(() => response(secondPage));
    vi.stubGlobal('fetch', fetchMock);

    const tracks = await fetchPlaylistTracks('abc');

    expect(tracks).toEqual([
      { title: 'First', artist: 'Artist One', art: 'first.jpg', uri: 'spotify:track:first' },
      { title: 'Second', artist: 'Artist Two', art: 'second.jpg', uri: 'spotify:track:second' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(nextUrl);
  });
});
