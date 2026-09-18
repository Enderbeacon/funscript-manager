import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { AppError } from '@shared/errors'
import { normalizePastedUrl } from '@shared/url'
import { BUILT_IN_SOURCE_ID } from '@shared/schemas/app-config'
import { broadcast, handle } from './register'
import * as config from '../services/config/config-service'
import * as libraryManager from '../services/library/library-manager'
import { libraryEvents } from '../services/library/library-manager'
import * as lifecycle from '../services/library/media-lifecycle'
import * as playlists from '../services/library/playlists'
import { checkLinks } from '../services/downloaders/link-check'
import * as downloads from '../services/downloaders/queue'
import {
  pairingRequests,
  resolvePairing,
  unfetchableLinks
} from '../services/downloaders/post-ingest'
import { downloadEvents } from '../services/downloaders/queue'
import * as deps from '../services/deps/binaries'
import * as megacmd from '../services/megacmd/megacmd'
import { depsEvents } from '../services/deps/binaries'
import * as updater from '../services/updates/updater'
import { updateEvents } from '../services/updates/updater'
import { knownReleases, releaseEvents } from '../services/updates/releases'
import * as notices from '../services/updates/notices'
import * as scraper from '../services/scraper/discourse'
import { pastedLink } from '../services/scraper/post-parser'
import { findPostForMedia } from '../services/matcher/match-service'
import { videoAuthorFromTitle } from '../services/matcher/author'
import {
  dropCandidate,
  getCandidate,
  listQueue,
  queueCounts,
  settleEntry
} from '../services/matcher/match-store'
import {
  pauseScan,
  resumeScan,
  scanEvents,
  scanStatus,
  startScan,
  stopScan
} from '../services/matcher/scan-service'
import * as playback from '../services/playback/playback-service'
import {
  mediaSourceEvents,
  mediaSourceStatus,
  releaseSource
} from '../services/playback/sources/registry'
import {
  claimVideoSurface,
  releaseVideoSurface,
  reportVideoState,
  setVideoIntent,
  videoIntent,
  videoSurfaceEvents
} from '../services/playback/internal/surface'
import { routeVideo } from '../services/playback/internal/route'
import { closeStream, openStream, readStream } from '../services/playback/internal/stream'
import {
  isMainWindowOpen,
  rememberCloseChoice,
  resolveMainWindowClose,
  showMainWindow
} from '../services/main-window'
import * as startup from '../services/startup/startup'
import { markWindowReady } from '../services/startup/startup'
import { startupStatus } from '../services/startup/splash-window'
import { loadStartupArtwork } from '../services/startup/artwork'
import {
  artworkPoolEvents,
  artworkSelectionKey,
  clearUnusedStartupArtwork,
  scheduleStartupArtworkPreparation,
  startupArtworkCacheStatus
} from '../services/startup/artwork-pool'
import {
  listSubtitleTracks,
  loadSubtitleCues,
  pickedTrack,
  rememberSubtitleChoice
} from '../services/playback/subtitles'
import {
  attachVideoPlayerWindow,
  detachVideoPlayerWindow,
  isVideoPlayerDetached,
  onVideoPlayerSurfaceChanged
} from '../services/playback/internal/player-window'
import { playbackEvents } from '../services/playback/playback-service'
import * as queue from '../services/playback/queue'
import { queueEvents } from '../services/playback/queue'
import {
  connStatusEvents,
  pokeConnStatus,
  sampleConnStatus
} from '../services/playback/conn-status'
import { detectMfpExecutablePath, ensureMfp, restartMfp } from '../services/playback/mfp'
import { installPlugin, pluginStatus } from '../services/playback/mfp-bridge'
import { playbackSessionDir } from '../services/playback/playback-session'
import * as metadata from '../services/library/metadata'
import { loadQueue, saveQueue } from '../services/taxonomy/organise-queue-store'
import * as taxonomy from '../services/taxonomy/taxonomy-service'
import {
  ENTITY_KINDS,
  type Entity,
  type EntityKind,
  type FilterNode
} from '@shared/schemas/taxonomy'
import { applyProxySettings } from '../services/net/proxy'
import { listSites, openSiteLogin, signOutSite } from '../services/sites/site-login'
import { registerScriptPlayerHandlers } from '@script-player/interface/ipc/register'
import { configureScriptPlayer } from '@script-player/composition/session'

/**
 * The taxonomy as the UI needs it: tree order, with a count on every row and
 * a second count that includes everything underneath. Both are computed here
 * rather than in the renderer, because only the main side has the index.
 */
interface TaxonomyRow {
  name: string
  parent: string | null
  /** Sort key inside the parent; what pinning a playlist sets. */
  order: number | null
  aliases: string[]
  description: string | null
  image: string | null
  depth: number
  count: number
  countWithDescendants: number
}

/**
 * The taxonomy's own entries plus any name media carry that it has never been
 * told about. Added flat and at the end: an unregistered name has no parent and
 * no aliases by definition, and the ones the user has arranged stay where they
 * put them.
 */
function withNamesInUse(entities: Entity[], inUse: string[]): Entity[] {
  const known = new Set(entities.map((e) => e.name.toLowerCase()))
  const extra = inUse
    .filter((name) => name && !known.has(name.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, aliases: [] }) as Entity)
  return extra.length === 0 ? entities : [...entities, ...extra]
}

