import { describe, expect, it } from 'vitest'
import album from './fixtures/album.json'
import artist from './fixtures/artist.json'
import home from './fixtures/home.json'
import homeContinuation from './fixtures/home-continuation.json'
import next from './fixtures/next.json'
import playlist from './fixtures/playlist.json'
import playlistContinuation from './fixtures/playlist-continuation.json'
import playlistPaged from './fixtures/playlist-paged.json'
import searchAlbums from './fixtures/search-albums.json'
import searchArtists from './fixtures/search-artists.json'
import searchPlaylists from './fixtures/search-playlists.json'
import searchSongs from './fixtures/search-songs.json'
import searchSongsContinuation from './fixtures/search-songs-continuation.json'
import {
  artworkUrl,
  creditsFrom,
  parseAccountName,
  parseAlbumPage,
  parseArtistPage,
  parseDurationMs,
  parseHome,
  parseLibraryPage,
  parseNextTrack,
  parsePlaylistPage,
  parseContinuationItems,
  parseSearchShelf,
  readRuns,
  responseLoggedIn,
  tracksOf,
} from './parsers'

describe('InnerTube primitives', () => {
  it('parses durations and artist credits with join phrases', () => {
    expect(parseDurationMs('9:05')).toBe(545_000)
    expect(parseDurationMs('1:02:03')).toBe(3_723_000)
    expect(parseDurationMs('95M plays')).toBeNull()
    const runs = readRuns({ runs: [
      { text: 'Daft Punk', navigationEndpoint: { browseEndpoint: { browseId: 'UCRr1xG_2WIDs18a6cIiCxeA' } } },
      { text: ', ' },
      { text: 'Pharrell Williams', navigationEndpoint: { browseEndpoint: { browseId: 'UCUsZJ7Zp7WsDzVLYnkiIUGg' } } },
      { text: ' & ' },
      { text: 'Unlinked Name' },
    ] })
    expect(creditsFrom(runs)).toEqual([
      { artistSourceId: 'UCRr1xG_2WIDs18a6cIiCxeA', artistName: 'Daft Punk', role: 'primary', joinPhrase: ', ', position: 0 },
      { artistSourceId: 'UCUsZJ7Zp7WsDzVLYnkiIUGg', artistName: 'Pharrell Williams', role: 'main', joinPhrase: ' & ', position: 1 },
      { artistSourceId: null, artistName: 'Unlinked Name', role: 'main', joinPhrase: null, position: 2 },
    ])
  })

  it('requests a square 544 px Google image rendition and leaves other hosts alone', () => {
    expect(artworkUrl('https://yt3.googleusercontent.com/abc=w60-h60-l90-rj')).toBe('https://yt3.googleusercontent.com/abc=w544-h544-l90-rj')
    expect(artworkUrl('https://lh3.googleusercontent.com/abc=w540-h225-p-l90-rj')).toBe('https://lh3.googleusercontent.com/abc=w544-h544-p-l90-rj')
    expect(artworkUrl('https://yt3.googleusercontent.com/abc=s192')).toBe('https://yt3.googleusercontent.com/abc=s544')
    expect(artworkUrl('https://i.ytimg.com/vi/x/hq720.jpg?sqp=1')).toBe('https://i.ytimg.com/vi/x/hq720.jpg?sqp=1')
    expect(artworkUrl('http://insecure.example/a.jpg')).toBeNull()
  })
})

describe('search shelves', () => {
  it('maps song rows with stable video, artist and album IDs', () => {
    const { items, continuation } = parseSearchShelf(searchSongs)
    expect(continuation).toMatchObject({ style: 'legacy' })
    expect(continuation!.token.length).toBeGreaterThan(20)
    const first = items[0]
    expect(first.type).toBe('track')
    expect(first.value).toMatchObject({
      sourceId: 'ZFZM6jDTWd4',
      title: 'Giorgio by Moroder',
      durationMs: 545_000,
      albumSourceId: 'MPREb_K8qWMWVqXGi',
      albumTitle: 'Random Access Memories',
      primaryArtistSourceId: 'UCRr1xG_2WIDs18a6cIiCxeA',
      primaryArtistName: 'Daft Punk',
      isrc: null,
      trackNumber: null,
      discNumber: null,
      providerUrl: 'https://music.youtube.com/watch?v=ZFZM6jDTWd4',
    })
  })

  it('follows a search continuation page', () => {
    const { items, continuation } = parseSearchShelf(searchSongsContinuation)
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.type === 'track')).toBe(true)
    expect(continuation).not.toBeNull()
  })

  it('maps albums, artists and playlists', () => {
    const albums = parseSearchShelf(searchAlbums).items
    expect(albums[0]).toMatchObject({ type: 'album', value: {
      sourceId: 'MPREb_K8qWMWVqXGi', title: 'Random Access Memories', releaseType: 'album', year: 2013,
      primaryArtistSourceId: 'UCRr1xG_2WIDs18a6cIiCxeA', upc: null,
    } })
    const artists = parseSearchShelf(searchArtists).items
    expect(artists[0]).toMatchObject({ type: 'artist', value: { sourceId: 'UCRr1xG_2WIDs18a6cIiCxeA', name: 'Daft Punk' } })
    const playlists = parseSearchShelf(searchPlaylists).items
    expect(playlists[0]).toMatchObject({ type: 'playlist', value: {
      sourceId: 'RDCLAK5uy_kf6c8Ga41e1bLKYCaulkiZ1NIVYJnr3Jk', title: 'Best Of French Touch', trackCount: 63,
      collectionRef: { type: 'playlist', sourceId: 'RDCLAK5uy_kf6c8Ga41e1bLKYCaulkiZ1NIVYJnr3Jk' },
    } })
  })
})

