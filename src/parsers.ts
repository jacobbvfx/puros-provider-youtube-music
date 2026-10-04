import type {
  ProviderAlbumV1,
  ProviderArtistCreditV1,
  ProviderArtistV1,
  ProviderPlaylistV1,
  ProviderReleaseTypeV1,
  ProviderTrackV1,
} from 'puros-provider-sdk'
import { asArray, asRecord, asString, dig, unwrap, type JsonRecord } from './json'
import {
  albumUrl,
  artistUrl,
  isAlbumId,
  isArtistId,
  isVideoId,
  playlistIdFromBrowseId,
  playlistUrl,
  trackUrl,
} from './ids'

/**
 * InnerTube (WEB_REMIX, hl=en) → public v1 DTOs. Shapes follow live
 * music.youtube.com responses as of 2026-09 and the renderer layouts SimpMusic
 * parses. Missing data stays missing: no ISRCs, disc numbers or durations are
 * invented, and every ID is the one YouTube returned for that entity.
 */

export interface Run {
  text: string
  browseId: string | null
  pageType: string | null
  videoId: string | null
  playlistId: string | null
  url: string | null
}

export interface Continuation {
  token: string
  /** `command`: token goes in the request body. `legacy`: `ctoken`/`continuation` query parameters. */
  style: 'command' | 'legacy'
}

export type ParsedItem =
  | { type: 'track'; value: ProviderTrackV1 }
  | { type: 'album'; value: ProviderAlbumV1 }
  | { type: 'artist'; value: ProviderArtistV1 }
  | { type: 'playlist'; value: ProviderPlaylistV1 }

const TYPE_LABELS = new Set(['song', 'video', 'album', 'single', 'ep', 'playlist', 'artist', 'episode', 'podcast', 'profile', 'audiobook', 'station'])
const JOINER = /^\s*(?:,|&|and|x|×|with|feat\.?|ft\.?)\s*$/i
const DURATION = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/
const YEAR = /^(?:19|20)\d{2}$/
const COUNT = /^([\d,.]+)\s+(?:songs?|tracks?|episodes?|videos?)$/i
const ENGAGEMENT = /\b(?:plays?|views?|likes?|subscribers?|monthly audience|listeners?)\b/i

// ---- primitives ----

export function readRuns(value: unknown): Run[] {
  const record = asRecord(value)
  if (!record) return []
  const simple = asString(record.simpleText)
  if (simple) return [{ text: simple, browseId: null, pageType: null, videoId: null, playlistId: null, url: null }]
  return asArray(record.runs).flatMap((raw) => {
    const run = asRecord(raw)
    const text = typeof run?.text === 'string' ? run.text : null
    if (text === null) return []
    const endpoint = asRecord(run?.navigationEndpoint)
    return [{
      text,
      browseId: asString(dig(endpoint, 'browseEndpoint', 'browseId')),
      pageType: asString(dig(endpoint, 'browseEndpoint', 'browseEndpointContextSupportedConfigs', 'browseEndpointContextMusicConfig', 'pageType')),
      videoId: asString(dig(endpoint, 'watchEndpoint', 'videoId')),
      playlistId: asString(dig(endpoint, 'watchEndpoint', 'playlistId')) ?? asString(dig(endpoint, 'watchPlaylistEndpoint', 'playlistId')),
      url: asString(dig(endpoint, 'urlEndpoint', 'url')),
    }]
  })
}

export function runsText(value: unknown): string {
  return readRuns(value).map((run) => run.text).join('').trim()
}

/** Split "Artist • Album • 3:45" into groups at the bullet separators. */
export function splitGroups(runs: Run[]): Run[][] {
  const groups: Run[][] = [[]]
  for (const run of runs) {
    if (run.text.trim() === '•') groups.push([])
    else groups[groups.length - 1].push(run)
  }
  return groups.filter((group) => group.some((run) => run.text.trim().length > 0))
}

export function parseDurationMs(text: string | null | undefined): number | null {
  const match = text?.trim().match(DURATION)
  if (!match) return null
  return ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1_000
}

function groupText(group: Run[]): string {
  return group.map((run) => run.text).join('').trim()
}

function isTypeLabel(group: Run[]): boolean {
  return group.length === 1 && !group[0].browseId && TYPE_LABELS.has(group[0].text.trim().toLowerCase())
}

function releaseTypeOf(label: string | null | undefined): ProviderReleaseTypeV1 | null {
  switch (label?.trim().toLowerCase()) {
    case 'album': return 'album'
    case 'single': return 'single'
    case 'ep': return 'ep'
    case undefined: case null: case '': return null
    default: return 'other'
  }
}

function yearOf(groups: Run[][]): number | null {
  const found = groups.map(groupText).find((text) => YEAR.test(text))
  return found ? Number(found) : null
}

function trackCountOf(groups: Run[][]): number | null {
  for (const group of groups) {
    const match = groupText(group).match(COUNT)
    if (match) {
      const count = Number(match[1].replace(/[,.]/g, ''))
      if (Number.isSafeInteger(count)) return count
    }
  }
  return null
}

/** Artist credits in display order; unlinked names keep a null source ID. */
export function creditsFrom(runs: Run[]): ProviderArtistCreditV1[] {
  const credits: ProviderArtistCreditV1[] = []
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]
    if (JOINER.test(run.text)) continue
    const name = run.text.trim()
    if (!name) continue
    const next = runs[index + 1]
    credits.push({
      artistSourceId: isArtistId(run.browseId) ? run.browseId : null,
      artistName: name,
      role: credits.length === 0 ? 'primary' : 'main',
      joinPhrase: next && JOINER.test(next.text) ? next.text : null,
      position: credits.length,
    })
  }
  return credits
}

