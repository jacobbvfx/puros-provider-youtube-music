import fs from 'node:fs/promises'
import path from 'node:path'
import manifestJson from '../provider.manifest.json'
import {
  API_VERSION,
  ProviderApiError,
  providerError,
  type ProviderAuthLoginRequestV1,
  type ProviderAuthStatusV1,
  type ProviderHostV1,
  type ProviderLibraryRecordV1,
  type ProviderManifestV1,
  type ProviderPluginV1,
  type ProviderRuntimeV1,
  type ProviderStatusV1,
} from 'puros-provider-sdk'
import { YtmCatalog } from './catalog'
import { artistUrl } from './ids'
import { InnerTubeClient, notAuthenticated } from './innertube'
import { fetchLibrarySnapshot, pageRecords, snapshotRecords } from './library'
import { artworkUrl } from './parsers'
import { YtmPlaybackRuntime } from './playback'
import { YtmSessionService } from './session'

export const manifest = manifestJson as ProviderManifestV1

/** PyInstaller one-file extraction directories older than this belong to a dead yt-dlp run. */
const STALE_EXTRACTION_MS = 10 * 60_000

async function removeStaleExtractions(dataRoot: string): Promise<void> {
  const entries = await fs.readdir(dataRoot, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('_MEI')).map(async (entry) => {
    const directory = path.join(dataRoot, entry.name)
    const stat = await fs.stat(directory).catch(() => null)
    if (stat && Date.now() - stat.mtimeMs > STALE_EXTRACTION_MS) await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  }))
}

