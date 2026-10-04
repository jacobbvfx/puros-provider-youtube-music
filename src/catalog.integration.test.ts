import { describe, expect, it } from 'vitest'
import { YtmCatalog } from './catalog'
import { InnerTubeClient } from './innertube'

/**
 * Opt-in (PUROS_YTM_NETWORK_TEST=1): the live, signed-out music.youtube.com
 * catalog through the provider's own client and parsers. Account pages are not
 * reachable without a Google session and are not exercised here.
 */
describe.runIf(process.env.PUROS_YTM_NETWORK_TEST === '1')('live catalog (network, signed out)', () => {
  const catalog = new YtmCatalog(new InnerTubeClient({ getCredentials: () => null }), () => false)

  it('searches every shelf and follows a page cursor', { timeout: 60_000 }, async () => {
    const first = await catalog.search({ query: 'daft punk' })
    expect(first.tracks.length).toBeGreaterThan(5)
    expect(first.albums.length).toBeGreaterThan(3)
    expect(first.artists.some((artist) => artist.sourceId === 'UCRr1xG_2WIDs18a6cIiCxeA')).toBe(true)
    expect(first.playlists.length).toBeGreaterThan(0)
    const second = await catalog.search({ query: 'daft punk', cursor: first.nextCursor })
    expect(second.tracks.length).toBeGreaterThan(0)
  })

  it('loads album, artist (with full discography), track and playlist pages', { timeout: 60_000 }, async () => {
    const album = await catalog.getAlbumBundle('MPREb_K8qWMWVqXGi')
    expect(album.tracks.length).toBe(13)
    const artist = await catalog.getArtistBundle('UCRr1xG_2WIDs18a6cIiCxeA')
    expect(artist.releases.length).toBeGreaterThan(10)
    expect(artist.topTracks.length).toBeGreaterThan(0)
    expect(await catalog.getTrack('ZFZM6jDTWd4')).toMatchObject({ sourceId: 'ZFZM6jDTWd4', albumSourceId: 'MPREb_K8qWMWVqXGi' })
    const page = await catalog.getPlaylistTracks('PLwNv9Hhd8gZjNoQdpd2kBa3fwXNeJjzDX')
    expect(page.items.length).toBeGreaterThan(50)
    const more = await catalog.getPlaylistTracks('PLwNv9Hhd8gZjNoQdpd2kBa3fwXNeJjzDX', page.nextCursor)
    expect(more.items.length).toBeGreaterThan(0)
    expect(more.items[0].sourceId).not.toBe(page.items[0].sourceId)
  })

  it('loads home shelves and their continuation', { timeout: 60_000 }, async () => {
    const home = await catalog.getShelves()
    expect(home.items.length).toBeGreaterThan(0)
    if (home.nextCursor) expect((await catalog.getShelves(home.nextCursor)).items.length).toBeGreaterThan(0)
    const playlist = home.items.flatMap((shelf) => shelf.items).find((item) => 'collectionRef' in item && item.collectionRef)
    if (playlist && 'collectionRef' in playlist && playlist.collectionRef) {
      expect((await catalog.getCollection({ type: 'playlist', sourceId: playlist.collectionRef.sourceId })).tracks.length).toBeGreaterThan(0)
    }
  })
})