function isArtistGroup(group: Run[]): boolean {
  return group.some((run) => run.pageType === 'MUSIC_PAGE_TYPE_ARTIST' || run.pageType === 'MUSIC_PAGE_TYPE_USER_CHANNEL' || isArtistId(run.browseId))
}

// ---- artwork ----

/** Largest thumbnail URL of a thumbnail list/renderer. */
export function bestThumbnail(value: unknown): string | null {
  const list = asArray(dig(value, 'musicThumbnailRenderer', 'thumbnail', 'thumbnails'))
  const thumbnails = list.length > 0 ? list : asArray(dig(value, 'thumbnails')).length > 0
    ? asArray(dig(value, 'thumbnails'))
    : asArray(dig(value, 'thumbnail', 'thumbnails')).length > 0
      ? asArray(dig(value, 'thumbnail', 'thumbnails'))
      : asArray(dig(value, 'croppedSquareThumbnailRenderer', 'thumbnail', 'thumbnails'))
  let best: { url: string; width: number } | null = null
  for (const raw of thumbnails) {
    const url = asString(asRecord(raw)?.url)
    const width = Number(asRecord(raw)?.width) || 0
    if (url && (!best || width >= best.width)) best = { url, width }
  }
  return best ? artworkUrl(best.url) : null
}

/**
 * Google image URLs carry their size in the suffix (`=w60-h60-l90-rj`,
 * `=s192`); request a square 544 px rendition, the size music.youtube.com uses.
 */
export function artworkUrl(url: string | null | undefined, size = 544): string | null {
  if (!url) return null
  let parsed: URL
  try { parsed = new URL(url.startsWith('//') ? `https:${url}` : url) } catch { return null }
  if (parsed.protocol !== 'https:') return null
  if (!/(?:^|\.)(?:googleusercontent\.com|ggpht\.com)$/.test(parsed.hostname)) return parsed.toString()
  const sized = parsed.toString()
    .replace(/=w\d+-h\d+(-p)?(?:-[a-z0-9-]*)?$/i, (_match, crop: string | undefined) => `=w${size}-h${size}${crop ?? ''}-l90-rj`)
    .replace(/=s\d+(?:-[a-z0-9-]*)?$/i, `=s${size}`)
  return sized
}

// ---- list and grid items ----

function flexColumns(renderer: JsonRecord): Run[][] {
  return asArray(renderer.flexColumns).map((column) => readRuns(dig(column, 'musicResponsiveListItemFlexColumnRenderer', 'text')))
}

function fixedColumns(renderer: JsonRecord): Run[][] {
  return asArray(renderer.fixedColumns).map((column) => readRuns(
    dig(column, 'musicResponsiveListItemFixedColumnRenderer', 'text') ?? dig(column, 'musicResponsiveListItemFlexColumnRenderer', 'text'),
  ))
}

function browseTarget(renderer: JsonRecord): { browseId: string; pageType: string | null } | null {
  const browseId = asString(dig(renderer, 'navigationEndpoint', 'browseEndpoint', 'browseId'))
  if (!browseId) return null
  return {
    browseId,
    pageType: asString(dig(renderer, 'navigationEndpoint', 'browseEndpoint', 'browseEndpointContextSupportedConfigs', 'browseEndpointContextMusicConfig', 'pageType')),
  }
}

const ALBUM_PAGES = new Set(['MUSIC_PAGE_TYPE_ALBUM', 'MUSIC_PAGE_TYPE_AUDIOBOOK'])
const ARTIST_PAGES = new Set(['MUSIC_PAGE_TYPE_ARTIST', 'MUSIC_PAGE_TYPE_USER_CHANNEL'])

/**
 * What a browse endpoint opens. Library tiles of the account's own playlists
 * (and some shelves) carry no `pageType`, only the browse ID; like SimpMusic,
 * those are recognized by the ID itself (`VL…` playlist, `MPRE…` album,
 * `UC…`/`MPLA…` artist). A declared page type always wins.
 */
export function entityKind(target: { browseId: string; pageType: string | null } | null): 'album' | 'artist' | 'playlist' | null {
  if (!target) return null
  const { browseId, pageType } = target
  if (pageType && ALBUM_PAGES.has(pageType)) return isAlbumId(browseId) ? 'album' : null
  if (pageType && ARTIST_PAGES.has(pageType)) return isArtistId(browseId) ? 'artist' : null
  if (pageType === 'MUSIC_PAGE_TYPE_PLAYLIST') return playlistIdFromBrowseId(browseId) ? 'playlist' : null
  if (pageType) return null
  if (browseId.startsWith('VL') && playlistIdFromBrowseId(browseId)) return 'playlist'
  if (isAlbumId(browseId)) return 'album'
  if (isArtistId(browseId)) return 'artist'
  return null
}

function isAlbumRun(run: Run): boolean {
  return isAlbumId(run.browseId) && (run.pageType === null || ALBUM_PAGES.has(run.pageType))
}

function listItemVideoId(renderer: JsonRecord): string | null {
  const candidates = [
    dig(renderer, 'playlistItemData', 'videoId'),
    dig(renderer, 'overlay', 'musicItemThumbnailOverlayRenderer', 'content', 'musicPlayButtonRenderer', 'playNavigationEndpoint', 'watchEndpoint', 'videoId'),
    dig(renderer, 'flexColumns', 0, 'musicResponsiveListItemFlexColumnRenderer', 'text', 'runs', 0, 'navigationEndpoint', 'watchEndpoint', 'videoId'),
  ]
  return candidates.find(isVideoId) ?? null
}

export interface TrackContext {
  album?: Pick<ProviderAlbumV1, 'sourceId' | 'title' | 'artworkUrl' | 'artists'>
  /** Album pages number their rows; that index is YouTube's, not invented. */
  useIndexAsTrackNumber?: boolean
}