async function createRuntime(host: ProviderHostV1): Promise<ProviderRuntimeV1> {
  let active = true
  let session!: YtmSessionService
  const client = new InnerTubeClient({
    getCredentials: () => session.getCredentials(),
    onSessionRejected: () => session.markExpired(),
    onCookies: (setCookies, url, credentials) => session.absorbSetCookies(setCookies, url, credentials),
  })
  session = new YtmSessionService({ secrets: host.secrets, dataRoot: () => host.paths.getDataRoot(), client: () => client })
  await session.load()
  const catalog = new YtmCatalog(client, () => session.getCredentials() !== null)
  const playback = new YtmPlaybackRuntime({ host, session })
  let opusPlayable: boolean | null = null
  let librarySnapshot: { records: ProviderLibraryRecordV1[]; syncedAt: number } | null = null
  const sync = new AbortController()

  const ensureActive = () => {
    if (!active) throw new ProviderApiError(providerError('PROVIDER_UNAVAILABLE', 'YouTube Music provider is inactive', { retryable: true }))
  }

  const authStatus = (): ProviderAuthStatusV1 => {
    const current = session.status()
    return {
      authenticated: current.state === 'connected',
      accountLabel: current.account ? current.account.name : null,
      message: current.state === 'expired' ? 'Session expired — paste a new cookie' : null,
    }
  }

  const status = (): ProviderStatusV1 => {
    const current = session.status()
    const account = current.state === 'connected'
      ? `Connected as ${current.account!.name}${current.account!.handle ? ` (${current.account!.handle})` : ''}${current.identity ? ` · account/channel ${current.identity.index} of ${current.identity.count}` : ''}`
      : current.state === 'expired' ? 'Session expired — paste a new cookie' : 'Not connected'
    const playbackValue = opusPlayable === null
      ? 'Original AAC or Opus via yt-dlp'
      : opusPlayable ? 'Original Opus or AAC via yt-dlp (no transcoding)' : 'Original AAC via yt-dlp (this Mac cannot decode Ogg Opus)'
    return {
      state: active ? (current.state === 'expired' ? 'degraded' : 'ready') : 'inactive',
      authenticated: current.state === 'connected',
      updatedAt: Date.now(),
      ...(current.state === 'expired' ? { message: 'YouTube Music session expired' } : {}),
      values: { account, playback: playbackValue },
    }
  }

  const emitStatus = async () => {
    if (!active) return
    await host.events.emit({ type: 'auth.changed', status: authStatus() }).catch(() => {})
    await host.events.emit({ type: 'status.changed', status: status() }).catch(() => {})
  }
  session.onChange(() => { void emitStatus() })

  // Housekeeping and a background check of the restored session; neither blocks activation.
  void (async () => {
    const dataRoot = await host.paths.getDataRoot()
    await playback.cleanupStaleFiles().catch(() => {})
    if (!playback.busy()) await session.removeCookieFiles().catch(() => {})
    await removeStaleExtractions(dataRoot)
    opusPlayable = await host.cache.canPlayFormat('OPUS').catch(() => false)
    if (session.getCredentials()) {
      await client.request({ endpoint: 'account/account_menu', auth: 'required' }).catch((error) => {
        void host.logger.info('YouTube Music session check failed', {
          code: error instanceof ProviderApiError ? error.providerError.code : 'INTERNAL',
        }).catch(() => {})
      })
    }
    await emitStatus()
  })()

  return {
    capabilities: {
      auth: {
        async getStatus() { ensureActive(); return authStatus() },
        async login(request?: ProviderAuthLoginRequestV1) {
          ensureActive()
          if (request?.step === 'switch-identity') {
            await playback.cancelAll()
            librarySnapshot = null
            await session.switchIdentity()
            await emitStatus()
            return { status: authStatus() }
          }
          if (request?.form === 'connect' && request.values && typeof request.values === 'object') {
            await playback.cancelAll()
            librarySnapshot = null
            await session.importSession(request.values)
            await emitStatus()
            return { status: authStatus() }
          }
          throw new ProviderApiError(providerError('INVALID_ARGUMENT', 'Paste the Cookie header into "Connect with a cookie"', { retryable: false }))
        },
        async logout() {
          ensureActive()
          await playback.cancelAll()
          librarySnapshot = null
          await session.logout()
          await emitStatus()
        },
      },
      'catalog.search': {
        async search(request) { ensureActive(); return catalog.search(request) },
      },
      'catalog.entities': {
        async getArtist(sourceId) { ensureActive(); return catalog.getArtist(sourceId) },
        async getArtistBundle(sourceId) { ensureActive(); return catalog.getArtistBundle(sourceId) },
        async getAlbum(sourceId) { ensureActive(); return catalog.getAlbum(sourceId) },
        async getAlbumBundle(sourceId) { ensureActive(); return catalog.getAlbumBundle(sourceId) },
        async getTrack(sourceId) {
          ensureActive()
          const stored = await host.catalog.getStoredTrack(sourceId)
          if (stored) return stored
          return catalog.getTrack(sourceId)
        },
      },
      'catalog.home': {
        async getShelves(request) { ensureActive(); return catalog.getShelves(request?.cursor) },
        async getCollection(request) { ensureActive(); return catalog.getCollection(request) },
      },
      'library.sync': {
        async enumerate(request) {
          ensureActive()
          if (!session.getCredentials()) throw session.status().state === 'expired'
            ? new ProviderApiError(providerError('AUTH_EXPIRED', 'Your YouTube Music session has expired. Paste a new cookie in Settings → Accounts → YouTube Music.', { retryable: false }))
            : notAuthenticated()
          if (!request.cursor) {
            librarySnapshot = null
            const snapshot = await fetchLibrarySnapshot(client, async (processed, label) => {
              await host.events.emit({ type: 'library.sync.progress', processed, label }).catch(() => {})
            }, sync.signal, async ({ list, pages, parsed, skipped, layout }) => {
              const shapes = [...new Set(skipped.map((item) => `${item.renderer}|${item.pageType ?? '-'}|${item.idPrefix ?? '-'}`))].slice(0, 10)
              await host.logger.info('YouTube Music library list', { list, pages, parsed, skipped: skipped.length, shapes, layout }).catch(() => {})
            })
            librarySnapshot = { records: snapshotRecords(snapshot), syncedAt: Math.floor(Date.now() / 1000) }
          }
          if (!librarySnapshot) throw new ProviderApiError(providerError('INVALID_ARGUMENT', 'The YouTube Music library cursor has expired', { retryable: true }))
          const page = pageRecords(librarySnapshot.records, request.cursor ? Number(request.cursor) : 0, request.limit, librarySnapshot.syncedAt)
          await host.events.emit({
            type: 'library.sync.progress',
            processed: Number(page.nextCursor ?? librarySnapshot.records.length),
            total: librarySnapshot.records.length,
            label: 'Importing YouTube Music library',
          }).catch(() => {})
          if (page.complete) librarySnapshot = null
          return page
        },
      },
      playlists: {
        async list(request) { ensureActive(); return catalog.listLibraryPlaylists(request?.cursor) },
        async get(sourceId) { ensureActive(); return catalog.getPlaylistInfo(sourceId) },
        async getTracks(sourceId, request) { ensureActive(); return catalog.getPlaylistTracks(sourceId, request?.cursor) },
      },
      'playback.resolve': {
        async resolve(request) { ensureActive(); return playback.resolve(request) },
      },
      'playback.prefetch': {
        async prefetch(request) { ensureActive(); return playback.prefetch(request) },
      },
      'playback.progressive': {
        async markPlaybackStarted({ sessionId }) { ensureActive(); playback.markPlaybackStarted(sessionId) },
        async cancel({ sessionId }) { await playback.cancelSession(sessionId) },
      },
      'metadata.artwork': {
        async getDisplayArtworkUrl(url) { ensureActive(); return artworkUrl(url) },
        async getArtwork(ref) {
          ensureActive()
          const url = ref.entityType === 'artist' ? (await catalog.getArtist(ref.sourceId)).artworkUrl
            : ref.entityType === 'album' ? (await catalog.getAlbum(ref.sourceId)).artworkUrl
              : ref.entityType === 'playlist' ? (await catalog.getPlaylistInfo(ref.sourceId)).artworkUrl
                : (await catalog.getTrack(ref.sourceId)).artworkUrl
          return url ? { url } : null
        },
      },
      'metadata.bio': {
        async getBio(ref) {
          ensureActive()
          if (ref.entityType !== 'artist') return null
          const artist = await catalog.getArtist(ref.sourceId)
          return artist.bio ? { text: artist.bio, sourceUrl: artist.providerUrl ?? artistUrl(ref.sourceId) } : null
        },
      },
    },
    async getStatus() { return status() },
    async cancelSession(sessionId) { return playback.cancelSession(sessionId) },
    async deactivate() {
      active = false
      librarySnapshot = null
      sync.abort()
      await playback.shutdown()
      await session.flush().catch(() => {})
      await session.removeCookieFiles().catch(() => {})
    },
  }
}

const plugin: ProviderPluginV1 = {
  apiVersion: API_VERSION,
  manifest,
  async activate(host) {
    await host.logger.info('YouTube Music plugin activated')
    return createRuntime(host)
  },
}

export default plugin