async function taxonomyProjection(): Promise<{
  entities: Record<EntityKind, TaxonomyRow[]>
  savedFilters: { id: string; name: string; filter: FilterNode }[]
}> {
  const file = await taxonomy.getTaxonomy()
  const counts = libraryManager.nameCounts()
  const entities = {} as Record<EntityKind, TaxonomyRow[]>

  for (const kind of ENTITY_KINDS) {
    const perName = counts[kind] ?? {}
    // A name a media carries is part of the vocabulary whether or not
    // taxonomy.json has heard of it. Tags written straight into a sidecar —
    // by the post ingest, or by the user editing the file in an editor, which
    // is a supported way to change metadata — were invisible in the sidebar
    // until something else happened to register them, so the library and the
    // filter list disagreed about what tags exist.
    const list = withNamesInUse(file.entities[kind], Object.keys(perName))
    const countOf = (entity: Entity): number =>
      taxonomy
        .withDescendants(list, entity.name)
        .reduce((sum, name) => sum + (perName[name] ?? 0), 0)

    entities[kind] = taxonomy.orderTree(list).map(({ entity, depth }) => ({
      name: entity.name,
      parent: entity.parent ?? null,
      order: entity.order ?? null,
      aliases: entity.aliases,
      description: entity.description ?? null,
      image: entity.image ?? null,
      depth,
      count: perName[entity.name] ?? 0,
      countWithDescendants: countOf(entity)
    }))
  }

  return {
    entities,
    savedFilters: file.savedFilters.map((f) => ({
      id: f.id,
      name: f.name,
      filter: f.filter as FilterNode
    }))
  }
}

