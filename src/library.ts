import type {
  ProviderAlbumV1,
  ProviderArtistV1,
  ProviderLibraryRecordV1,
  ProviderLibrarySyncPageV1,
  ProviderPlaylistV1,
  ProviderTrackV1,
} from 'puros-provider-sdk'
import { LIBRARY_BROWSE_IDS, LIKED_MUSIC_PLAYLIST_ID } from './constants'
import type { InnerTubeClient } from './innertube'
import { albumUrl, artistUrl } from './ids'
import { parseContinuationItems, parseLibraryPage, parsePlaylistPage, tracksOf, type Continuation, type ParsedItem, type SkippedItem, describeLayout } from './parsers'

/** Upper bounds that stop a runaway pagination loop; hitting one fails the sync instead of truncating it. */
const MAX_PAGES_PER_LIST = 400
const MAX_PLAYLISTS = 1_000

export interface LibrarySnapshot {
  songs: ProviderTrackV1[]
  albums: ProviderAlbumV1[]
  artists: ProviderArtistV1[]
  playlists: Array<{ playlist: ProviderPlaylistV1; tracks: ProviderTrackV1[] }>
}

type Progress = (processed: number, label: string) => Promise<void>
/** Per-list summary for diagnosis: counts and renderer names only, never titles, IDs or tokens. */
export interface LibraryListReport {
  list: string
  pages: number
  parsed: Record<string, number>
  skipped: SkippedItem[]
  /** Renderer layout of the first page. */
  layout: string[]
}
export type LibraryReporter = (report: LibraryListReport) => Promise<void>

type LibraryPage = { items: ParsedItem[]; continuation: Continuation | null; skipped: SkippedItem[] }

async function libraryList(client: InnerTubeClient, browseId: string, report: LibraryReporter | undefined, signal?: AbortSignal): Promise<ParsedItem[]> {
  const firstResponse = await client.request({ endpoint: 'browse', body: { browseId }, auth: 'required', signal })
  const items: ParsedItem[] = []
  const skipped: SkippedItem[] = []
  const seen = new Set<string>()
  let page: LibraryPage = parseLibraryPage(firstResponse)
  let pages = 1
  while (true) {
    items.push(...page.items)
    skipped.push(...page.skipped)
    if (!page.continuation) break
    if (seen.has(page.continuation.token)) throw new Error('YouTube Music library pagination did not advance')
    if (pages >= MAX_PAGES_PER_LIST) throw new Error('YouTube Music library list exceeds the page limit')
    seen.add(page.continuation.token)
    page = parseLibraryPage(await client.request({ endpoint: 'browse', auth: 'required', continuation: page.continuation, signal }))
    pages += 1
    // A continuation that yields nothing means the response was not understood; a partial list must not pass as complete.
    if (page.items.length === 0 && page.skipped.length === 0 && !page.continuation) {
      throw new Error(`YouTube Music returned an unreadable ${browseId} continuation page`)
    }
  }
  const parsed: Record<string, number> = {}
  for (const item of items) parsed[item.type] = (parsed[item.type] ?? 0) + 1
  await report?.({ list: browseId, pages, parsed, skipped, layout: describeLayout(firstResponse) })
  return items
}

/** Every track of one playlist, following continuations until YouTube reports none. */
export async function playlistWithAllTracks(client: InnerTubeClient, playlistId: string, signal?: AbortSignal) {
  const first = parsePlaylistPage(await client.request({ endpoint: 'browse', body: { browseId: `VL${playlistId}` }, auth: 'required', signal }), playlistId)
  const tracks = [...first.tracks]
  const seen = new Set<string>()
  let continuation = first.continuation
  for (let count = 1; continuation; count += 1) {
    if (seen.has(continuation.token)) throw new Error('YouTube Music playlist pagination did not advance')
    if (count >= MAX_PAGES_PER_LIST) throw new Error('YouTube Music playlist exceeds the page limit')
    seen.add(continuation.token)
    const page = parseContinuationItems(await client.request({ endpoint: 'browse', auth: 'required', continuation, signal }))
    tracks.push(...tracksOf(page.items))
    continuation = page.continuation
  }
  return { playlist: first.playlist, tracks }
}

interface ItemValues { track: ProviderTrackV1; album: ProviderAlbumV1; artist: ProviderArtistV1; playlist: ProviderPlaylistV1 }

function only<T extends keyof ItemValues>(items: ParsedItem[], type: T): Array<ItemValues[T]> {
  return items.filter((item) => item.type === type).map((item) => item.value as ItemValues[T])
}
/**
 * Fetch the whole account library. Any failed page aborts the snapshot, so a
 * partial library is never presented to core as complete.
 */