function buildTrack(input: {
  videoId: string
  title: string
  artists: ProviderArtistCreditV1[]
  album: { sourceId: string; title: string } | null
  durationMs: number | null
  artworkUrl: string | null
  trackNumber: number | null
}): ProviderTrackV1 {
  return {
    sourceId: input.videoId,
    title: input.title,
    isrc: null,
    durationMs: input.durationMs ?? 0,
    trackNumber: input.trackNumber,
    discNumber: null,
    albumSourceId: input.album?.sourceId ?? null,
    albumTitle: input.album?.title ?? null,
    primaryArtistSourceId: input.artists[0]?.artistSourceId ?? null,
    primaryArtistName: input.artists[0]?.artistName ?? null,
    artists: input.artists,
    genres: [],
    artworkUrl: input.artworkUrl,
    providerUrl: trackUrl(input.videoId),
  }
}

function trackFromListItem(renderer: JsonRecord, videoId: string, context: TrackContext): ProviderTrackV1 | null {
  const columns = flexColumns(renderer)
  const title = groupText(columns[0] ?? [])
  if (!title) return null
  let artists: ProviderArtistCreditV1[] | null = null
  let album: { sourceId: string; title: string } | null = null
  let durationMs: number | null = null
  let firstGroup = true
  for (const column of columns.slice(1)) {
    for (const group of splitGroups(column)) {
      if (isTypeLabel(group)) continue
      const albumRun = group.find(isAlbumRun)
      const text = groupText(group)
      if (albumRun) album = { sourceId: albumRun.browseId!, title: albumRun.text.trim() }
      else if (parseDurationMs(text) !== null) durationMs = parseDurationMs(text)
      else if (!artists && (isArtistGroup(group) || (firstGroup && !ENGAGEMENT.test(text) && !YEAR.test(text)))) artists = creditsFrom(group)
      firstGroup = false
    }
  }
  for (const column of fixedColumns(renderer)) durationMs ??= parseDurationMs(groupText(column))
  const index = Number(runsText(renderer.index))
  const fallbackAlbum = context.album ? { sourceId: context.album.sourceId, title: context.album.title } : null
  return buildTrack({
    videoId,
    title,
    artists: artists && artists.length > 0 ? artists : context.album?.artists ?? artists ?? [],
    album: album ?? fallbackAlbum,
    durationMs,
    artworkUrl: bestThumbnail(renderer.thumbnail) ?? context.album?.artworkUrl ?? null,
    trackNumber: context.useIndexAsTrackNumber && Number.isSafeInteger(index) && index > 0 ? index : null,
  })
}

export function parseListItem(value: unknown, context: TrackContext = {}): ParsedItem | null {
  const renderer = asRecord(asRecord(value)?.musicResponsiveListItemRenderer) ?? asRecord(value)
  if (!renderer || !Array.isArray(renderer.flexColumns)) return null
  const target = browseTarget(renderer)
  const columns = flexColumns(renderer)
  const title = groupText(columns[0] ?? [])
  const meta = columns.slice(1).flatMap(splitGroups)
  const labels = meta.filter(isTypeLabel)
  const rest = meta.filter((group) => !isTypeLabel(group))
  const artwork = bestThumbnail(renderer.thumbnail)
  const kind = entityKind(target)
  if (target && kind === 'album') {
    const artistGroup = rest.find(isArtistGroup) ?? rest.find((group) => !YEAR.test(groupText(group)) && !ENGAGEMENT.test(groupText(group)))
    const artists = artistGroup ? creditsFrom(artistGroup) : []
    return { type: 'album', value: albumDto({
      sourceId: target.browseId, title, artists, artworkUrl: artwork,
      releaseType: releaseTypeOf(labels[0]?.[0]?.text) ?? null, year: yearOf(rest),
    }) }
  }
  if (target && kind === 'artist') {
    return { type: 'artist', value: artistDto({ sourceId: target.browseId, name: title, artworkUrl: artwork }) }
  }
  if (target && kind === 'playlist') {
    const playlistId = playlistIdFromBrowseId(target.browseId)
    if (!playlistId || !title) return null
    return { type: 'playlist', value: playlistDto({
      sourceId: playlistId, title, artworkUrl: artwork, trackCount: trackCountOf(rest), description: null,
    }) }
  }
  if (target) return null
  const videoId = listItemVideoId(renderer)
  if (!videoId) return null
  const track = trackFromListItem(renderer, videoId, context)
  return track ? { type: 'track', value: track } : null
}

export function parseTwoRowItem(value: unknown, defaults: { releaseType?: ProviderReleaseTypeV1 | null } = {}): ParsedItem | null {
  const renderer = asRecord(asRecord(value)?.musicTwoRowItemRenderer) ?? asRecord(value)
  if (!renderer || !renderer.title) return null
  const title = runsText(renderer.title)
  if (!title) return null
  const groups = splitGroups(readRuns(renderer.subtitle))
  const labels = groups.filter(isTypeLabel)
  const rest = groups.filter((group) => !isTypeLabel(group))
  const artwork = bestThumbnail(renderer.thumbnailRenderer)
  const target = browseTarget(renderer)
  const kind = entityKind(target)
  if (target && kind === 'album') {
    const artistGroup = rest.find(isArtistGroup) ?? rest.find((group) => !YEAR.test(groupText(group)) && !ENGAGEMENT.test(groupText(group)))
    return { type: 'album', value: albumDto({
      sourceId: target.browseId,
      title,
      artists: artistGroup ? creditsFrom(artistGroup) : [],
      artworkUrl: artwork,
      releaseType: releaseTypeOf(labels[0]?.[0]?.text) ?? defaults.releaseType ?? null,
      year: yearOf(rest),
    }) }
  }
  if (target && kind === 'artist') {
    return { type: 'artist', value: artistDto({ sourceId: target.browseId, name: title, artworkUrl: artwork }) }
  }
  if (target && kind === 'playlist') {
    const playlistId = playlistIdFromBrowseId(target.browseId)
    if (!playlistId) return null
    return { type: 'playlist', value: playlistDto({
      sourceId: playlistId, title, artworkUrl: artwork, trackCount: trackCountOf(rest), description: null,
    }) }
  }
  const videoId = asString(dig(renderer, 'navigationEndpoint', 'watchEndpoint', 'videoId'))
  if (target || !isVideoId(videoId)) return null
  const albumRun = rest.flat().find(isAlbumRun)
  const artistGroup = rest.find(isArtistGroup) ?? rest.find((group) => !ENGAGEMENT.test(groupText(group)) && parseDurationMs(groupText(group)) === null)
  return { type: 'track', value: buildTrack({
    videoId,
    title,
    artists: artistGroup ? creditsFrom(artistGroup) : [],
    album: albumRun ? { sourceId: albumRun.browseId!, title: albumRun.text.trim() } : null,
    durationMs: null,
    artworkUrl: artwork,
    trackNumber: null,
  }) }
}

