import { describe, expect, it, vi } from 'vitest'
import type { InnerTubeClient, InnerTubeRequest } from './innertube'
import { fetchLibrarySnapshot, pageRecords, snapshotRecords } from './library'

// Signed-in library responses reproduced as renderer shapes; no account data.
const artistRun = (id: string, name: string) => ({ text: name, navigationEndpoint: { browseEndpoint: { browseId: id, browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' } } } } })
const albumRun = (id: string, title: string) => ({ text: title, navigationEndpoint: { browseEndpoint: { browseId: id, browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' } } } } })

function songRow(videoId: string, title: string) {
  return { musicResponsiveListItemRenderer: {
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title, navigationEndpoint: { watchEndpoint: { videoId } } }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [artistRun('UCRr1xG_2WIDs18a6cIiCxeA', 'Daft Punk')] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [albumRun('MPREb_K8qWMWVqXGi', 'Random Access Memories')] } } },
    ],
    fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: '4:36' }] } } }],
    playlistItemData: { videoId },
  } }
}

const shelfPage = (items: unknown[], continuation?: string) => ({ contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
  { musicShelfRenderer: { contents: items, ...(continuation ? { continuations: [{ nextContinuationData: { continuation } }] } : {}) } },
] } } } }] } } })

const gridPage = (items: unknown[]) => ({ contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
  { gridRenderer: { items } },
] } } } }] } } })

const playlistTile = (id: string, title: string) => ({ musicTwoRowItemRenderer: {
  title: { runs: [{ text: title }] },
  subtitle: { runs: [{ text: 'Playlist' }] },
  navigationEndpoint: { browseEndpoint: { browseId: `VL${id}`, browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_PLAYLIST' } } } },
} })

const playlistPage = (title: string, tracks: unknown[], token?: string) => ({ contents: { twoColumnBrowseResultsRenderer: {
  tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicResponsiveHeaderRenderer: { title: { runs: [{ text: title }] } } }] } } } }],
  secondaryContents: { sectionListRenderer: { contents: [{ musicPlaylistShelfRenderer: { contents: [
    ...tracks,
    ...(token ? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } }] : []),
  ] } }] } },
} } })

function fakeClient(routes: Record<string, unknown | Error>) {
  const request = vi.fn(async (input: InnerTubeRequest) => {
    const key = input.continuation ? `cont:${input.continuation.token}` : String(input.body?.browseId)
    const value = routes[key]
    if (value === undefined) throw new Error(`unexpected request ${key}`)
    if (value instanceof Error) throw value
    return value
  })
  return { request } as unknown as InnerTubeClient & { request: typeof request }
}

const libraryRoutes = () => ({
  FEmusic_liked_videos: shelfPage([songRow('aaaaaaaaaaa', 'One')], 'songs-2'),
  'cont:songs-2': { continuationContents: { musicShelfContinuation: { contents: [songRow('bbbbbbbbbbb', 'Two')] } } },
  FEmusic_liked_albums: gridPage([]),
  FEmusic_library_corpus_track_artists: shelfPage([]),
  FEmusic_liked_playlists: gridPage([playlistTile('LM', 'Liked Music'), playlistTile('PLroadtrip0001', 'Road trip')]),
  VLLM: playlistPage('Liked Music', [songRow('aaaaaaaaaaa', 'One')]),
  VLPLroadtrip0001: playlistPage('Road trip', [songRow('ccccccccccc', 'Three')], 'pl-2'),
  'cont:pl-2': { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [songRow('aaaaaaaaaaa', 'One'), songRow('ccccccccccc', 'Three')] } }] },
})

