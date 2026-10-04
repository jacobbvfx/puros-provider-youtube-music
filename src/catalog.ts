import {
  ProviderApiError,
  providerError,
  type ProviderAlbumBundleV1,
  type ProviderAlbumV1,
  type ProviderArtistBundleV1,
  type ProviderArtistV1,
  type ProviderEntityTypeV1,
  type ProviderHomeCollectionV1,
  type ProviderHomeShelfKindV1,
  type ProviderHomeShelfV1,
  type ProviderPageV1,
  type ProviderPlaylistV1,
  type ProviderSearchRequestV1,
  type ProviderSearchResultsV1,
  type ProviderTrackV1,
} from 'puros-provider-sdk'
import { LIBRARY_BROWSE_IDS, SEARCH_FILTER_PARAMS, type SearchShelf } from './constants'
import { requireAlbumId, requireArtistId, requirePlaylistId, requireVideoId } from './ids'
import type { AuthMode, InnerTubeClient } from './innertube'
import {
  parseAlbumPage,
  parseArtistPage,
  parseContinuationItems,
  parseHome,
  parseLibraryPage,
  parseNextTrack,
  parsePlaylistPage,
  parseReleaseGrid,
  parseSearchShelf,
  parseWatchPlaylist,
  tracksOf,
  type Continuation,
  type ParsedItem,
} from './parsers'

const MAX_QUERY_LENGTH = 200
const MORE_RELEASE_PAGES = 3
const COLLECTION_TRACK_LIMIT = 500

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeCursor<T>(cursor: string | null | undefined, check: (value: unknown) => value is T): T | null {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (check(value)) return value
  } catch { /* fall through */ }
  throw new ProviderApiError(providerError('INVALID_ARGUMENT', 'Invalid YouTube Music page cursor', { retryable: false }))
}

function isContinuation(value: unknown): value is Continuation {
  const record = value as Partial<Continuation> | null
  return !!record && typeof record.token === 'string' && record.token.length > 0 && record.token.length < 4096
    && (record.style === 'command' || record.style === 'legacy')
}

type SearchCursor = Partial<Record<SearchShelf, Continuation>>

function isSearchCursor(value: unknown): value is SearchCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([key, entry]) => key in SEARCH_FILTER_PARAMS && isContinuation(entry))
}

function shelvesFor(types: ProviderEntityTypeV1[] | undefined): SearchShelf[] {
  const wanted = new Set(types && types.length > 0 ? types : ['track', 'album', 'artist', 'playlist'])
  return [
    ...(wanted.has('track') ? ['songs' as const] : []),
    ...(wanted.has('album') ? ['albums' as const] : []),
    ...(wanted.has('artist') ? ['artists' as const] : []),
    ...(wanted.has('playlist') ? ['featuredPlaylists' as const, 'communityPlaylists' as const] : []),
  ]
}

function shelfKind(items: ParsedItem[]): ProviderHomeShelfKindV1 {
  const types = new Set(items.map((item) => item.type))
  if (types.size !== 1) return 'mixed'
  const [only] = types
  return only === 'track' ? 'tracks' : only === 'album' ? 'albums' : only === 'artist' ? 'artists' : 'playlists'
}

function slug(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'shelf'
}

/**
 * Catalog reads. They work signed out; with a session they are personalized
 * and include the account's private playlists. Library/account reads require
 * the session.
 */
export class YtmCatalog {
  constructor(
    private readonly client: InnerTubeClient,
    private readonly hasSession: () => boolean,
  ) {}

  private get auth(): AuthMode { return this.hasSession() ? 'optional' : 'none' }

  private browse(body: Record<string, unknown>, auth: AuthMode = this.auth) {
    return this.client.request({ endpoint: 'browse', body, auth })
  }