/** Any list, grid or panel item. */
export function parseItem(value: unknown, context: TrackContext = {}, defaults: { releaseType?: ProviderReleaseTypeV1 | null } = {}): ParsedItem | null {
  const record = asRecord(value)
  if (!record) return null
  if (record.musicResponsiveListItemRenderer) return parseListItem(record, context)
  if (record.musicTwoRowItemRenderer) return parseTwoRowItem(record, defaults)
  if (record.playlistPanelVideoRenderer) {
    const track = parsePanelVideo(record.playlistPanelVideoRenderer)
    return track ? { type: 'track', value: track } : null
  }
  return null
}

// ---- DTO builders ----

function albumDto(input: {
  sourceId: string
  title: string
  artists: ProviderArtistCreditV1[]
  artworkUrl: string | null
  releaseType: ProviderReleaseTypeV1 | null
  year: number | null
  totalTracks?: number | null
}): ProviderAlbumV1 {
  return {
    sourceId: input.sourceId,
    title: input.title,
    upc: null,
    year: input.year,
    releaseType: input.releaseType,
    artworkUrl: input.artworkUrl,
    primaryArtistSourceId: input.artists[0]?.artistSourceId ?? null,
    primaryArtistName: input.artists[0]?.artistName ?? null,
    artists: input.artists,
    genres: [],
    totalTracks: input.totalTracks ?? null,
    totalDiscs: null,
    providerUrl: albumUrl(input.sourceId),
  }
}

function artistDto(input: { sourceId: string; name: string; artworkUrl: string | null; bio?: string | null }): ProviderArtistV1 {
  return {
    sourceId: input.sourceId,
    name: input.name,
    artworkUrl: input.artworkUrl,
    bio: input.bio ?? null,
    genres: [],
    providerUrl: artistUrl(input.sourceId),
  }
}

function playlistDto(input: {
  sourceId: string
  title: string
  artworkUrl: string | null
  trackCount: number | null
  description: string | null
}): ProviderPlaylistV1 {
  return {
    sourceId: input.sourceId,
    title: input.title,
    description: input.description,
    artworkUrl: input.artworkUrl,
    trackCount: input.trackCount,
    providerUrl: playlistUrl(input.sourceId),
    collectionRef: { type: 'playlist', sourceId: input.sourceId },
  }
}

// ---- continuations ----

function commandToken(item: unknown): string | null {
  return asString(dig(item, 'continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token'))
}

function legacyToken(container: unknown): string | null {
  for (const entry of asArray(dig(container, 'continuations'))) {
    const token = asString(dig(entry, 'nextContinuationData', 'continuation')) ?? asString(dig(entry, 'nextRadioContinuationData', 'continuation'))
    if (token) return token
  }
  return null
}

/** Items of a shelf/grid plus its continuation, whichever style the response used. */
function collectShelf(container: JsonRecord, listKey: 'contents' | 'items'): { items: unknown[]; continuation: Continuation | null } {
  const raw = asArray(container[listKey])
  const items = raw.filter((item) => !asRecord(item)?.continuationItemRenderer)
  const command = raw.map(commandToken).find(Boolean)
  if (command) return { items, continuation: { token: command, style: 'command' } }
  const legacy = legacyToken(container)
  return { items, continuation: legacy ? { token: legacy, style: 'legacy' } : null }
}

/** Continuation responses: `onResponseReceivedActions` (command) or `continuationContents` (legacy). */
export function parseContinuationItems(response: unknown): { items: unknown[]; continuation: Continuation | null } {
  for (const action of asArray(dig(response, 'onResponseReceivedActions'))) {
    const appended = dig(action, 'appendContinuationItemsAction', 'continuationItems') ?? dig(action, 'reloadContinuationItemsCommand', 'continuationItems')
    if (Array.isArray(appended)) return collectShelf({ contents: appended }, 'contents')
  }
  const contents = asRecord(dig(response, 'continuationContents'))
  if (contents) {
    for (const key of ['musicPlaylistShelfContinuation', 'musicShelfContinuation', 'gridContinuation', 'sectionListContinuation']) {
      const shelf = asRecord(contents[key])
      if (!shelf) continue
      return collectShelf(shelf, Array.isArray(shelf.items) ? 'items' : 'contents')
    }
  }
  return { items: [], continuation: null }
}

// ---- pages ----

function sectionListContents(response: unknown): unknown[] {
  const tabs = asArray(dig(response, 'contents', 'singleColumnBrowseResultsRenderer', 'tabs'))
  const twoColumnTabs = asArray(dig(response, 'contents', 'twoColumnBrowseResultsRenderer', 'tabs'))
  const tabbedSearch = asArray(dig(response, 'contents', 'tabbedSearchResultsRenderer', 'tabs'))
  const tab = [...tabs, ...twoColumnTabs, ...tabbedSearch].find((entry) => dig(entry, 'tabRenderer', 'content', 'sectionListRenderer'))
  return asArray(dig(tab, 'tabRenderer', 'content', 'sectionListRenderer', 'contents'))
}