describe('entity pages', () => {
  it('maps an album page with YouTube track indexes and no invented metadata', () => {
    const page = parseAlbumPage(album, 'MPREb_K8qWMWVqXGi')
    expect(page.audioPlaylistId).toBe('OLAK5uy_kNhM2yaBTOVwrcZJepB1C9P3-n5_Sfy5c')
    expect(page.album).toMatchObject({
      sourceId: 'MPREb_K8qWMWVqXGi', title: 'Random Access Memories', year: 2013, releaseType: 'album',
      primaryArtistSourceId: 'UCRr1xG_2WIDs18a6cIiCxeA', totalTracks: 13, totalDiscs: null, upc: null,
    })
    expect(page.tracks).toHaveLength(13)
    expect(page.tracks[0]).toMatchObject({ sourceId: 'IluRBvnYMoY', trackNumber: 1, discNumber: null, durationMs: 276_000, albumSourceId: 'MPREb_K8qWMWVqXGi', isrc: null })
    const getLucky = page.tracks.find((track) => track.title.startsWith('Get Lucky'))!
    expect(getLucky.trackNumber).toBe(8)
    expect(getLucky.artists?.map((credit) => credit.artistName)).toEqual(['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'])
  })

  it('maps an artist page into top tracks, releases, playlists and related artists', () => {
    const page = parseArtistPage(artist, 'UCRr1xG_2WIDs18a6cIiCxeA')
    expect(page.artist).toMatchObject({ sourceId: 'UCRr1xG_2WIDs18a6cIiCxeA', name: 'Daft Punk' })
    expect(page.artist.bio).toMatch(/French electronic music duo/)
    expect(page.topTracks.length).toBeGreaterThan(0)
    expect(page.releases.length).toBeGreaterThan(0)
    expect(page.releases.some((release) => release.releaseType === 'single')).toBe(true)
    expect(page.playlists.length).toBeGreaterThan(0)
    expect(page.relatedArtists.every((related) => related.sourceId !== 'UCRr1xG_2WIDs18a6cIiCxeA')).toBe(true)
    expect(page.moreReleases.length).toBeGreaterThan(0)
  })

  it('maps a playlist page and both continuation styles', () => {
    const page = parsePlaylistPage(playlist, 'RDCLAK5uy_kf6c8Ga41e1bLKYCaulkiZ1NIVYJnr3Jk')
    expect(page.playlist).toMatchObject({ title: 'Best Of French Touch', trackCount: 63 })
    expect(page.tracks.length).toBeGreaterThan(0)
    expect(page.continuation).toBeNull()

    const paged = parsePlaylistPage(playlistPaged, 'PLwNv9Hhd8gZjNoQdpd2kBa3fwXNeJjzDX')
    expect(paged.playlist.trackCount).toBe(500)
    expect(paged.continuation).toMatchObject({ style: 'command' })
    const next = parseContinuationItems(playlistContinuation)
    expect(tracksOf(next.items).length).toBeGreaterThan(0)
    expect(next.continuation).toMatchObject({ style: 'command' })
  })

  it('reads the exact requested track from a next response', () => {
    expect(parseNextTrack(next, 'ZFZM6jDTWd4')).toMatchObject({
      sourceId: 'ZFZM6jDTWd4', title: 'Giorgio by Moroder', durationMs: 545_000, albumSourceId: 'MPREb_K8qWMWVqXGi',
    })
    expect(parseNextTrack(next, 'aaaaaaaaaaa')).toBeNull()
  })
})

describe('home', () => {
  it('maps shelves and a legacy continuation', () => {
    const first = parseHome(home)
    expect(first.shelves.length).toBeGreaterThan(0)
    expect(first.shelves[0].items[0].type).toBe('playlist')
    expect(first.continuation).toMatchObject({ style: 'legacy' })
    const more = parseHome(homeContinuation)
    expect(more.shelves.length).toBeGreaterThan(0)
  })
})