  async search(request: ProviderSearchRequestV1): Promise<ProviderSearchResultsV1> {
    const query = request.query.trim().slice(0, MAX_QUERY_LENGTH)
    const cursor = decodeCursor(request.cursor, isSearchCursor)
    if (!query && !cursor) throw new ProviderApiError(providerError('INVALID_ARGUMENT', 'Enter something to search for', { retryable: false }))
    const shelves = cursor ? (Object.keys(cursor) as SearchShelf[]) : shelvesFor(request.types)
    const pages = await Promise.all(shelves.map(async (shelf) => {
      const response = cursor
        ? await this.client.request({ endpoint: 'search', auth: this.auth, continuation: cursor[shelf] })
        : await this.client.request({ endpoint: 'search', auth: this.auth, body: { query, params: SEARCH_FILTER_PARAMS[shelf] } })
      return { shelf, ...parseSearchShelf(response) }
    }))
    const results: ProviderSearchResultsV1 = { artists: [], albums: [], tracks: [], playlists: [], nextCursor: null }
    const seen = new Set<string>()
    const next: SearchCursor = {}
    for (const page of pages) {
      for (const item of page.items) {
        const key = `${item.type}:${item.value.sourceId}`
        if (seen.has(key)) continue
        seen.add(key)
        if (item.type === 'track') results.tracks.push(item.value)
        else if (item.type === 'album') results.albums.push(item.value)
        else if (item.type === 'artist') results.artists.push(item.value)
        else results.playlists.push(item.value)
      }
      if (page.continuation) next[page.shelf] = page.continuation
    }
    results.nextCursor = Object.keys(next).length > 0 ? encodeCursor(next) : null
    return results
  }

  async getArtist(sourceId: string): Promise<ProviderArtistV1> {
    return parseArtistPage(await this.browse({ browseId: requireArtistId(sourceId) }), sourceId).artist
  }

  async getArtistBundle(sourceId: string): Promise<ProviderArtistBundleV1> {
    const page = parseArtistPage(await this.browse({ browseId: requireArtistId(sourceId) }), sourceId)
    const releases = new Map(page.releases.map((release) => [release.sourceId, release]))
    // "More" opens the complete discography of a shelf; a failure keeps what the artist page listed.
    for (const more of page.moreReleases.slice(0, 3)) {
      try {
        let grid = parseReleaseGrid(await this.browse({ browseId: more.browseId, ...(more.params ? { params: more.params } : {}) }), more.releaseType)
        for (let count = 1; ; count += 1) {
          for (const release of grid.releases) if (!releases.has(release.sourceId)) releases.set(release.sourceId, release)
          if (!grid.continuation || count >= MORE_RELEASE_PAGES) break
          grid = parseReleaseGrid(await this.client.request({ endpoint: 'browse', auth: this.auth, continuation: grid.continuation }), more.releaseType)
        }
      } catch (error) {
        if (error instanceof ProviderApiError && ['AUTH_EXPIRED', 'NOT_AUTHENTICATED'].includes(error.providerError.code)) throw error
      }
    }
    return {
      artist: page.artist,
      releases: [...releases.values()],
      playlists: page.playlists,
      topTracks: page.topTracks,
      relatedArtists: page.relatedArtists,
    }
  }

  async getAlbum(sourceId: string): Promise<ProviderAlbumV1> {
    return (await this.getAlbumBundle(sourceId)).album
  }

  async getAlbumBundle(sourceId: string): Promise<ProviderAlbumBundleV1> {
    const page = parseAlbumPage(await this.browse({ browseId: requireAlbumId(sourceId) }), sourceId)
    return { album: page.album, tracks: page.tracks }
  }

  /** Metadata for one video ID, from YouTube's watch queue; never another ID. */
  async getTrack(sourceId: string): Promise<ProviderTrackV1> {
    const videoId = requireVideoId(sourceId)
    const response = await this.client.request({ endpoint: 'next', auth: this.auth, body: { videoId, isAudioOnly: true } })
    const track = parseNextTrack(response, videoId)
    if (!track) throw new ProviderApiError(providerError('NOT_FOUND', 'YouTube Music track not found', { retryable: false }))
    return track
  }

  async getShelves(cursor?: string | null): Promise<ProviderPageV1<ProviderHomeShelfV1>> {
    const continuation = decodeCursor(cursor, isContinuation)
    const response = continuation
      ? await this.client.request({ endpoint: 'browse', auth: this.auth, continuation })
      : await this.browse({ browseId: 'FEmusic_home' })
    const page = parseHome(response)
    const offset = continuation ? 1 : 0
    return {
      items: page.shelves.map((shelf, index) => ({
        id: `${slug(shelf.title)}-${offset}-${index}`,
        title: shelf.title,
        kind: shelfKind(shelf.items),
        items: shelf.items.map((item) => item.value),
      })),
      nextCursor: page.continuation ? encodeCursor(page.continuation) : null,
    }
  }