/** A filtered search shelf (songs/albums/artists/playlists) or its continuation. */
export function parseSearchShelf(response: unknown): { items: ParsedItem[]; continuation: Continuation | null } {
  const continued = parseContinuationItems(response)
  let raw = continued.items
  let continuation = continued.continuation
  if (raw.length === 0 && !continuation) {
    const shelves = sectionListContents(response).map(unwrap).filter((entry) => entry?.kind === 'musicShelfRenderer')
    const shelf = shelves[shelves.length - 1]?.renderer
    if (shelf) ({ items: raw, continuation } = collectShelf(shelf, 'contents'))
  }
  return { items: raw.map((item) => parseItem(item)).filter((item): item is ParsedItem => item !== null), continuation }
}

function responsiveHeader(response: unknown): JsonRecord | null {
  for (const entry of sectionListContents(response)) {
    const direct = asRecord(dig(entry, 'musicResponsiveHeaderRenderer'))
    if (direct) return direct
    const editable = asRecord(dig(entry, 'musicEditablePlaylistDetailHeaderRenderer', 'header', 'musicResponsiveHeaderRenderer'))
    if (editable) return editable
  }
  return asRecord(dig(response, 'header', 'musicDetailHeaderRenderer'))
    ?? asRecord(dig(response, 'header', 'musicEditablePlaylistDetailHeaderRenderer', 'header', 'musicDetailHeaderRenderer'))
}

function descriptionText(header: JsonRecord | null): string | null {
  const runs = readRuns(dig(header, 'description', 'musicDescriptionShelfRenderer', 'description') ?? dig(header, 'description'))
  // Link runs carry the full URL; the displayed text is shortened.
  const text = runs.map((run) => run.url ?? run.text).join('').trim()
  return text || null
}

function secondaryShelf(response: unknown): JsonRecord | null {
  const secondary = asArray(dig(response, 'contents', 'twoColumnBrowseResultsRenderer', 'secondaryContents', 'sectionListRenderer', 'contents'))
  for (const entry of [...secondary, ...sectionListContents(response)]) {
    const shelf = asRecord(dig(entry, 'musicPlaylistShelfRenderer')) ?? asRecord(dig(entry, 'musicShelfRenderer'))
    if (shelf) return shelf
  }
  return null
}

export interface AlbumPage {
  album: ProviderAlbumV1
  tracks: ProviderTrackV1[]
  audioPlaylistId: string | null
}

export function parseAlbumPage(response: unknown, browseId: string): AlbumPage {
  const header = responsiveHeader(response)
  const title = runsText(header?.title)
  if (!header || !title) throw new Error('YouTube Music album page has no header')
  const subtitle = splitGroups(readRuns(header.subtitle))
  const labels = subtitle.filter(isTypeLabel)
  const strapline = readRuns(header.straplineTextOne)
  const artists = strapline.length > 0 ? creditsFrom(strapline) : creditsFrom(subtitle.find(isArtistGroup) ?? [])
  const canonical = asString(dig(response, 'microformat', 'microformatDataRenderer', 'urlCanonical'))
  const audioPlaylistId = canonical ? new URL(canonical).searchParams.get('list') : null
  const shelf = secondaryShelf(response)
  const albumBase = albumDto({
    sourceId: browseId,
    title,
    artists,
    artworkUrl: bestThumbnail(header.thumbnail),
    releaseType: releaseTypeOf(labels[0]?.[0]?.text),
    year: yearOf(subtitle),
  })
  const tracks = asArray(shelf?.contents)
    .map((item) => parseListItem(item, { album: albumBase, useIndexAsTrackNumber: true }))
    .filter((item): item is { type: 'track'; value: ProviderTrackV1 } => item?.type === 'track')
    .map((item) => item.value)
  return { album: { ...albumBase, totalTracks: tracks.length > 0 ? tracks.length : null }, tracks, audioPlaylistId }
}

export interface PlaylistPage {
  playlist: ProviderPlaylistV1
  tracks: ProviderTrackV1[]
  continuation: Continuation | null
}

export function parsePlaylistPage(response: unknown, playlistId: string): PlaylistPage {
  const header = responsiveHeader(response)
  const title = runsText(header?.title) || asString(dig(response, 'microformat', 'microformatDataRenderer', 'title'))
  if (!title) throw new Error('YouTube Music playlist page has no title')
  const counts = splitGroups(readRuns(header?.secondSubtitle))
  const shelf = secondaryShelf(response)
  const { items, continuation } = shelf ? collectShelf(shelf, 'contents') : { items: [], continuation: null }
  return {
    playlist: {
      ...playlistDto({
        sourceId: playlistId,
        title,
        artworkUrl: bestThumbnail(header?.thumbnail),
        trackCount: trackCountOf(counts),
        description: descriptionText(header),
      }),
      editable: !!dig(response, 'contents', 'twoColumnBrowseResultsRenderer', 'tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents', 0, 'musicEditablePlaylistDetailHeaderRenderer'),
    },
    tracks: tracksOf(items),
    continuation,
  }
}

export function tracksOf(items: unknown[], context: TrackContext = {}): ProviderTrackV1[] {
  return items
    .map((item) => parseItem(item, context))
    .filter((item): item is { type: 'track'; value: ProviderTrackV1 } => item?.type === 'track')
    .map((item) => item.value)
}

export interface MoreEndpoint { browseId: string; params: string | null }

export interface ArtistPage {
  artist: ProviderArtistV1
  topTracks: ProviderTrackV1[]
  releases: ProviderAlbumV1[]
  playlists: ProviderPlaylistV1[]
  relatedArtists: ProviderArtistV1[]
  /** Complete discography pages behind a shelf's "More" button. */
  moreReleases: Array<MoreEndpoint & { releaseType: ProviderReleaseTypeV1 | null }>
}

