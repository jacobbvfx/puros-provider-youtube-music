/**
 * YouTube Music protocol constants. Sources, recorded for review:
 * - SimpMusic (GPL-3.0) 244ffc9b9cf76eb7ff5e983d3cddff71de2878bb, core submodule
 *   0b9ce7b71a8b0e7b5d275351fa1e30611e59683e: endpoints, request bodies, search
 *   filter params, library browse IDs and cookie-based login. Only protocol facts
 *   are used; no SimpMusic code is copied.
 * - yt-dlp 2026.08.19 (Unlicense), `yt_dlp/extractor/youtube/_base.py`:
 *   WEB_REMIX client name/number/version and the SAPISID*HASH scheme.
 */

export const YTM_ORIGIN = 'https://music.youtube.com'
export const INNERTUBE_BASE_URL = `${YTM_ORIGIN}/youtubei/v1/`

export const WEB_REMIX_CLIENT = {
  name: 'WEB_REMIX',
  /** `INNERTUBE_CONTEXT_CLIENT_NAME` for web_music in yt-dlp. */
  number: 67,
  version: '1.20260707.12.00',
} as const

export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** Filtered search shelves (SimpMusic `YouTube.SearchFilter`). */
export const SEARCH_FILTER_PARAMS = {
  songs: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
  albums: 'EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D',
  artists: 'EgWKAQIgAWoKEAkQChAFEAMQBA%3D%3D',
  featuredPlaylists: 'EgeKAQQoADgBagwQDhAKEAMQBRAJEAQ%3D',
  communityPlaylists: 'EgeKAQQoAEABagoQAxAEEAoQCRAF',
} as const

export type SearchShelf = keyof typeof SEARCH_FILTER_PARAMS

/** Account library pages (browse IDs used by music.youtube.com and SimpMusic). */
export const LIBRARY_BROWSE_IDS = {
  songs: 'FEmusic_liked_videos',
  albums: 'FEmusic_liked_albums',
  artists: 'FEmusic_library_corpus_track_artists',
  playlists: 'FEmusic_liked_playlists',
} as const

/** "Liked Music", an auto playlist every signed-in account has. */
export const LIKED_MUSIC_PLAYLIST_ID = 'LM'

export const PROVIDER_LABEL = 'YouTube Music'