describe('library sync', () => {
  it('follows every continuation and keeps playlist order, repeats and IDs', async () => {
    const client = fakeClient(libraryRoutes())
    const snapshot = await fetchLibrarySnapshot(client, async () => {})
    expect(snapshot.songs.map((track) => track.sourceId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb'])
    expect(snapshot.playlists.map((entry) => entry.playlist.sourceId)).toEqual(['LM', 'PLroadtrip0001'])
    expect(snapshot.playlists[1].tracks.map((track) => track.sourceId)).toEqual(['ccccccccccc', 'aaaaaaaaaaa', 'ccccccccccc'])

    const records = snapshotRecords(snapshot)
    const tracks = records.filter((record) => record.type === 'track').map((record) => record.value as { sourceId: string; inLibrary: boolean })
    expect(tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'aaaaaaaaaaa', inLibrary: true }),
      expect.objectContaining({ sourceId: 'ccccccccccc', inLibrary: false }),
    ]))
    const memberships = records.filter((record) => record.type === 'playlistTrack' && record.value.playlistSourceId === 'PLroadtrip0001')
    expect(memberships.map((record) => record.value)).toEqual([
      { playlistSourceId: 'PLroadtrip0001', trackSourceId: 'ccccccccccc', position: 0 },
      { playlistSourceId: 'PLroadtrip0001', trackSourceId: 'aaaaaaaaaaa', position: 1 },
      { playlistSourceId: 'PLroadtrip0001', trackSourceId: 'ccccccccccc', position: 2 },
    ])
    // The album a track row names is recorded with only what the row states.
    const albumValue = records.find((record) => record.type === 'album')?.value
    expect(albumValue).toMatchObject({ sourceId: 'MPREb_K8qWMWVqXGi', title: 'Random Access Memories', inLibrary: false })
    expect(albumValue).not.toHaveProperty('year')
    expect(albumValue).not.toHaveProperty('upc')
  })

  it('fails the whole snapshot when any page fails, so a partial library is never complete', async () => {
    const routes = { ...libraryRoutes(), 'cont:pl-2': new Error('network down') }
    await expect(fetchLibrarySnapshot(fakeClient(routes), async () => {})).rejects.toThrow('network down')
    const looping = { ...libraryRoutes(), 'cont:songs-2': shelfPage([songRow('bbbbbbbbbbb', 'Two')], 'songs-2') }
    await expect(fetchLibrarySnapshot(fakeClient(looping), async () => {})).rejects.toThrow(/did not advance/)
    // An empty or unfamiliar continuation must not end the list as if it were complete.
    const empty = { ...libraryRoutes(), 'cont:songs-2': { contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: {} }] } } } }
    await expect(fetchLibrarySnapshot(fakeClient(empty), async () => {})).rejects.toThrow(/unreadable/)
  })

  it('finds items in an unfamiliar container and reports the layout without any text', async () => {
    const reports: unknown[] = []
    const routes = {
      ...libraryRoutes(),
      FEmusic_liked_playlists: { contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
        { someNewShelfRenderer: { body: { items: [playlistTile('LM', 'Liked Music'), playlistTile('PLroadtrip0001', 'Road trip')] } } },
      ] } } } }] } } },
    }
    const snapshot = await fetchLibrarySnapshot(fakeClient(routes), async () => {}, undefined, async (report) => { reports.push(report) })
    expect(snapshot.playlists.map((entry) => entry.playlist.sourceId)).toEqual(['LM', 'PLroadtrip0001'])
    const playlistsReport = reports.find((report) => (report as { list: string }).list === 'FEmusic_liked_playlists')
    expect(playlistsReport).toMatchObject({ pages: 1, parsed: { playlist: 2 }, skipped: [] })
    expect(JSON.stringify(playlistsReport)).not.toMatch(/Road trip|PLroadtrip|Liked Music/)
    expect((playlistsReport as { layout: string[] }).layout.join('\n')).toContain('someNewShelfRenderer > musicTwoRowItemRenderer')
  })

  it('pages records with a monotonic cursor and marks only the last page complete', () => {
    const records = Array.from({ length: 5 }, (_, index) => ({ type: 'artist' as const, value: { sourceId: `UC${String(index).padStart(22, '0')}`, name: `A${index}` } }))
    const first = pageRecords(records, 0, 2, 42)
    expect(first).toMatchObject({ nextCursor: '2', complete: false })
    expect(first.checkpoint).toBeUndefined()
    expect(pageRecords(records, 4, 2, 42)).toMatchObject({ nextCursor: null, complete: true, checkpoint: 42 })
    expect(() => pageRecords(records, 9, 2, 42)).toThrow(/cursor/)
  })
})