function sectionTitle(renderer: JsonRecord): string {
  return runsText(dig(renderer, 'header', 'musicCarouselShelfBasicHeaderRenderer', 'title') ?? renderer.title)
}

function moreEndpoint(renderer: JsonRecord): MoreEndpoint | null {
  const endpoint = asRecord(dig(renderer, 'header', 'musicCarouselShelfBasicHeaderRenderer', 'moreContentButton', 'buttonRenderer', 'navigationEndpoint', 'browseEndpoint'))
    ?? asRecord(dig(renderer, 'header', 'musicCarouselShelfBasicHeaderRenderer', 'title', 'runs', 0, 'navigationEndpoint', 'browseEndpoint'))
    ?? asRecord(dig(renderer, 'bottomEndpoint', 'browseEndpoint'))
  const browseId = asString(endpoint?.browseId)
  return browseId ? { browseId, params: asString(endpoint?.params) } : null
}

function releaseTypeOfSection(title: string): ProviderReleaseTypeV1 | null {
  const lower = title.toLowerCase()
  if (lower.includes('single') && lower.includes('ep')) return null
  if (lower.startsWith('single')) return 'single'
  if (lower === 'eps' || lower.startsWith('ep')) return 'ep'
  if (lower.startsWith('album')) return 'album'
  return null
}

export function parseArtistPage(response: unknown, channelId: string): ArtistPage {
  const header = asRecord(dig(response, 'header', 'musicImmersiveHeaderRenderer'))
    ?? asRecord(dig(response, 'header', 'musicVisualHeaderRenderer'))
    ?? asRecord(dig(response, 'header', 'musicHeaderRenderer'))
  const name = runsText(header?.title)
  if (!header || !name) throw new Error('YouTube Music artist page has no header')
  const artwork = bestThumbnail(header.thumbnail) ?? bestThumbnail(header.foregroundThumbnail)
  const bio = runsText(header.description) || null
  const page: ArtistPage = {
    artist: artistDto({ sourceId: channelId, name, artworkUrl: artwork, bio }),
    topTracks: [], releases: [], playlists: [], relatedArtists: [], moreReleases: [],
  }
  const seen = new Set<string>()
  for (const section of sectionListContents(response)) {
    const wrapped = unwrap(section)
    if (!wrapped) continue
    const { kind, renderer } = wrapped
    if (kind === 'musicShelfRenderer') {
      page.topTracks.push(...tracksOf(asArray(renderer.contents)))
      continue
    }
    if (kind !== 'musicCarouselShelfRenderer') continue
    const title = sectionTitle(renderer)
    const releaseType = releaseTypeOfSection(title)
    let hasAlbums = false
    for (const item of asArray(renderer.contents)) {
      const parsed = parseItem(item, {}, { releaseType })
      if (!parsed || seen.has(`${parsed.type}:${parsed.value.sourceId}`)) continue
      if (parsed.type === 'album') {
        hasAlbums = true
        page.releases.push(parsed.value)
      } else if (parsed.type === 'playlist') page.playlists.push(parsed.value)
      else if (parsed.type === 'artist' && parsed.value.sourceId !== channelId) page.relatedArtists.push(parsed.value)
      else continue
      seen.add(`${parsed.type}:${parsed.value.sourceId}`)
    }
    const more = moreEndpoint(renderer)
    if (hasAlbums && more) page.moreReleases.push({ ...more, releaseType })
  }
  return page
}

/** A discography "More" page: a grid of releases. */
export function parseReleaseGrid(response: unknown, releaseType: ProviderReleaseTypeV1 | null): { releases: ProviderAlbumV1[]; continuation: Continuation | null } {
  const continued = parseContinuationItems(response)
  let raw = continued.items
  let continuation = continued.continuation
  if (raw.length === 0 && !continuation) {
    for (const section of sectionListContents(response)) {
      const grid = asRecord(dig(section, 'gridRenderer')) ?? asRecord(dig(section, 'itemSectionRenderer', 'contents', 0, 'gridRenderer'))
      if (grid) ({ items: raw, continuation } = collectShelf(grid, 'items'))
    }
  }
  const releases = raw.map((item) => parseItem(item, {}, { releaseType }))
    .filter((item): item is { type: 'album'; value: ProviderAlbumV1 } => item?.type === 'album')
    .map((item) => item.value)
  return { releases, continuation }
}

export interface HomeShelf { title: string; items: ParsedItem[] }

/** FEmusic_home and its `sectionListContinuation` pages. */
export function parseHome(response: unknown): { shelves: HomeShelf[]; continuation: Continuation | null } {
  const continued = asRecord(dig(response, 'continuationContents', 'sectionListContinuation'))
  const sectionList = continued ?? asRecord(dig(asArray(dig(response, 'contents', 'singleColumnBrowseResultsRenderer', 'tabs'))[0], 'tabRenderer', 'content', 'sectionListRenderer'))
  const shelves: HomeShelf[] = []
  for (const section of asArray(sectionList?.contents)) {
    const wrapped = unwrap(section)
    if (!wrapped || !['musicCarouselShelfRenderer', 'musicImmersiveCarouselShelfRenderer', 'musicShelfRenderer'].includes(wrapped.kind)) continue
    const title = runsText(dig(wrapped.renderer, 'header', 'musicCarouselShelfBasicHeaderRenderer', 'title'))
      || runsText(dig(wrapped.renderer, 'header', 'musicImmersiveCarouselShelfBasicHeaderRenderer', 'title'))
      || runsText(wrapped.renderer.title)
    const items = asArray(wrapped.renderer.contents).map((item) => parseItem(item)).filter((item): item is ParsedItem => item !== null)
    if (title && items.length > 0) shelves.push({ title, items })
  }
  const token = legacyToken(sectionList)
  return { shelves, continuation: token ? { token, style: 'legacy' } : null }
}

