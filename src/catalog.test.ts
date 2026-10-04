import { describe, expect, it, vi } from 'vitest'
import album from './fixtures/album.json'
import next from './fixtures/next.json'
import searchAlbums from './fixtures/search-albums.json'
import searchArtists from './fixtures/search-artists.json'
import searchPlaylists from './fixtures/search-playlists.json'
import searchSongs from './fixtures/search-songs.json'
import searchSongsContinuation from './fixtures/search-songs-continuation.json'
import { SEARCH_FILTER_PARAMS } from './constants'
import { YtmCatalog } from './catalog'
import type { InnerTubeClient, InnerTubeRequest } from './innertube'

function catalogWith(handler: (request: InnerTubeRequest) => unknown, signedIn = false) {
  const request = vi.fn(async (input: InnerTubeRequest) => handler(input))
  return { catalog: new YtmCatalog({ request } as unknown as InnerTubeClient, () => signedIn), request }
}

const byParams: Record<string, unknown> = {
  [SEARCH_FILTER_PARAMS.songs]: searchSongs,
  [SEARCH_FILTER_PARAMS.albums]: searchAlbums,
  [SEARCH_FILTER_PARAMS.artists]: searchArtists,
  [SEARCH_FILTER_PARAMS.featuredPlaylists]: searchPlaylists,
  [SEARCH_FILTER_PARAMS.communityPlaylists]: searchPlaylists,
}

describe('catalog search', () => {
  it('searches each entity shelf and pages only shelves that have more', async () => {
    const { catalog, request } = catalogWith((input) => input.continuation ? searchSongsContinuation : byParams[String(input.body?.params)])
    const first = await catalog.search({ query: 'daft punk' })
    expect(request).toHaveBeenCalledTimes(5)
    expect(first.tracks[0].sourceId).toBe('ZFZM6jDTWd4')
    expect(first.albums[0].sourceId).toBe('MPREb_K8qWMWVqXGi')
    expect(first.artists[0].sourceId).toBe('UCRr1xG_2WIDs18a6cIiCxeA')
    // Featured and community shelves overlap here; each playlist appears once.
    expect(new Set(first.playlists.map((playlist) => playlist.sourceId)).size).toBe(first.playlists.length)
    expect(first.nextCursor).toBeTruthy()

    request.mockClear()
    const second = await catalog.search({ query: 'daft punk', cursor: first.nextCursor })
    // Songs and albums have more pages here; artists and playlists do not and are not requested again.
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every(([input]) => input.continuation?.style === 'legacy' && !input.body)).toBe(true)
    expect(second.tracks.length).toBeGreaterThan(0)
    expect(second.artists).toEqual([])
  })

  it('limits shelves to the requested types and rejects forged cursors', async () => {
    const { catalog, request } = catalogWith((input) => byParams[String(input.body?.params)])
    await catalog.search({ query: 'x', types: ['album'] })
    expect(request).toHaveBeenCalledOnce()
    await expect(catalog.search({ query: 'x', cursor: 'not-a-cursor' })).rejects.toMatchObject({ providerError: { code: 'INVALID_ARGUMENT' } })
  })

  it('signs requests only when a session exists', async () => {
    const signedOut = catalogWith(() => searchSongs)
    await signedOut.catalog.search({ query: 'x', types: ['track'] })
    expect(signedOut.request.mock.calls[0][0].auth).toBe('none')
    const signedIn = catalogWith(() => searchSongs, true)
    await signedIn.catalog.search({ query: 'x', types: ['track'] })
    expect(signedIn.request.mock.calls[0][0].auth).toBe('optional')
  })
})

describe('catalog entities', () => {
  it('loads albums and tracks by their own IDs only', async () => {
    const { catalog } = catalogWith((input) => input.endpoint === 'next' ? next : album)
    expect((await catalog.getAlbumBundle('MPREb_K8qWMWVqXGi')).tracks).toHaveLength(13)
    expect(await catalog.getTrack('ZFZM6jDTWd4')).toMatchObject({ sourceId: 'ZFZM6jDTWd4' })
    // `next` answers with a queue; a different first item is not a substitute.
    await expect(catalog.getTrack('aaaaaaaaaaa')).rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
    await expect(catalog.getAlbum('../x')).rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
    await expect(catalog.getArtist('not-a-channel')).rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
  })
})