  async getCollection(request: { type: 'playlist' | 'mix' | 'station'; sourceId: string; limit?: number }): Promise<ProviderHomeCollectionV1> {
    const playlistId = requirePlaylistId(request.sourceId)
    const limit = Math.min(COLLECTION_TRACK_LIMIT, Math.max(1, request.limit ?? COLLECTION_TRACK_LIMIT))
    if (request.type === 'station') return this.watchCollection(playlistId)
    try {
      const page = await this.getPlaylist(playlistId)
      const tracks = [...page.tracks]
      let continuation = page.continuation
      while (continuation && tracks.length < limit) {
        const next = parseContinuationItems(await this.client.request({ endpoint: 'browse', auth: this.auth, continuation }))
        tracks.push(...tracksOf(next.items))
        continuation = next.continuation
      }
      return { title: page.playlist.title, subtitle: page.playlist.description ?? null, artworkUrl: page.playlist.artworkUrl ?? null, tracks: tracks.slice(0, limit) }
    } catch (error) {
      // Radio mixes ("RD…") exist only as watch queues.
      if (playlistId.startsWith('RD') && error instanceof ProviderApiError && error.providerError.code === 'NOT_FOUND') return this.watchCollection(playlistId)
      throw error
    }
  }

  private async watchCollection(playlistId: string): Promise<ProviderHomeCollectionV1> {
    const response = await this.client.request({ endpoint: 'next', auth: this.auth, body: { playlistId, isAudioOnly: true } })
    const { tracks, title } = parseWatchPlaylist(response)
    if (tracks.length === 0) throw new ProviderApiError(providerError('NOT_FOUND', 'YouTube Music mix not found', { retryable: false }))
    return { title: title ?? 'YouTube Music mix', subtitle: null, artworkUrl: tracks[0]?.artworkUrl ?? null, tracks }
  }

  private async getPlaylist(playlistId: string) {
    try {
      return parsePlaylistPage(await this.browse({ browseId: `VL${playlistId}` }), playlistId)
    } catch (error) {
      if (error instanceof ProviderApiError) throw error
      throw new ProviderApiError(providerError('NOT_FOUND', 'YouTube Music playlist not found', { retryable: false }))
    }
  }

  // ---- playlists capability ----

  async listLibraryPlaylists(cursor?: string | null): Promise<ProviderPageV1<ProviderPlaylistV1>> {
    const continuation = decodeCursor(cursor, isContinuation)
    const response = continuation
      ? await this.client.request({ endpoint: 'browse', auth: 'required', continuation })
      : await this.client.request({ endpoint: 'browse', auth: 'required', body: { browseId: LIBRARY_BROWSE_IDS.playlists } })
    const page = parseLibraryPage(response)
    return {
      items: page.items.filter((item): item is Extract<ParsedItem, { type: 'playlist' }> => item.type === 'playlist').map((item) => item.value),
      nextCursor: page.continuation ? encodeCursor(page.continuation) : null,
    }
  }

  async getPlaylistInfo(sourceId: string): Promise<ProviderPlaylistV1> {
    return (await this.getPlaylist(requirePlaylistId(sourceId))).playlist
  }

  async getPlaylistTracks(sourceId: string, cursor?: string | null): Promise<ProviderPageV1<ProviderTrackV1>> {
    const playlistId = requirePlaylistId(sourceId)
    const continuation = decodeCursor(cursor, isContinuation)
    if (continuation) {
      const page = parseContinuationItems(await this.client.request({ endpoint: 'browse', auth: this.auth, continuation }))
      return { items: tracksOf(page.items), nextCursor: page.continuation ? encodeCursor(page.continuation) : null }
    }
    const page = await this.getPlaylist(playlistId)
    return { items: page.tracks, nextCursor: page.continuation ? encodeCursor(page.continuation) : null }
  }
}