export function parsePanelVideo(value: unknown): ProviderTrackV1 | null {
  const renderer = asRecord(value)
  const videoId = asString(renderer?.videoId)
  if (!renderer || !isVideoId(videoId)) return null
  const title = runsText(renderer.title)
  if (!title) return null
  const groups = splitGroups(readRuns(renderer.longBylineText))
  const albumRun = groups.flat().find(isAlbumRun)
  const artistGroup = groups.find(isArtistGroup) ?? groups.find((group) => !ENGAGEMENT.test(groupText(group)) && !YEAR.test(groupText(group)))
  return buildTrack({
    videoId,
    title,
    artists: artistGroup ? creditsFrom(artistGroup) : [],
    album: albumRun ? { sourceId: albumRun.browseId!, title: albumRun.text.trim() } : null,
    durationMs: parseDurationMs(runsText(renderer.lengthText)),
    artworkUrl: bestThumbnail(renderer.thumbnail),
    trackNumber: null,
  })
}

/** The requested video from a `next` response, only if YouTube returned exactly that ID. */
export function parseNextTrack(response: unknown, videoId: string): ProviderTrackV1 | null {
  const tabs = asArray(dig(response, 'contents', 'singleColumnMusicWatchNextResultsRenderer', 'tabbedRenderer', 'watchNextTabbedResultsRenderer', 'tabs'))
  for (const tab of tabs) {
    for (const item of asArray(dig(tab, 'tabRenderer', 'content', 'musicQueueRenderer', 'content', 'playlistPanelRenderer', 'contents'))) {
      const renderer = asRecord(dig(item, 'playlistPanelVideoRenderer'))
        ?? asRecord(dig(item, 'playlistPanelVideoWrapperRenderer', 'primaryRenderer', 'playlistPanelVideoRenderer'))
      if (asString(renderer?.videoId) === videoId) return parsePanelVideo(renderer)
    }
  }
  return null
}

/** Watch-queue tracks (radio/station playlists) from a `next` response. */
export function parseWatchPlaylist(response: unknown): { tracks: ProviderTrackV1[]; title: string | null } {
  const tabs = asArray(dig(response, 'contents', 'singleColumnMusicWatchNextResultsRenderer', 'tabbedRenderer', 'watchNextTabbedResultsRenderer', 'tabs'))
  const panel = asRecord(dig(tabs[0], 'tabRenderer', 'content', 'musicQueueRenderer', 'content', 'playlistPanelRenderer'))
  const tracks = asArray(panel?.contents).map((item) => parsePanelVideo(
    dig(item, 'playlistPanelVideoRenderer') ?? dig(item, 'playlistPanelVideoWrapperRenderer', 'primaryRenderer', 'playlistPanelVideoRenderer'),
  )).filter((track): track is ProviderTrackV1 => track !== null)
  return { tracks, title: asString(panel?.title) ?? (runsText(panel?.title) || null) }
}

/** Items of an account library page (grid or list) plus its continuation. */
/** Shape of a library item the parser could not map; never titles, IDs or account data. */
export interface SkippedItem { renderer: string; pageType: string | null; idPrefix: string | null }

function describeSkipped(item: unknown): SkippedItem | null {
  const wrapped = unwrap(item)
  if (!wrapped) return null
  const endpoint = asRecord(dig(wrapped.renderer, 'navigationEndpoint'))
    ?? asRecord(dig(wrapped.renderer, 'flexColumns', 0, 'musicResponsiveListItemFlexColumnRenderer', 'text', 'runs', 0, 'navigationEndpoint'))
  const browseId = asString(dig(endpoint, 'browseEndpoint', 'browseId'))
  const hasWatch = !!dig(endpoint, 'watchEndpoint') || !!dig(wrapped.renderer, 'playlistItemData')
  // Tiles that open nothing (e.g. "New playlist") are not content.
  if (!browseId && !hasWatch) return null
  return {
    renderer: wrapped.kind,
    pageType: asString(dig(endpoint, 'browseEndpoint', 'browseEndpointContextSupportedConfigs', 'browseEndpointContextMusicConfig', 'pageType')),
    idPrefix: browseId ? (browseId.match(/^[A-Z]+(?:music_)?/)?.[0] ?? '').slice(0, 8) || null : hasWatch ? 'watch' : null,
  }
}

export function parseLibraryPage(response: unknown): { items: ParsedItem[]; continuation: Continuation | null; skipped: SkippedItem[] } {
  const continued = parseContinuationItems(response)
  let raw = continued.items
  let continuation = continued.continuation
  if (raw.length === 0 && !continuation) {
    const containers: Array<{ shelf: JsonRecord; key: 'items' | 'contents' }> = []
    const visit = (section: unknown) => {
      const grid = asRecord(dig(section, 'gridRenderer'))
      if (grid) containers.push({ shelf: grid, key: 'items' })
      const shelf = asRecord(dig(section, 'musicShelfRenderer'))
      if (shelf) containers.push({ shelf, key: 'contents' })
      for (const nested of asArray(dig(section, 'itemSectionRenderer', 'contents'))) visit(nested)
    }
    for (const section of sectionListContents(response)) visit(section)
    for (const { shelf, key } of containers) {
      const collected = collectShelf(shelf, key)
      raw = raw.concat(collected.items)
      continuation ??= collected.continuation
    }
  }
  if (raw.length === 0 && !continuation) ({ items: raw, continuation } = collectItemsAnywhere(response))
  const items: ParsedItem[] = []
  const skipped: SkippedItem[] = []
  for (const item of raw) {
    const parsed = parseItem(item)
    if (parsed) items.push(parsed)
    else {
      const described = describeSkipped(item)
      if (described) skipped.push(described)
    }
  }
  return { items, continuation, skipped }
}