export async function fetchLibrarySnapshot(client: InnerTubeClient, progress: Progress, signal?: AbortSignal, report?: LibraryReporter): Promise<LibrarySnapshot> {
  const songs = only(await libraryList(client, LIBRARY_BROWSE_IDS.songs, report, signal), 'track')
  await progress(songs.length, 'Fetching YouTube Music songs')
  const albums = only(await libraryList(client, LIBRARY_BROWSE_IDS.albums, report, signal), 'album')
  const artists = only(await libraryList(client, LIBRARY_BROWSE_IDS.artists, report, signal), 'artist')
  const listed = only(await libraryList(client, LIBRARY_BROWSE_IDS.playlists, report, signal), 'playlist')
  const ids = [...new Set([LIKED_MUSIC_PLAYLIST_ID, ...listed.map((playlist) => playlist.sourceId)])]
  if (ids.length > MAX_PLAYLISTS) throw new Error('YouTube Music library has more playlists than Puros syncs')
  const playlists: LibrarySnapshot['playlists'] = []
  for (const [index, id] of ids.entries()) {
    const full = await playlistWithAllTracks(client, id, signal)
    const listedEntry = listed.find((playlist) => playlist.sourceId === id)
    playlists.push({ playlist: { ...full.playlist, artworkUrl: full.playlist.artworkUrl ?? listedEntry?.artworkUrl ?? null }, tracks: full.tracks })
    await progress(songs.length + albums.length + artists.length + index + 1, 'Fetching YouTube Music playlists')
  }
  return { songs, albums, artists, playlists }
}

/** Flatten a snapshot into v1 records: entities first, then playlists and ordered memberships. */
export function snapshotRecords(snapshot: LibrarySnapshot): ProviderLibraryRecordV1[] {
  const artists = new Map<string, ProviderArtistV1>()
  const albums = new Map<string, ProviderAlbumV1>()
  const tracks = new Map<string, ProviderTrackV1>()
  const librarySongs = new Set(snapshot.songs.map((track) => track.sourceId))

  const addCreditedArtists = (credits: ProviderTrackV1['artists']) => {
    for (const credit of credits ?? []) {
      if (!credit.artistSourceId || artists.has(credit.artistSourceId)) continue
      artists.set(credit.artistSourceId, {
        sourceId: credit.artistSourceId, name: credit.artistName, genres: [], providerUrl: artistUrl(credit.artistSourceId), inLibrary: false,
      })
    }
  }
  for (const artist of snapshot.artists) artists.set(artist.sourceId, { ...artist, inLibrary: true })
  for (const album of snapshot.albums) {
    albums.set(album.sourceId, { ...album, inLibrary: true })
    addCreditedArtists(album.artists)
  }
  const addTrack = (track: ProviderTrackV1) => {
    const existing = tracks.get(track.sourceId)
    tracks.set(track.sourceId, { ...(existing ?? track), inLibrary: librarySongs.has(track.sourceId) })
    addCreditedArtists(track.artists)
    if (track.albumSourceId && track.albumTitle && !albums.has(track.albumSourceId)) {
      // Only what the track row states about its album; nothing is filled in.
      albums.set(track.albumSourceId, {
        sourceId: track.albumSourceId,
        title: track.albumTitle,
        artworkUrl: track.artworkUrl ?? null,
        artists: [],
        genres: [],
        providerUrl: albumUrl(track.albumSourceId),
        inLibrary: false,
      })
    }
  }
  for (const track of snapshot.songs) addTrack(track)
  for (const { tracks: members } of snapshot.playlists) for (const track of members) addTrack(track)

  const records: ProviderLibraryRecordV1[] = [
    ...[...artists.values()].map((value) => ({ type: 'artist' as const, value })),
    ...[...albums.values()].map((value) => ({ type: 'album' as const, value })),
    ...[...tracks.values()].map((value) => ({ type: 'track' as const, value })),
  ]
  for (const { playlist, tracks: members } of snapshot.playlists) {
    records.push({ type: 'playlist', value: { ...playlist, trackCount: playlist.trackCount ?? members.length } })
    members.forEach((track, position) => {
      records.push({ type: 'playlistTrack', value: { playlistSourceId: playlist.sourceId, trackSourceId: track.sourceId, position } })
    })
  }
  return records
}

export function pageRecords(records: ProviderLibraryRecordV1[], offset: number, limit: number | undefined, syncedAt: number): ProviderLibrarySyncPageV1 {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > records.length) throw new TypeError('Invalid library cursor')
  const size = Number.isInteger(limit) && limit! > 0 ? Math.min(500, limit!) : 100
  const end = Math.min(records.length, offset + size)
  const complete = end === records.length
  return {
    records: records.slice(offset, end),
    nextCursor: complete ? null : String(end),
    complete,
    ...(complete ? { checkpoint: syncedAt } : {}),
  }
}