describe('library and account pages', () => {
  // Library responses need a signed-in session; these fixtures reproduce the
  // renderer layout (grid/list, both continuation styles) without account data.
  const twoRowPlaylist = (id: string, title: string) => ({ musicTwoRowItemRenderer: {
    title: { runs: [{ text: title }] },
    subtitle: { runs: [{ text: 'Playlist' }, { text: ' • ' }, { text: '12 songs' }] },
    navigationEndpoint: { browseEndpoint: { browseId: `VL${id}`, browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_PLAYLIST' } } } },
  } })

  it('reads a playlist grid, skipping the "New playlist" tile, with a legacy continuation', () => {
    const page = parseLibraryPage({ contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
      { gridRenderer: {
        items: [
          { musicTwoRowItemRenderer: { title: { runs: [{ text: 'New playlist' }] }, navigationEndpoint: { createPlaylistEndpoint: {} } } },
          twoRowPlaylist('LM', 'Liked Music'),
          twoRowPlaylist('PLabcdefghijklmnop', 'Road trip'),
        ],
        continuations: [{ nextContinuationData: { continuation: 'grid-next' } }],
      } },
    ] } } } }] } } })
    expect(page.items.map((item) => item.value.sourceId)).toEqual(['LM', 'PLabcdefghijklmnop'])
    expect(page.items[1]).toMatchObject({ type: 'playlist', value: { trackCount: 12 } })
    expect(page.continuation).toEqual({ token: 'grid-next', style: 'legacy' })
  })

  it('recognizes the account’s own playlist tiles, which carry no pageType, and reports what it cannot map', () => {
    const ownTile = (id: string, title: string) => ({ musicTwoRowItemRenderer: {
      title: { runs: [{ text: title }] },
      subtitle: { runs: [{ text: 'Jacobb' }, { text: ' • ' }, { text: '42 tracks' }] },
      navigationEndpoint: { browseEndpoint: { browseId: `VL${id}` } },
    } })
    const page = parseLibraryPage({ contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
      { gridRenderer: { items: [
        twoRowPlaylist('LM', 'Liked Music'),
        ownTile('PLownplaylist00001', 'Mine'),
        { musicTwoRowItemRenderer: { title: { runs: [{ text: 'Album' }] }, navigationEndpoint: { browseEndpoint: { browseId: 'MPREb_K8qWMWVqXGi' } } } },
        { musicTwoRowItemRenderer: { title: { runs: [{ text: 'Artist' }] }, navigationEndpoint: { browseEndpoint: { browseId: 'UCRr1xG_2WIDs18a6cIiCxeA' } } } },
        { musicTwoRowItemRenderer: { title: { runs: [{ text: 'Unknown' }] }, navigationEndpoint: { browseEndpoint: { browseId: 'FEmusic_something' } } } },
        { musicTwoRowItemRenderer: { title: { runs: [{ text: 'New playlist' }] }, navigationEndpoint: { createPlaylistEndpoint: {} } } },
      ] } },
    ] } } } }] } } })
    expect(page.items.map((item) => [item.type, item.value.sourceId])).toEqual([
      ['playlist', 'LM'],
      ['playlist', 'PLownplaylist00001'],
      ['album', 'MPREb_K8qWMWVqXGi'],
      ['artist', 'UCRr1xG_2WIDs18a6cIiCxeA'],
    ])
    expect(page.items[1]).toMatchObject({ value: { title: 'Mine', trackCount: 42 } })
    expect(page.skipped).toEqual([{ renderer: 'musicTwoRowItemRenderer', pageType: null, idPrefix: 'FEmusic_' }])
  })

  it('reads grid continuations of both styles', () => {
    expect(parseLibraryPage({ continuationContents: { gridContinuation: { items: [twoRowPlaylist('PLzzzzzzzzzzzzzzzz', 'X')] } } }))
      .toMatchObject({ items: [{ value: { sourceId: 'PLzzzzzzzzzzzzzzzz' } }], continuation: null })
    expect(parseLibraryPage({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
      twoRowPlaylist('PLyyyyyyyyyyyyyyyy', 'Y'),
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'cmd-next' } } } },
    ] } }] })).toMatchObject({ items: [{ value: { sourceId: 'PLyyyyyyyyyyyyyyyy' } }], continuation: { token: 'cmd-next', style: 'command' } })
  })

  it('reads the signed-in account name and the logged-in flag', () => {
    expect(parseAccountName({ actions: [{ openPopupAction: { popup: { multiPageMenuRenderer: { header: { activeAccountHeaderRenderer: {
      accountName: { runs: [{ text: 'Test Listener' }] }, channelHandle: { runs: [{ text: '@listener' }] },
    } } } } } }] })).toEqual({ name: 'Test Listener', handle: '@listener' })
    expect(parseAccountName({ actions: [{ openPopupAction: { popup: { multiPageMenuRenderer: { sections: [] } } } }] })).toBeNull()
    expect(responseLoggedIn({ responseContext: { serviceTrackingParams: [{ service: 'GFEEDBACK', params: [{ key: 'logged_in', value: '0' }] }] } })).toBe(false)
    expect(responseLoggedIn({ responseContext: { serviceTrackingParams: [{ service: 'GFEEDBACK', params: [{ key: 'logged_in', value: '1' }] }] } })).toBe(true)
    expect(responseLoggedIn({})).toBeNull()
  })
})
