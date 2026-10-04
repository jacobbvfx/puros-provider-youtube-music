import { ProviderApiError, providerError } from 'puros-provider-sdk'
import { YTM_ORIGIN } from './constants'

/**
 * Source IDs are the native YouTube identifiers, unchanged:
 * tracks `videoId`, albums `MPREb_…` browse IDs, artists `UC…` channel IDs,
 * playlists the `playlistId` without the `VL` browse prefix.
 */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const ALBUM_ID = /^MPRE[A-Za-z0-9_-]{4,60}$/
const ARTIST_ID = /^(?:UC[A-Za-z0-9_-]{22}|MPLA[A-Za-z0-9_-]{4,60})$/
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,80}$/

export const isVideoId = (value: unknown): value is string => typeof value === 'string' && VIDEO_ID.test(value)
export const isAlbumId = (value: unknown): value is string => typeof value === 'string' && ALBUM_ID.test(value)
export const isArtistId = (value: unknown): value is string => typeof value === 'string' && ARTIST_ID.test(value)
export const isPlaylistId = (value: unknown): value is string => typeof value === 'string' && PLAYLIST_ID.test(value)

export function playlistIdFromBrowseId(browseId: string | null | undefined): string | null {
  if (!browseId) return null
  const id = browseId.startsWith('VL') ? browseId.slice(2) : browseId
  return isPlaylistId(id) ? id : null
}

function notFound(kind: string): ProviderApiError {
  return new ProviderApiError(providerError('NOT_FOUND', `YouTube Music ${kind} not found`, { retryable: false }))
}

export function requireVideoId(value: string): string {
  if (!isVideoId(value)) throw notFound('track')
  return value
}

export function requireAlbumId(value: string): string {
  if (!isAlbumId(value)) throw notFound('album')
  return value
}

export function requireArtistId(value: string): string {
  if (!isArtistId(value)) throw notFound('artist')
  return value
}

export function requirePlaylistId(value: string): string {
  const id = playlistIdFromBrowseId(value)
  if (!id) throw notFound('playlist')
  return id
}

export const trackUrl = (videoId: string) => `${YTM_ORIGIN}/watch?v=${encodeURIComponent(videoId)}`
export const albumUrl = (browseId: string) => `${YTM_ORIGIN}/browse/${encodeURIComponent(browseId)}`
export const artistUrl = (channelId: string) => `${YTM_ORIGIN}/channel/${encodeURIComponent(channelId)}`
export const playlistUrl = (playlistId: string) => `${YTM_ORIGIN}/playlist?list=${encodeURIComponent(playlistId)}`