const ITEM_RENDERERS = new Set(['musicTwoRowItemRenderer', 'musicResponsiveListItemRenderer'])

/**
 * Last resort for an unfamiliar page layout: every list/grid item and the first
 * continuation anywhere in the page body (never the header or menus).
 */
function collectItemsAnywhere(response: unknown): { items: unknown[]; continuation: Continuation | null } {
  const items: unknown[] = []
  let continuation: Continuation | null = null
  const visit = (value: unknown, depth: number) => {
    if (depth > 24) return
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1)
      return
    }
    const record = asRecord(value)
    if (!record) return
    for (const [key, child] of Object.entries(record)) {
      if (ITEM_RENDERERS.has(key)) { items.push({ [key]: child }); continue }
      if (key === 'continuationItemRenderer') {
        const token = asString(dig(child, 'continuationEndpoint', 'continuationCommand', 'token'))
        if (token && !continuation) continuation = { token, style: 'command' }
        continue
      }
      if (key === 'nextContinuationData') {
        const token = asString(dig(child, 'continuation'))
        if (token && !continuation) continuation = { token, style: 'legacy' }
        continue
      }
      if (['header', 'menu', 'responseContext', 'frameworkUpdates', 'microformat', 'background'].includes(key)) continue
      visit(child, depth + 1)
    }
  }
  visit(dig(response, 'contents') ?? dig(response, 'continuationContents') ?? dig(response, 'onResponseReceivedActions'), 0)
  return { items, continuation }
}

/**
 * Renderer layout of a response as `a > b > c ×n` lines: renderer/view-model
 * names and counts only, never text, IDs or tokens. For diagnosing layout changes.
 */
export function describeLayout(response: unknown, limit = 30): string[] {
  const counts = new Map<string, number>()
  const visit = (value: unknown, chain: string[], depth: number) => {
    if (depth > 30) return
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, chain, depth + 1)
      return
    }
    const record = asRecord(value)
    if (!record) return
    for (const [key, child] of Object.entries(record)) {
      if (['responseContext', 'frameworkUpdates', 'trackingParams', 'loggingContext'].includes(key)) continue
      const isRenderer = key.endsWith('Renderer') || key.endsWith('ViewModel') || key.endsWith('Continuation') || key === 'continuationContents' || key === 'onResponseReceivedActions'
      const next = isRenderer ? [...chain, key] : chain
      if (isRenderer) {
        const line = next.slice(-5).join(' > ')
        counts.set(line, (counts.get(line) ?? 0) + 1)
        if (ITEM_RENDERERS.has(key)) continue
      }
      visit(child, next, depth + 1)
    }
  }
  visit(response, [], 0)
  return [...counts].slice(0, limit).map(([line, count]) => `${line} ×${count}`)
}

/**
 * One identity (a Google account or one of its brand channels) the imported
 * browser session can act as. Requests for it carry `X-Goog-AuthUser: authUser`
 * and, for a channel, `X-Goog-PageId: pageId` (SimpMusic `AccountItem.toAccountInfo`).
 */
export interface YtmIdentity {
  name: string
  handle: string | null
  pageId: string | null
  authUser: number
  selected: boolean
}

/** `getAccountSwitcherEndpoint` (a `)]}'`-prefixed JSON page) → identities in listed order. */
export function parseAccountSwitcher(body: string): YtmIdentity[] {
  let json: unknown
  try { json = JSON.parse(body.replace(/^\)\]\}'\s*/, '')) } catch { return [] }
  const identities: YtmIdentity[] = []
  const visit = (value: unknown, depth: number) => {
    if (depth > 30) return
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return }
    const record = asRecord(value)
    if (!record) return
    const item = asRecord(record.accountItem)
    if (item) {
      const name = asString(dig(item, 'accountName', 'simpleText')) ?? (runsText(item.accountName) || null)
      if (name) {
        const tokens = asArray(dig(item, 'serviceEndpoint', 'selectActiveIdentityEndpoint', 'supportedTokens'))
        const pageId = asString(item.onBehalfOfParameter)
          ?? tokens.map((token) => asString(dig(token, 'pageIdToken', 'pageId'))).find(Boolean) ?? null
        const signinUrl = tokens.map((token) => asString(dig(token, 'accountSigninToken', 'signinUrl'))).find(Boolean)
        const authUser = Number(signinUrl?.match(/[?&]authuser=(\d+)/)?.[1] ?? 0)
        identities.push({
          name,
          handle: asString(dig(item, 'channelHandle', 'simpleText')),
          pageId,
          authUser: Number.isSafeInteger(authUser) ? authUser : 0,
          selected: item.isSelected === true,
        })
      }
      return
    }
    for (const child of Object.values(record)) visit(child, depth + 1)
  }
  visit(json, 0)
  return identities
}

export function parseAccountName(response: unknown): { name: string; handle: string | null } | null {
  for (const action of asArray(dig(response, 'actions'))) {
    const header = asRecord(dig(action, 'openPopupAction', 'popup', 'multiPageMenuRenderer', 'header', 'activeAccountHeaderRenderer'))
    const name = runsText(header?.accountName)
    if (header && name) return { name, handle: runsText(header.channelHandle) || null }
  }
  return null
}

/** `GFEEDBACK.logged_in` from the response context: `true`/`false`, or null when absent. */
export function responseLoggedIn(response: unknown): boolean | null {
  for (const service of asArray(dig(response, 'responseContext', 'serviceTrackingParams'))) {
    for (const param of asArray(dig(service, 'params'))) {
      if (dig(param, 'key') === 'logged_in') return dig(param, 'value') === '1'
    }
  }
  return null
}

export function responseVisitorData(response: unknown): string | null {
  return asString(dig(response, 'responseContext', 'visitorData'))
}