/** Register all IPC handlers. Called once before app ready. */
export function registerIpcHandlers(): void {
  registerScriptPlayerHandlers()
  handle('app:getInfo', () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    userDataPath: app.getPath('userData')
  }))

  handle('app:readLicense', async ({ which }) => {
    // A packaged copy has both beside the executable, where they stay readable
    // without the app. A development run has the license at the project root
    // and the generated list beside the main bundle.
    const path = app.isPackaged
      ? join(dirname(process.execPath), which === 'app' ? 'LICENSE.txt' : 'THIRD_PARTY_LICENSES.txt')
      : which === 'app'
        ? join(app.getAppPath(), 'LICENSE')
        : join(__dirname, 'THIRD_PARTY_LICENSES.txt')
    try {
      return { text: await readFile(path, 'utf8') }
    } catch (e) {
      console.warn('[about] license file unreadable:', path, e)
      throw new AppError('license_unavailable')
    }
  })

  handle('app:startupStatus', () => startupStatus())

  handle('app:startupArtwork', async ({ purpose }) => {
    const { ui } = await config.getSettings()
    const libraries = ui.startupArtwork.mode === 'library' ? await config.listLibraries() : []
    return {
      ...(await loadStartupArtwork(ui, libraries, purpose)),
      blur: ui.sfw && ui.startupArtwork.mode === 'library'
    }
  })

  handle('app:startupArtworkCacheStatus', async () => {
    const [{ ui }, libraries] = await Promise.all([config.getSettings(), config.listLibraries()])
    return startupArtworkCacheStatus(ui, libraries)
  })

  handle('app:startupArtworkClearUnused', async () => {
    const [{ ui }, libraries] = await Promise.all([config.getSettings(), config.listLibraries()])
    return clearUnusedStartupArtwork(ui, libraries)
  })

  handle('app:startupCancel', () => {
    // The card is the only window at this point, but the main window may
    // already be loading behind it — leaving means leaving both.
    app.quit()
  })

  handle('app:windowReady', () => markWindowReady())

  handle('dialog:pickDirectory', async (input) => {
    const result = await dialog.showOpenDialog({
      title: input.title,
      properties: ['openDirectory']
    })
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
  })

  handle('dialog:pickFile', async (input) => {
    const result = await dialog.showOpenDialog({
      title: input.title,
      properties: ['openFile'],
      filters: [{ name: 'Programs', extensions: ['exe'] }]
    })
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
  })

  handle('dialog:pickScripts', async (input) => {
    const result = await dialog.showOpenDialog({
      title: input.title,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Funscript', extensions: ['funscript'] }]
    })
    return { paths: result.canceled ? [] : result.filePaths }
  })

  handle('dialog:pickImage', async (input) => {
    const result = await dialog.showOpenDialog({
      title: input.title,
      properties: ['openFile'],
      filters: [{ name: 'Image', extensions: [...taxonomy.IMAGE_EXTENSIONS, ...(input.svg ? ['svg'] : [])] }]
    })
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
  })

  handle('app:setTitleBarColors', ({ color, symbolColor }) => {
    const win = BrowserWindow.getAllWindows()[0]
    // Only windows created with a title-bar overlay have one to set; a build
    // without it must not turn a colour change into an error dialog.
    try {
      win?.setTitleBarOverlay?.({ color, symbolColor })
    } catch {
      /* platform without overlay support */
    }
  })

  handle('app:openSettings', async (request) => {
    // A detached player can ask for this, and with the main window closed
    // there is nothing to navigate yet — so it is brought back first, and the
    // event follows once someone is there to hear it.
    await showMainWindow()
    broadcast('event:open-settings', request)
  })

  handle('app:mainWindowOpen', () => ({ open: isMainWindowOpen() }))

  handle('app:showMainWindow', () => showMainWindow())

  handle('app:closeMainWindow', async ({ closePlayers, remember }) => {
    if (remember) {
      const choice = closePlayers ? 'closePlayers' : 'keepPlayers'
      await config.updateSettings({ ui: { onCloseMainWindow: choice } })
      rememberCloseChoice(choice)
    }
    resolveMainWindowClose(closePlayers)
  })

  handle('library:list', () => config.listLibraries())

  handle('library:whenReady', () => libraryManager.librariesReady())

  handle('library:add', async (input) => {
    const library = await config.addLibrary(input.rootPath, input.name)
    const libraries = await config.listLibraries()
    broadcast('event:libraries-changed', { libraries })
    // Fire-and-forget: first scan can be long; progress arrives via events.
    void libraryManager
      .startLibrary(library)
      .then(async () => {
        const settings = await config.getSettings()
        scheduleStartupArtworkPreparation(settings.ui, await config.listLibraries())
      })
      .catch((e) => console.error(`[library] start failed for ${library.rootPath}:`, e))
    return library
  })

  handle('library:remove', async (input) => {
    await libraryManager.stopLibrary(input.id)
    await config.removeLibrary(input.id)
    const libraries = await config.listLibraries()
    broadcast('event:libraries-changed', { libraries })
    scheduleStartupArtworkPreparation((await config.getSettings()).ui, libraries)
  })

  handle('library:sync', async (input) => {
    await libraryManager.requestSync(input.id)
  })

  handle('library:addWanted', ({ libraryId, post }) =>
    libraryManager.addWantedMedia(libraryId, {
      title: post.title,
      tags: post.tags,
      postUrl: post.postUrl,
      ...(post.author ? { author: post.author } : {}),
      // Only the links we cannot fetch are worth keeping here: they are the
      // reason the entry exists, and the rest would have been downloaded.
      sources: post.links
        .filter((l) => !l.downloadable)
        .map((l) => ({ url: l.url, hoster: l.hoster, label: l.note || l.label }))
    })
  )

  handle('library:attachWanted', ({ libraryId, mediaId, sourcePath }) =>
    libraryManager.attachWantedFile(libraryId, mediaId, sourcePath)
  )

  handle('library:wantedMatches', async ({ libraryId, mediaId }) => ({
    matches: await libraryManager.findWantedMatches(libraryId, mediaId)
  }))

  handle('library:linkWanted', ({ libraryId, mediaId, candidateId }) =>
    libraryManager.linkWantedTo(libraryId, mediaId, candidateId)
  )

  handle('library:mergeWanted', ({ libraryId, targetId, sourceIds }) =>
    libraryManager.mergeWantedInto(libraryId, targetId, sourceIds)
  )

  handle('library:previewMerge', ({ libraryId, targetId, sourceIds }) =>
    libraryManager.previewMerge(libraryId, targetId, sourceIds)
  )

  handle('library:dismissWantedMatch', ({ libraryId, mediaId, candidateId }) =>
    libraryManager.dismissWantedMatch(libraryId, mediaId, candidateId)
  )

  handle('library:listIgnored', ({ libraryId }) => ({
    entries: lifecycle.listIgnored(libraryId)
  }))

  handle('library:folders', ({ libraryId }) => ({
    folders: lifecycle.libraryFolders(libraryId)
  }))

  handle('library:removeFolder', async ({ libraryId, folder }) => ({
    removed: (await lifecycle.removeFolder(libraryId, folder)).removed
  }))

  handle('library:restoreIgnored', async ({ libraryId, id }) => ({
    restored: await lifecycle.restoreIgnored(libraryId, id)
  }))

  handle('library:clearIgnored', ({ libraryId }) => lifecycle.clearIgnored(libraryId))

  handle('match:findPost', ({ libraryId, mediaId, query }) =>
    findPostForMedia(libraryId, mediaId, query)
  )

  handle('match:start', ({ libraryIds, rescan }) => {
    // Fire-and-forget: a pass over a library runs for hours and reports through
    // `event:match-progress`. Awaiting it here would hold an IPC call open for
    // the whole run.
    void startScan({ libraryIds, rescan }).catch((e) => console.error('[match] scan failed:', e))
  })

  handle('match:pause', () => pauseScan())
  handle('match:resume', () => resumeScan())
  handle('match:stop', () => stopScan())
  handle('match:status', () => scanStatus())

  handle('match:queue', ({ limit, offset }) => ({
    items: listQueue(limit, offset).map((entry) => ({
      libraryId: entry.libraryId,
      mediaId: entry.mediaId,
      filePath: entry.filePath,
      fileName: entry.filePath.split('/').pop() ?? entry.filePath,
      candidates: entry.candidates
    })),
    queued: queueCounts().queued
  }))

  handle('match:reject', async ({ libraryId, mediaId, topicId }) => {
    // The sidecar first: the queue is a cache and this is a judgement, so it
    // has to survive the queue being thrown away.
    await libraryManager.setPostMatchState(libraryId, mediaId, { dismiss: topicId })
    return { candidatesLeft: dropCandidate(libraryId, mediaId, topicId) }
  })

  handle('match:settle', async ({ libraryId, mediaId }) => {
    await libraryManager.setPostMatchState(libraryId, mediaId, {})
    settleEntry(libraryId, mediaId, 'none')
  })

  handle('match:apply', async ({ libraryId, mediaId, topicId }) => {
    const candidate = getCandidate(libraryId, mediaId, topicId)
    if (!candidate) throw new AppError('scrape_post_not_found', { topicId: String(topicId) })

    const { applied } = await libraryManager.applyPostMetadata(
      libraryId,
      mediaId,
      {
        title: candidate.title,
        tags: candidate.tags,
        postUrl: candidate.url,
        author: candidate.author,
        videoAuthor: videoAuthorFromTitle(candidate.title, candidate.tags)
      },
      // The user said this post IS the entry, so its title is the answer to
      // what the scene is called.
      true
    )
    await libraryManager.setPostMatchState(libraryId, mediaId, {})
    settleEntry(libraryId, mediaId, 'applied')
    return {
      postTitle: candidate.title,
      tagsAdded: applied.tagsAdded,
      videoAuthorsAdded: applied.videoAuthorsAdded,
      titleSet: applied.titleSet
    }
  })

  handle('media:applyPostLink', async ({ targets, postUrl, setTitle }) => {
    // One fetch for the whole selection: the forum is asked at one request a
    // second, and the same post applied to five media must not mean five reads.
    const post = await scraper.fetchPost(normalizePastedUrl(postUrl))
    const meta = {
      title: post.title,
      tags: post.tags,
      postUrl: post.postUrl,
      author: post.author,
      // The animator, when the title credits one plainly. Registered as a name
      // like any other, so an author the library already knows is matched
      // rather than duplicated.
      videoAuthor: videoAuthorFromTitle(post.title, post.tags),
      otherLinks: unfetchableLinks(post)
    }

    const tags = new Set<string>()
    const authors = new Set<string>()
    const videoAuthors = new Set<string>()
    const failed: { mediaId: string; reason: string }[] = []
    let applied = 0
    let titlesSet = 0
    let linksAdded = 0

    for (const target of targets) {
      try {
        const result = await libraryManager.applyPostMetadata(
          target.libraryId,
          target.mediaId,
          meta,
          setTitle === true
        )
        applied += 1
        for (const name of result.applied.tagsAdded) tags.add(name)
        for (const name of result.applied.scriptAuthorsAdded) authors.add(name)
        for (const name of result.applied.videoAuthorsAdded) videoAuthors.add(name)
        if (result.applied.titleSet) titlesSet += 1
        linksAdded += result.applied.linksAdded
      } catch (e) {
        failed.push({ mediaId: target.mediaId, reason: String((e as Error)?.message ?? e) })
      }
    }

    return {
      postTitle: post.title,
      applied,
      tagsAdded: [...tags],
      scriptAuthorsAdded: [...authors],
      videoAuthorsAdded: [...videoAuthors],
      titlesSet,
      linksAdded,
      failed
    }
  })

  handle('media:planDelete', ({ libraryId, mediaIds, mode }) =>
    lifecycle.planDelete(libraryId, mediaIds, mode)
  )

  handle('media:delete', ({ libraryId, mediaIds, mode, keepScripts }) =>
    lifecycle.deleteMedia(libraryId, mediaIds, { mode, keepScripts })
  )

  handle('media:planRename', ({ libraryId, mediaId, newName, renameCompanions }) =>
    lifecycle.planRename(libraryId, mediaId, newName, renameCompanions)
  )

  handle('media:rename', ({ libraryId, mediaId, newName, renameCompanions }) =>
    lifecycle.renameMedia(libraryId, mediaId, newName, renameCompanions)
  )

  handle('media:list', async (input) => {
    try {
      return libraryManager.listMedia({
        libraryId: input.libraryId,
        offset: input.offset,
        limit: input.limit,
        search: input.search,
        // A parent tag stands for everything under it; the compiler matches
        // names literally, so the tree is resolved here.
        filter: await taxonomy.expandFilter(input.filter),
        sort: input.sort,
        playlistOrder: input.playlistOrder
      })
    } catch (e) {
      // Startup race: the renderer may query before the library's first sync
      // has opened its index. An empty page is correct — `event:media-changed`
      // triggers a refetch once the sync lands.
      if (e instanceof AppError && e.code === 'library_not_found') {
        return { items: [], total: 0 }
      }
      throw e
    }
  })

  handle('playlist:add', ({ targets, name }) => playlists.addToPlaylist(targets, name))
  handle('playlist:remove', ({ targets, name }) => playlists.removeFromPlaylist(targets, name))
  handle('playlist:duplicate', ({ from, to }) => playlists.duplicatePlaylist(from, to))

  handle('playlist:exportM3u', async ({ name }) => {
    const tracks = playlists.playlistPaths(name)
    const picked = await dialog.showSaveDialog({
      defaultPath: `${name.replace(/[\\/:*?"<>|]/g, '_')}.m3u`,
      filters: [{ name: 'M3U', extensions: ['m3u', 'm3u8'] }]
    })
    if (picked.canceled || !picked.filePath) return { path: null, tracks: 0 }
    /*
     * Extended m3u, with the media id in a comment beside each path. Other
     * players ignore lines they do not know, and it means a file that has since
     * been renamed can still be recognised on the way back in.
     */
    const lines = ['#EXTM3U']
    for (const track of tracks) {
      lines.push(`#FSM-ID:${track.mediaId}`, track.path)
    }
    await writeFile(picked.filePath, `${lines.join('\r\n')}\r\n`, 'utf8')
    return { path: picked.filePath, tracks: tracks.length }
  })

  handle('playlist:move', async ({ libraryId, mediaId, name, afterMediaId }) => {
    const ordered = await playlists.movePlaylistItem({ libraryId, mediaId }, name, afterMediaId)
    return { ordered: ordered.length }
  })

  handle('media:getHeatmap', async (input) => {
    try {
      return {
        dataUrl: await libraryManager.getHeatmap(input.libraryId, input.mediaId, input.scriptVersionId)
      }
    } catch (e) {
      // Same startup race as media:list — no heatmap yet is a valid answer.
      if (e instanceof AppError && e.code === 'library_not_found') {
        return { dataUrl: null }
      }
      throw e
    }
  })

  handle('media:getThumbnail', async (input) => {
    try {
      return { dataUrl: await libraryManager.getThumbnail(input.libraryId, input.mediaId) }
    } catch (e) {
      if (e instanceof AppError && e.code === 'library_not_found') {
        return { dataUrl: null }
      }
      throw e
    }
  })

  handle('media:get', async (input) => {
    try {
      return await libraryManager.getMediaDetail(input.libraryId, input.mediaId)
    } catch (e) {
      // Startup race: library not started yet — no detail is a valid answer.
      if (e instanceof AppError && e.code === 'library_not_found') return null
      throw e
    }
  })

  handle('media:setDefaultScriptVersion', (input) =>
    libraryManager.setDefaultScriptVersion(input.libraryId, input.mediaId, input.scriptVersionId)
  )

  handle('media:setVersionInheritAxes', (input) =>
    libraryManager.setVersionInheritAxes(
      input.libraryId,
      input.mediaId,
      input.scriptVersionId,
      input.inherit
    )
  )

  handle('media:updateScriptVersion', (input) =>
    libraryManager.updateScriptVersion(input.libraryId, input.mediaId, input.scriptVersionId, {
      name: input.name,
      author: input.author,
      sourceUrl: input.sourceUrl,
      notes: input.notes,
      axisAssignments: input.axisAssignments
    })
  )

  handle('media:mergeScriptVersions', (input) =>
    libraryManager.mergeScriptVersions(
      input.libraryId,
      input.mediaId,
      input.sourceVersionId,
      input.targetVersionId,
      input.axisAssignments
    )
  )

  handle('media:autoRepairScriptVersions', (input) =>
    libraryManager.autoRepairScriptVersions(input.libraryId, input.mediaId)
  )

  handle('media:addScriptVersion', (input) =>
    libraryManager.addScriptVersion(input.libraryId, input.mediaId, {
      name: input.name,
      author: input.author,
      sourceUrl: input.sourceUrl,
      notes: input.notes,
      files: input.files
    })
  )

  handle('media:deleteScriptVersion', (input) =>
    libraryManager.deleteScriptVersion(input.libraryId, input.mediaId, input.scriptVersionId)
  )

  handle('playback:play', async (input) => {
    const loc = libraryManager.getMediaLocation(input.libraryId, input.mediaId)
    // Playing something that is not what the queue is on replaces the queue:
    // the bar must never describe a list the user has walked away from.
    queue.notePlayed({ libraryId: input.libraryId, mediaId: input.mediaId })
    return playback.play({
      libraryRoot: loc.libraryRoot,
      mediaRelPath: loc.mediaRelPath,
      libraryId: input.libraryId,
      mediaId: input.mediaId,
      scriptVersionId: input.scriptVersionId,
      noScript: input.noScript,
      resumePosition: input.resumePosition
    })
  })

  handle('media:listByIds', ({ targets }) => ({ items: libraryManager.mediaByIds(targets) }))

  handle('queue:get', () => queue.snapshot())
  handle('queue:start', ({ source, items, at }) => queue.start(source, items, at))
  handle('queue:add', ({ items, mode, afterMediaId }) =>
    queue.add(items, mode, afterMediaId === undefined ? undefined : afterMediaId)
  )
  handle('queue:remove', ({ items }) => queue.remove(items))
  handle('queue:move', ({ mediaId, afterMediaId }) => queue.move(mediaId, afterMediaId))
  handle('queue:clear', () => queue.clear())
  /*
   * Keeping a queue is one action, not two: creating the list and filling it
   * from the renderer leaves an empty playlist behind whenever the second call
   * is the one that fails.
   */
  handle('queue:saveAsPlaylist', async ({ name }) => {
    const made = await taxonomy.createEntity('playlists', name)
    const { added } = await playlists.addToPlaylist(queue.snapshot().items, made.name)
    return { name: made.name, added }
  })
  handle('queue:resume', async () => ({ moved: await queue.resume() }))
  handle('queue:next', async () => ({ moved: await queue.next() }))
  handle('queue:previous', async () => ({ moved: await queue.previous() }))
  handle('queue:playAt', ({ index }) => queue.playAt(index))
  handle('queue:setMode', ({ shuffle, repeat }) => {
    if (shuffle !== undefined) queue.setShuffle(shuffle)
    return repeat !== undefined ? queue.setRepeat(repeat) : queue.snapshot()
  })

  handle('playback:setPaused', (input) => playback.setPaused(input.paused))

  handle('playback:seek', (input) => playback.seek(input.positionMs))

  handle('playback:setVolume', (input) => playback.setVolume(input.volume))

  handle('playback:status', () => playback.status())

  handle('playback:connStatus', () => sampleConnStatus())

  handle('playback:sources', () => mediaSourceStatus())

  /*
   * The built-in picture. Everything about *what* is playing goes through
   * `playback:*` like any other player; these carry only where the picture is
   * and what it sees.
   */
  handle('video:intent', () => videoIntent())
  handle('video:claim', (_input, sender) => claimVideoSurface(sender))
  handle('video:release', (_input, sender) => {
    releaseVideoSurface(sender)
  })
  handle('video:report', (report, sender) => {
    reportVideoState(report, sender)
  })
  handle('video:close', async () => {
    // The picture *is* the player here, so closing it is letting go of the
    // player. Not a stop — playback has none, only pause, because stopping
    // mpv unloads the file and an mpv started without --idle quits on it —
    // and not a lost connection either, which is why it goes through release.
    await releaseSource(BUILT_IN_SOURCE_ID)
  })
  handle('video:detach', () => ({ detached: detachVideoPlayerWindow() }))
  handle('video:attach', () => ({ detached: attachVideoPlayerWindow() }))
  handle('video:surface', () => ({ detached: isVideoPlayerDetached() }))

  handle('video:route', ({ path, hevc, fallback }) => routeVideo(path, { hevc, fallback }))
  handle('video:streamOpen', async (input, sender) => ({ id: await openStream(sender, input) }))
  handle('video:streamRead', async ({ id }, sender) => ({ chunk: await readStream(sender, id) }))
  handle('video:streamClose', ({ id }, sender) => {
    closeStream(sender, id)
  })

  handle('video:subtitleTracks', async ({ path }) => ({
    tracks: await listSubtitleTracks(path)
  }))
  handle('video:subtitleCues', async ({ track }) => ({ cues: await loadSubtitleCues(track) }))
  handle('video:setSubtitle', async ({ track }) => {
    setVideoIntent({ subtitle: track, subtitleOffsetMs: 0 })
    // Remembered here rather than in the renderer: the next video's subtitle
    // is chosen while it loads, which is main-process work, and both sides
    // reading the same setting is one place fewer for them to disagree.
    await rememberSubtitleChoice(track)
  })
  handle('video:setSubtitleOffset', ({ offsetMs }) => {
    setVideoIntent({ subtitleOffsetMs: offsetMs })
  })
  handle('video:pickSubtitleFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt', 'ass', 'ssa'] }]
    })
    const path = result.canceled ? null : (result.filePaths[0] ?? null)
    return { track: path ? pickedTrack(path) : null }
  })

  handle('playback:setCurrentSource', async ({ id }) => {
    await config.updateSettings({ playback: { currentSourceId: id } })
    await playback.switchPlayer(id)
    return mediaSourceStatus()
  })

  handle('playback:launchMfp', async () => {
    const settings = await config.getSettings()
    const status = await ensureMfp(settings.playback.mfpExePath)
    pokeConnStatus()
    return { status }
  })

  handle('playback:detectMfp', async () => ({ path: await detectMfpExecutablePath() }))

  handle('playback:restartMfp', async () => {
    const settings = await config.getSettings()
    const status = await restartMfp(settings.playback.mfpExePath)
    pokeConnStatus()
    return { status }
  })

  handle('playback:sessionDirs', async () => {
    const libs = await config.listLibraries()
    return libs.map((l) => ({
      libraryId: l.id,
      name: l.name,
      path: playbackSessionDir(l.rootPath)
    }))
  })

  handle('playback:mfpPluginStatus', async () => {
    const settings = await config.getSettings()
    return pluginStatus(settings.playback.mfpExePath)
  })

  handle('playback:installMfpPlugin', async (input) => {
    const settings = await config.getSettings()
    const res = await installPlugin(input.mfpExePath || settings.playback.mfpExePath)
    return { ok: res.ok, pluginPath: res.pluginPath, reason: res.reason }
  })

  handle('download:list', () => ({ jobs: downloads.listJobs() }))

  handle('download:add', async (input) => ({
    jobIds: await downloads.addJobs(normalizePastedUrl(input.url), input.libraryId, {
      ...(input.fileName ? { name: { value: input.fileName, pinned: true } } : {}),
      ...(input.mediaId ? { mediaId: input.mediaId } : {})
    })
  }))

  handle('download:addFromPost', (input) =>
    downloads.addPostJobs(input.libraryId, input.post, input.urls, input.manualLinks)
  )

  handle('download:pause', (input) => downloads.pauseJob(input.id))

  handle('download:resume', (input) => downloads.resumeJob(input.id))

  handle('download:retry', (input) => downloads.retryJob(input.id))

  handle('download:cancel', (input) => downloads.cancelJob(input.id))

  handle('download:clearFinished', () => downloads.clearFinished())

  handle('download:verify', ({ id, hints }) => {
    void downloads.verifyJob(id, hints).catch((e) => console.error('[downloads] verify failed:', e))
  })

  handle('download:pairings', () => ({ requests: pairingRequests() }))

  handle('download:resolvePairing', async ({ batchId, assignments }) => {
    await resolvePairing(batchId, assignments)
    downloadEvents.emit('jobs-changed')
  })

  handle('download:checkLinks', (input) => checkLinks(input.urls, { force: input.force ?? false }))

  handle('megacmd:status', () => megacmd.status())
  handle('megacmd:install', () => megacmd.install())
  handle('megacmd:login', () => megacmd.openLogin())

  handle('deps:status', async () => ({ binaries: await deps.status() }))

  handle('deps:missing', async () => ({ ids: await deps.missing() }))

  handle('deps:install', async (input) => ({ binary: await deps.install(input.id) }))

  handle('updates:state', () => updater.updateState())

  handle('updates:check', async () => {
    await updater.checkForUpdates('manual')
    return updater.updateState()
  })

  handle('updates:download', async () => {
    await updater.downloadUpdate()
    return updater.updateState()
  })

  handle('updates:releases', () => knownReleases())

  handle('updates:install', async ({ version }) => {
    await updater.installRelease(version)
    return updater.updateState()
  })

  handle('updates:restart', () => updater.restartToUpdate())

  handle('updates:skip', async ({ version }) => {
    await config.updateSettings({ updates: { skippedVersion: version } })
  })

  handle('updates:startupNotices', () => notices.startupNotices())

  handle('updates:takePrompt', async () => {
    await startup.greetingSettled()
    return { offer: updater.takePrompt() }
  })

  handle('updates:dismissWhatsNew', () => notices.dismissWhatsNew())

  handle('updates:dismissAnnouncement', ({ id }) => notices.dismissAnnouncement(id))

  handle('scrape:isPostUrl', (input) => ({
    isPost: scraper.isPostUrl(normalizePastedUrl(input.url))
  }))

  handle('scrape:describeLink', (input) => pastedLink(normalizePastedUrl(input.url)))

  handle('scrape:parsePost', (input) =>
    scraper.fetchPost(normalizePastedUrl(input.url), (postsRead, postsTotal) =>
      broadcast('event:scrape-progress', { postsRead, postsTotal })
    )
  )

  handle('scrape:checkExisting', (input) => {
    const found = libraryManager.findBySourceUrl(normalizePastedUrl(input.postUrl))
    return {
      existing: found
        ? { libraryId: found.libraryId, mediaId: found.mediaId, filePath: found.filePath }
        : null
    }
  })

  handle('scrape:remoteImage', async ({ url }) => ({ dataUrl: await scraper.fetchRemoteImage(url) }))

  handle('scrape:loginStatus', async () => ({ loggedIn: await scraper.isLoggedIn() }))

  handle('scrape:login', () => scraper.openLogin())

  handle('scrape:logout', () => scraper.logout())

  handle('media:matchingIds', async (input) => ({
    targets: libraryManager.matchingTargets({
      ...input,
      filter: await taxonomy.expandFilter(input.filter)
    })
  }))

  handle('media:viewTargets', async (input) =>
    libraryManager.viewTargets({ ...input, filter: await taxonomy.expandFilter(input.filter) })
  )

  handle('media:reveal', ({ libraryId, mediaId }) => {
    const { libraryRoot, mediaRelPath } = libraryManager.getMediaLocation(libraryId, mediaId)
    const abs = join(libraryRoot, ...mediaRelPath.split('/'))
    if (existsSync(abs)) {
      shell.showItemInFolder(abs)
      return
    }
    // A placeholder or a moved file has nothing to select, and Explorer given a
    // path that is not there opens somewhere unrelated. Walk up to the nearest
    // folder that does exist so the recorded location stays checkable.
    let dir = dirname(abs)
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
    void shell.openPath(dir)
  })

  handle('media:setNames', ({ libraryId, mediaId, field, names }) =>
    metadata.setNames({ libraryId, mediaId }, field, names)
  )

  handle('media:setUserMeta', ({ libraryId, mediaId, ...patch }) =>
    metadata.setUserMeta({ libraryId, mediaId }, patch)
  )

  handle('media:setSources', ({ libraryId, mediaId, sources }) =>
    metadata.setSources({ libraryId, mediaId }, sources)
  )

  handle('media:batchEdit', ({ targets, edit }) => metadata.applyBatch(targets, edit))

  handle('taxonomy:get', () => taxonomyProjection())

  handle('taxonomy:create', async ({ kind, name, parent }) => {
    await taxonomy.createEntity(kind, name, parent)
  })

  // The three below hold the taxonomy lock across both halves of their work.
  // Half a rename — the tree says the new name, the sidecars still say the old
  // one — is a state anything reading in between would take as the truth.
  // The tree lists names that only exist in sidecars alongside the registered
  // ones, because that is what the vocabulary is. Editing one has to register
  // it first, or the row the user is looking at answers "no such entry".
  handle('taxonomy:update', ({ kind, name, patch }) =>
    taxonomy.withTaxonomyLock(async () => {
      await taxonomy.ensureEntities(kind, [name])
      const { renamedFrom } = await taxonomy.updateEntity(kind, name, patch)
      // Sidecars carry names, so a rename is not done until they say the new one.
      const mediaRewritten = renamedFrom
        ? await metadata.rewriteName(kind, renamedFrom, patch.name!.trim())
        : 0
      return { mediaRewritten }
    })
  )

  handle('taxonomy:delete', ({ kind, name }) =>
    taxonomy.withTaxonomyLock(async () => {
      const mediaRewritten = await metadata.rewriteName(kind, name, null)
      await taxonomy.deleteEntity(kind, name)
      return { mediaRewritten }
    })
  )

  handle('taxonomy:merge', ({ kind, from, into }) =>
    taxonomy.withTaxonomyLock(async () => {
      await taxonomy.ensureEntities(kind, [from, into])
      const mediaRewritten = await metadata.rewriteName(kind, from, into)
      await taxonomy.mergeEntities(kind, from, into)
      return { mediaRewritten }
    })
  )

  handle('taxonomy:setImage', async ({ kind, name, sourcePath }) => ({
    dataUrl: await taxonomy.setEntityImage(kind, name, sourcePath)
  }))

  handle('taxonomy:getImage', async ({ kind, name }) => ({
    dataUrl: await taxonomy.getEntityImage(kind, name)
  }))

  handle('taxonomy:queue', async () => ({ ops: await loadQueue() }))

  handle('taxonomy:saveQueue', ({ ops }) => saveQueue(ops))

  handle('taxonomy:saveFilter', ({ name, filter }) => taxonomy.saveFilter(name, filter))

  handle('taxonomy:deleteFilter', ({ id }) => taxonomy.deleteFilter(id))

  taxonomy.taxonomyEvents.on('changed', () => broadcast('event:taxonomy-changed', {}))

  handle('sites:list', async () => ({ sites: await listSites() }))

  handle('sites:login', ({ id }) => openSiteLogin(id))

  handle('sites:signOut', ({ id }) => signOutSite(id))

  handle('settings:get', () => config.getSettings())

  handle('settings:update', async (patch) => {
    const previous = await config.getSettings()
    const settings = await config.updateSettings(patch)
    const libraries = await config.listLibraries()
    if (
      previous.ui.startupArtwork.mode !== settings.ui.startupArtwork.mode ||
      artworkSelectionKey(previous.ui, libraries) !== artworkSelectionKey(settings.ui, libraries)
    ) {
      scheduleStartupArtworkPreparation(settings.ui, libraries)
    }
    // The close handler cannot read a file, so it reads this instead.
    rememberCloseChoice(settings.ui.onCloseMainWindow)
    // Also how the script route takes effect: switching to MFP has to make the
    // built-in player let go of its devices before MFP reaches for them.
    configureScriptPlayer(settings.scriptPlayer, settings.playback.scriptRoute === 'internal')
    // Players added, removed or re-addressed in the settings page take effect
    // here; the ones still in the list keep their connections.
    await playback.reconfigurePlayers()
    pokeConnStatus()
    // The proxy is the one setting that has to reach live network stacks
    // rather than being read when the next transfer starts.
    await applyProxySettings()
    updater.configureAutoCheck(settings)
    return settings
  })

  // Library manager → renderer push events.
  libraryEvents.on('sync-progress', (p) => broadcast('event:sync-progress', p))
  libraryEvents.on('media-changed', (p) => broadcast('event:media-changed', p))
  libraryEvents.on('sync-failed', (p) => broadcast('event:library-error', p))
  artworkPoolEvents.onReady(() => broadcast('event:startup-artwork-ready', {}))
  artworkPoolEvents.onProgress((progress) => broadcast('event:startup-artwork-cache', progress))
  playbackEvents.on('playback-changed', (p) => {
    broadcast('event:playback-changed', p)
    pokeConnStatus()
  })
  mediaSourceEvents.on('changed', (sources) => broadcast('event:playback-sources', sources))
  // The built-in picture: what it should be showing, and which window has it.
  videoSurfaceEvents.on('intent', (intent) => broadcast('event:video-intent', intent))
  onVideoPlayerSurfaceChanged((detached) => broadcast('event:video-surface', { detached }))
  queueEvents.on('queue-changed', (s) => broadcast('event:queue-changed', s))
  // A finished video plays the next one. Wired here rather than inside the
  // queue's own module so every subscription to playback lives in one place.
  queue.startAutoAdvance()
  // What the user was in the middle of last time, restored but not resumed.
  void queue.restore().catch((e) => console.error('[queue] could not restore the queue:', e))
  connStatusEvents.on('change', (s) => broadcast('event:conn-status', s))
  downloadEvents.on('jobs-changed', () => broadcast('event:downloads-changed', {}))
  downloadEvents.on('progress', (jobs) => broadcast('event:download-progress', { jobs }))
  depsEvents.on('progress', (p) => broadcast('event:dep-progress', p))
  megacmd.megacmdEvents.on('progress', (p) => broadcast('event:megacmd-progress', p))
  updateEvents.on('state', (s) => broadcast('event:update-state', s))
  releaseEvents.on('changed', (releases) => broadcast('event:releases', releases))
  scanEvents.on('progress', (p) => broadcast('event:match-progress', p))
}
