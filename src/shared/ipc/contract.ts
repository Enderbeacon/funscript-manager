import { z } from 'zod'
import { APP_ERROR_CODES } from '../errors'
import { LibrariesFileSchema, RegisteredLibrarySchema, SettingsSchema } from '../schemas/app-config'
import {
  MediaDetailSchema,
  MediaListItemSchema,
  MediaListPageSchema,
  SyncProgressSchema
} from '../schemas/media-index'
import { IgnoredEntrySchema } from '../schemas/library-state'
import {
  InternalPlayerIntentSchema,
  InternalPlayerReportSchema,
  MediaSourceCapabilitiesSchema,
  MediaSourceStatusSchema,
  SubtitleCueSchema,
  SubtitleTrackSchema
} from '../schemas/playback'
import { DeleteModeSchema, DeletePlanSchema, RenamePlanSchema } from '../schemas/media-lifecycle'
import { NAME_FIELDS, SCRIPT_AXIS_KEYS } from '../schemas/media-meta'
import { ENTITY_KINDS, FilterNodeSchema } from '../schemas/taxonomy'
import { QueuedOpSchema } from '../schemas/organise-queue'
import { QueueItemSchema, QueueSourceSchema, QueueStateSchema } from '../schemas/queue'
import { DownloadJobSchema, DownloadProgressSchema } from '../schemas/download'
import { BinaryIdSchema, BinaryStatusSchema, InstallProgressSchema } from '../schemas/dependencies'
import { ScrapedPostSchema } from '../schemas/scraped-post'
import { StartupStatusSchema } from '../schemas/startup'
import { ReleaseSummarySchema, StartupNoticesSchema, UpdateStateSchema } from '../schemas/updates'
import {
  MatchQueueItemSchema,
  MatchScanStatusSchema,
  PostMatchResultSchema
} from '../schemas/post-match'
import {
  scriptPlayerIpcContract,
  scriptPlayerIpcEvents
} from '../../script-player/interface/ipc/contract'

const SettingsNavigationSchema = z.object({
  section: z.literal('playback'),
  target: z.literal('scriptRoute')
})

/**
 * IPC contract: the single definition point for all renderer → main calls.
 * The main side validates inputs/outputs against these schemas when
 * registering handlers; the renderer derives its types from here.
 * Raw string channels are forbidden everywhere else.
 */

export const ipcContract = {
  ...scriptPlayerIpcContract,
  'app:getInfo': {
    input: z.void(),
    output: z.object({
      version: z.string(),
      electron: z.string(),
      userDataPath: z.string()
    })
  },

  'dialog:pickDirectory': {
    input: z.object({ title: z.string().optional() }).default({}),
    output: z.object({ path: z.string().nullable() })
  },
  'dialog:pickFile': {
    /** Executable picker (settings paths). */
    input: z.object({ title: z.string().optional() }).default({}),
    output: z.object({ path: z.string().nullable() })
  },
  'dialog:pickScripts': {
    /** Multi-select .funscript picker (detail page "add version"). */
    input: z.object({ title: z.string().optional() }).default({}),
    output: z.object({ paths: z.array(z.string()) })
  },
  'dialog:pickImage': {
    /** Single-image picker (organise page cover art). */
    input: z.object({ title: z.string().optional() }).default({}),
    output: z.object({ path: z.string().nullable() })
  },

  'app:startupStatus': {
    /** Where the startup sequence has got to; asked by the card as it loads. */
    input: z.void(),
    output: StartupStatusSchema
  },
  'app:startupCancel': {
    /** The card's close button: leave, whatever startup was in the middle of. */
    input: z.void(),
    output: z.void()
  },
  'app:windowReady': {
    /**
     * The main window has drawn its first screen. Until this arrives the
     * window is hidden and the startup card is what the user sees.
     */
    input: z.void(),
    output: z.void()
  },

  'app:setTitleBarColors': {
    /**
     * Repaint the window-control overlay to match the theme. The system draws
     * those buttons, so they cannot inherit CSS — without this they stay the
     * colour the window was created with and stand out as the one part of the
     * frame that did not follow.
     */
    input: z.object({ color: z.string().min(1), symbolColor: z.string().min(1) }),
    output: z.void()
  },
  'app:openSettings': {
    /** Navigate the main window from another app surface, including a detached player. */
    input: SettingsNavigationSchema,
    output: z.void()
  },
  'app:mainWindowOpen': {
    /**
     * Is the main window still there?
     *
     * Asked by the detached players: keeping them open with the main window
     * closed is a state the user can choose, and in it those windows are the
     * only way back — so they put up a button, but only then.
     */
    input: z.void(),
    output: z.object({ open: z.boolean() })
  },
  'app:showMainWindow': {
    /** Bring the main window back, building it again if it has been closed. */
    input: z.void(),
    output: z.void()
  },
  'app:closeMainWindow': {
    /**
     * The answer to the closing question: do the detached players go too?
     *
     * `remember` writes the answer to `ui.onCloseMainWindow`, so the question
     * stops being asked. Cancelling does not call this at all.
     */
    input: z.object({ closePlayers: z.boolean(), remember: z.boolean() }),
    output: z.void()
  },

  'library:list': {
    input: z.void(),
    output: LibrariesFileSchema.shape.libraries
  },
  'library:whenReady': {
    /**
     * Resolves once the startup scan is done. For work that rewrites names
     * across the library: until the index has been built, it cannot say which
     * media carry a name, and the rewrite would quietly miss them.
     */
    input: z.void(),
    output: z.void()
  },
  'library:add': {
    input: z.object({
      rootPath: z.string().min(1),
      name: z.string().min(1).optional()
    }),
    output: RegisteredLibrarySchema
  },
  'library:remove': {
    input: z.object({ id: z.uuid() }),
    output: z.void()
  },
  'library:sync': {
    /** Manual re-sync; progress arrives via `event:sync-progress`. */
    input: z.object({ id: z.uuid() }),
    output: z.void()
  },
  'library:addWanted': {
    /**
     * File the post's metadata now, for a video that has to be bought or
     * fetched by hand. Creates a library entry with no file behind it yet.
     */
    input: z.object({ libraryId: z.uuid(), post: ScrapedPostSchema }),
    output: z.object({ mediaId: z.uuid(), filePath: z.string() }).nullable()
  },
  'library:attachWanted': {
    /** Supply the file that entry was waiting for; it is copied into the library. */
    input: z.object({ libraryId: z.uuid(), mediaId: z.uuid(), sourcePath: z.string().min(1) }),
    output: MediaDetailSchema.nullable()
  },
  'library:wantedMatches': {
    /**
     * Files already in the library that share a name with what this entry is
     * waiting for. Offered, never applied: a name match is a good guess and a
     * bad decision to make on someone's behalf.
     */
    input: z.object({ libraryId: z.uuid(), mediaId: z.uuid() }),
    output: z.object({
      matches: z.array(z.object({ mediaId: z.uuid(), filePath: z.string(), fileName: z.string() }))
    })
  },
  'library:linkWanted': {
    /** That file IS this entry: fold the entry's metadata into it and drop the placeholder. */
    input: z.object({ libraryId: z.uuid(), mediaId: z.uuid(), candidateId: z.uuid() }),
    output: MediaDetailSchema.nullable()
  },
  'library:mergeWanted': {
    /**
     * Fold placeholder entries into `targetId` and drop them: the same scene
     * filed more than once. Only entries still waiting for a file can be
     * folded away; no file is moved or renamed.
     */
    input: z.object({
      libraryId: z.uuid(),
      targetId: z.uuid(),
      sourceIds: z.array(z.uuid()).min(1)
    }),
    output: MediaDetailSchema.nullable()
  },
  'library:dismissWantedMatch': {
    /** Not that file; stop offering it. */
    input: z.object({ libraryId: z.uuid(), mediaId: z.uuid(), candidateId: z.uuid() }),
    output: z.void()
  },

  'library:listIgnored': {
    /** Entries the user removed while keeping their files (`.fsmgr-library.json`). */
    input: z.object({ libraryId: z.uuid() }),
    output: z.object({ entries: z.array(IgnoredEntrySchema) })
  },
  'library:restoreIgnored': {
    /** Stop ignoring one; the next scan indexes it again. */
    input: z.object({ libraryId: z.uuid(), id: z.uuid() }),
    output: z.object({ restored: z.boolean() })
  },
  'library:clearIgnored': {
    input: z.object({ libraryId: z.uuid() }),
    output: z.void()
  },

  'library:folders': {
    /**
     * Folders holding entries, with what each one accounts for. Without a
     * library, every one that is running — the filter sidebar browses them all
     * at once, so each row has to say where it came from.
     */
    input: z.object({ libraryId: z.uuid().optional() }),
    output: z.object({
      folders: z.array(
        z.object({
          libraryId: z.uuid(),
          /** Library-relative, forward slashes; '' is the library root. */
          path: z.string(),
          depth: z.number().int().nonnegative(),
          entries: z.number().int().nonnegative(),
          total: z.number().int().nonnegative()
        })
      )
    })
  },
  'library:removeFolder': {
    /** Every entry in a folder and below it out of the library; files stay put. */
    input: z.object({ libraryId: z.uuid(), folder: z.string() }),
    output: z.object({ removed: z.number().int().nonnegative() })
  },

  /**
   * Finding the forum post an entry came from.
   *
   * Searching and applying stay separate on purpose: everything here reads
   * except `match:apply`, which writes what the search already established
   * without going back to the forum for it.
   */
  'match:findPost': {
    /**
     * Search for one entry's post. `query` replaces the built ladder with a
     * single search, which is what the panel's editable box sends — the
     * entry's own names are a good guess, and the user looking at the file is
     * a better one.
     */
    input: z.object({
      libraryId: z.uuid(),
      mediaId: z.uuid(),
      query: z.string().optional()
    }),
    output: PostMatchResultSchema
  },
  'match:start': {
    /** Begin (or resume) a library-wide pass. Empty `libraryIds` means all. */
    input: z.object({
      libraryIds: z.array(z.uuid()).default([]),
      /** Look again at entries an earlier pass already settled. */
      rescan: z.boolean().default(false)
    }),
    output: z.void()
  },
  'match:pause': { input: z.void(), output: z.void() },
  'match:resume': { input: z.void(), output: z.void() },
  'match:stop': { input: z.void(), output: z.void() },
  'match:status': { input: z.void(), output: MatchScanStatusSchema },
  'match:queue': {
    /** Entries waiting to be looked at, strongest evidence first. */
    input: z.object({
      limit: z.number().int().positive().max(200).default(50),
      offset: z.number().int().nonnegative().default(0)
    }),
    output: z.object({
      items: z.array(MatchQueueItemSchema),
      queued: z.number().int().nonnegative()
    })
  },
  'match:reject': {
    /**
     * Not that post. Remembered in the sidecar, so it is not offered again by
     * this pass or any later one.
     */
    input: z.object({ libraryId: z.uuid(), mediaId: z.uuid(), topicId: z.number().int() }),
    output: z.object({ candidatesLeft: z.number().int().nonnegative() })
  },
  'match:settle': {
    /** Take an entry off the queue without picking anything — none of these. */
    input: z.object({ libraryId: z.uuid(), mediaId: z.uuid() }),
    output: z.void()
  },
  'match:apply': {
    /**
     * That candidate is the entry's post: write it in and take the entry off
     * the queue.
     *
     * Deliberately not `media:applyPostLink`, which fetches the thread. A
     * search result already carries the title, the tags and the poster, so
     * this asks the forum for nothing at all and finishes in the time a file
     * write takes — which is what makes a review queue reviewable. The links
     * a full read would also have found are not lost, only not fetched now:
     * the post URL is recorded, and "Fill from post" on the entry gets them
     * whenever they are wanted.
     *
     * The candidate is looked up here by topic id rather than sent in, so what
     * lands in the sidecar is what the app scored, not what a message claims.
     */
    input: z.object({ libraryId: z.uuid(), mediaId: z.uuid(), topicId: z.number().int() }),
    output: z.object({
      postTitle: z.string(),
      tagsAdded: z.array(z.string()),
      videoAuthorsAdded: z.array(z.string()),
      titleSet: z.boolean()
    })
  },

  'media:applyPostLink': {
    /**
     * Fetch a forum post and fold its metadata into media the user picked —
     * the manual counterpart of downloading from that post. Additive: nothing
     * already on the media is removed, so it is safe to run twice.
     *
     * One post, many media, because a post routinely covers several scenes and
     * because the forum is asked at one request a second — fetching it once for
     * a whole selection is the difference between instant and a minute.
     */
    input: z.object({
      targets: z.array(z.object({ libraryId: z.uuid(), mediaId: z.uuid() })).min(1),
      postUrl: z.string().min(1),
      /**
       * Let the post's title become the entry's, replacing one it already has.
       * Sent when the user accepted this post *as* the entry's post; a link
       * pasted onto an entry the user may have titled themselves does not.
       */
      setTitle: z.boolean().default(false)
    }),
    output: z.object({
      /** The post's own title, so the result can name what it read. */
      postTitle: z.string(),
      applied: z.number().int().nonnegative(),
      /** Names newly added, across the whole selection. */
      tagsAdded: z.array(z.string()),
      scriptAuthorsAdded: z.array(z.string()),
      /** The animator, when the post's title credited one. */
      videoAuthorsAdded: z.array(z.string()),
      titlesSet: z.number().int().nonnegative(),
      linksAdded: z.number().int().nonnegative(),
      failed: z.array(z.object({ mediaId: z.uuid(), reason: z.string() }))
    })
  },

  'media:planDelete': {
    /**
     * What a delete would do, so the confirmation can name the files instead of
     * asking the user to trust a verb. This is the app's first operation that
     * destroys the user's own data, and it will not do it behind a generic
     * "are you sure".
     */
    input: z.object({
      libraryId: z.uuid(),
      mediaIds: z.array(z.uuid()).min(1),
      mode: DeleteModeSchema
    }),
    output: DeletePlanSchema
  },
  'media:delete': {
    input: z.object({
      libraryId: z.uuid(),
      mediaIds: z.array(z.uuid()).min(1),
      mode: DeleteModeSchema,
      /**
       * 'library' mode: keep the scripts visible as a placeholder entry rather
       * than removing them along with their video.
       */
      keepScripts: z.boolean().default(false)
    }),
    output: z.object({
      removed: z.number().int().nonnegative(),
      trashed: z.array(z.string()),
      failed: z.array(z.string()),
      skippedShared: z.array(z.string())
    })
  },
  'media:planRename': {
    /** Which files follow the media's new name, and which keep theirs. */
    input: z.object({
      libraryId: z.uuid(),
      mediaId: z.uuid(),
      newName: z.string(),
      renameCompanions: z.boolean()
    }),
    output: RenamePlanSchema
  },
  'media:rename': {
    input: z.object({
      libraryId: z.uuid(),
      mediaId: z.uuid(),
      newName: z.string().min(1),
      renameCompanions: z.boolean()
    }),
    output: z.object({
      detail: MediaDetailSchema,
      renamed: z.array(z.object({ from: z.string(), to: z.string() }))
    })
  },

  'media:list': {
    /** libraryId omitted = aggregate across all libraries (the default view). */
    input: z.object({
      libraryId: z.uuid().optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(200),
      search: z.string().optional(),
      /** The filter sidebar and the condition builder both produce one of these. */
      filter: FilterNodeSchema.nullish(),
      sort: z
        .enum(['path', 'title', 'addedAt', 'updatedAt', 'size', 'rating', 'scriptCount', 'playlist'])
        .optional(),
      /**
       * Which playlist `sort: 'playlist'` means. Ignored for every other sort —
       * a playlist's order says nothing about media outside it.
       */
      playlistOrder: z.string().optional()
    }),
    output: MediaListPageSchema
  },
  'media:viewTargets': {
    /**
     * Everything the grid is showing, in the order it is showing it — the queue
     * behind "play everything here".
     *
     * Ordered, which `media:matchingIds` is not, and capped: a queue of every
     * file in a hundred-thousand-file library is not one anybody meant, and it
     * would be written to disk on every change.
     */
    input: z.object({
      libraryId: z.uuid().optional(),
      search: z.string().optional(),
      filter: FilterNodeSchema.nullish(),
      sort: z
        .enum(['path', 'title', 'addedAt', 'updatedAt', 'size', 'rating', 'scriptCount', 'playlist'])
        .optional(),
      playlistOrder: z.string().optional()
    }),
    output: z.object({
      targets: z.array(z.object({ libraryId: z.uuid(), mediaId: z.uuid() })),
      /** The view held more than the queue would take. */
      capped: z.boolean()
    })
  },
  'media:listByIds': {
    /**
     * The rows behind a list of targets — what the queue needs to show titles
     * for the ids it holds. Rows come back in the index's order, not the
     * order asked for: the caller has an order of its own and matches by id.
     */
    input: z.object({
      targets: z.array(z.object({ libraryId: z.uuid(), mediaId: z.uuid() }))
    }),
    output: z.object({ items: z.array(MediaListItemSchema) })
  },
  'media:matchingIds': {
    /** Everything the current filter matches, for "select all" past one page. */
    input: z.object({
      libraryId: z.uuid().optional(),
      search: z.string().optional(),
      filter: FilterNodeSchema.nullish()
    }),
    output: z.object({
      targets: z.array(z.object({ libraryId: z.uuid(), mediaId: z.uuid() }))
    })
  },
  'media:reveal': {
    /**
     * Show the file in the OS file manager, selected. When there is no file —
     * a placeholder, or one that has moved — the nearest existing folder above
     * it is opened instead.
     */
    input: z.object({ libraryId: z.uuid(), mediaId: z.uuid() }),
    output: z.void()
  },
  'media:setNames': {
    /** Replace one name list (tags, authors, studios, playlists). */
    input: z.object({
      libraryId: z.uuid(),
      mediaId: z.uuid(),
      field: z.enum(NAME_FIELDS),
      names: z.array(z.string())
    }),
    output: MediaDetailSchema
  },
  'media:setUserMeta': {
    input: z.object({
      libraryId: z.uuid(),
      mediaId: z.uuid(),
      title: z.string().optional(),
      /** null clears it; absent leaves it alone. */
      rating: z.number().int().min(0).max(5).nullable().optional(),
      favorite: z.boolean().optional(),
      notes: z.string().optional()
    }),
    output: MediaDetailSchema
  },
  'media:setSources': {
    /**
     * Replace the media's source list. Whole-list rather than add/remove: this
     * is a short list the user edits directly, and sending what it should be
     * cannot get out of step with what it is.
     */
    input: z.object({
      libraryId: z.uuid(),
      mediaId: z.uuid(),
      sources: z.array(
        z.object({ type: z.enum(['eroscripts', 'original', 'other']), url: z.url() })
      )
    }),
    output: MediaDetailSchema
  },
  'media:batchEdit': {
    /**
     * One edit over many media. Add and remove are separate because "set these
     * tags on 40 items" nearly always means add, and replacing silently would
     * drop everything else they carry.
     */
    input: z.object({
      targets: z.array(z.object({ libraryId: z.uuid(), mediaId: z.uuid() })).min(1),
      edit: z.object({
        add: z.partialRecord(z.enum(NAME_FIELDS), z.array(z.string())).optional(),
        remove: z.partialRecord(z.enum(NAME_FIELDS), z.array(z.string())).optional(),
        replace: z.partialRecord(z.enum(NAME_FIELDS), z.array(z.string())).optional(),
        rating: z.number().int().min(0).max(5).nullable().optional(),
        favorite: z.boolean().optional()
      })
    }),
    output: z.object({
      changed: z.number().int().nonnegative(),
      failed: z.array(z.object({ mediaId: z.uuid(), reason: z.string() }))
    })
  },

  /*
   * Playlists.
   *
   * Creating, renaming, re-covering and deleting one are `taxonomy:*` — a
   * playlist is one of the names that file describes, like a tag. Only the
   * three things a tag cannot do live here, and all three are about order.
   */
  'playlist:add': {
    /**
     * Append to the end of a playlist, creating it if the name is new. Media
     * already in it keep the place they had: adding something twice is not a
     * way to move it.
     */
    input: z.object({
      targets: z.array(z.object({ libraryId: z.uuid(), mediaId: z.uuid() })).min(1),
      name: z.string().min(1)
    }),
    output: z.object({
      added: z.number().int().nonnegative(),
      /** The canonical spelling it actually landed under. */
      name: z.string()
    })
  },
  'playlist:remove': {
    input: z.object({
      targets: z.array(z.object({ libraryId: z.uuid(), mediaId: z.uuid() })).min(1),
      name: z.string().min(1)
    }),
    output: z.object({ removed: z.number().int().nonnegative() })
  },
  'playlist:duplicate': {
    /** A second list with the same members in the same order. */
    input: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    output: z.object({ name: z.string(), copied: z.number().int().nonnegative() })
  },
  'playlist:exportM3u': {
    /**
     * Write the list out as an .m3u the rest of the world understands.
     *
     * An export, not a second home for the order: the sidecars stay the truth,
     * and this is a copy handed to mpv, VLC or a phone. Returns null when the
     * save dialog was dismissed.
     */
    input: z.object({ name: z.string().min(1) }),
    output: z.object({ path: z.string().nullable(), tracks: z.number().int().nonnegative() })
  },
  'playlist:move': {
    /**
     * Put one media directly after another — null meaning the front of the
     * list. A neighbour rather than an index: the list on screen and the list
     * on disk are two different moments, and an index is wrong as soon as
     * anything else has changed, where a neighbour still means what it said.
     */
    input: z.object({
      libraryId: z.uuid(),
      mediaId: z.uuid(),
      name: z.string().min(1),
      afterMediaId: z.uuid().nullable()
    }),
    output: z.object({ ordered: z.number().int().nonnegative() })
  },

  'media:getHeatmap': {
    /** Default script version when scriptVersionId is omitted; null = no heatmap. */
    input: z.object({
      libraryId: z.uuid(),
      mediaId: z.uuid(),
      scriptVersionId: z.uuid().optional()
    }),
    output: z.object({ dataUrl: z.string().nullable() })
  },
  'media:getThumbnail': {
    /** null = not a video, file missing, or extraction failed. */
    input: z.object({ libraryId: z.uuid(), mediaId: z.uuid() }),
    output: z.object({ dataUrl: z.string().nullable() })
  },
  'media:get': {
    /** Full single-media detail from the sidecar; null if unknown/unreadable. */
    input: z.object({ libraryId: z.uuid(), mediaId: z.uuid() }),
    output: MediaDetailSchema.nullable()
  },
  'media:setDefaultScriptVersion': {
    /** Make one version the sidecar default (clears the flag on the others). */
    input: z.object({ libraryId: z.uuid(), mediaId: z.uuid(), scriptVersionId: z.uuid() }),
    output: MediaDetailSchema.nullable()
  },
  'media:setVersionInheritAxes': {
    /** Single-axis version: borrow the default multi-axis version's other axes. */
    input: z.object({
      libraryId: z.uuid(),
      mediaId: z.uuid(),
      scriptVersionId: z.uuid(),
      inherit: z.boolean()
    }),
    output: MediaDetailSchema.nullable()
  },
  'media:updateScriptVersion': {
    /**
     * Edit one version's descriptive fields (rename / author / source / notes).
     * Omitted keys keep their current value; null or '' clears an optional one.
     */
    input: z.object({
      libraryId: z.uuid(),
      mediaId: z.uuid(),
      scriptVersionId: z.uuid(),
      name: z.string().min(1).optional(),
      author: z.string().nullable().optional(),
      /** Must parse as a URL unless it is being cleared. */
      sourceUrl: z.string().nullable().optional(),
      notes: z.string().nullable().optional()
    }),
    output: MediaDetailSchema.nullable()
  },
  'media:addScriptVersion': {
    /**
     * Manually add a version from funscript files anywhere on disk (scripts
     * outside the media's own folder are never grouped automatically).
     * Files already inside the library are referenced where they are; files
     * from outside are copied next to the media first.
     */
    input: z.object({
      libraryId: z.uuid(),
      mediaId: z.uuid(),
      name: z.string().min(1),
      author: z.string().optional(),
      sourceUrl: z.string().optional(),
      notes: z.string().optional(),
      /** Axis → absolute path of an existing .funscript; `main` is required. */
      files: z
        .partialRecord(z.enum(SCRIPT_AXIS_KEYS), z.string().min(1))
        .refine((f) => f.main !== undefined, { message: 'a main axis file is required' })
    }),
    output: z.object({
      detail: MediaDetailSchema.nullable(),
      /** File names copied into the media's folder (empty = all referenced in place). */
      copied: z.array(z.string())
    })
  },
  'media:deleteScriptVersion': {
    /**
     * Drop a version from the sidecar and send its script files to the OS
     * trash (recoverable). Files another version still references are kept.
     */
    input: z.object({ libraryId: z.uuid(), mediaId: z.uuid(), scriptVersionId: z.uuid() }),
    output: z.object({
      detail: MediaDetailSchema.nullable(),
      /** File names actually moved to the trash. */
      trashed: z.array(z.string()),
      /** File names the OS refused to trash (still on disk). */
      failed: z.array(z.string())
    })
  },

  'playback:play': {
    /**
     * scriptVersionId omitted = lastUsed → default → first.
     * noScript: play the video with no script at all (overrides
     * scriptVersionId); nothing keeps driving the device.
     * resumePosition: keep the current mpv position across the reload — used
     * for in-place version switching while the same media is playing (mpv
     * loadfile with start=<pos>). Ignored when a different media is playing.
     */
    input: z.object({
      libraryId: z.uuid(),
      mediaId: z.uuid(),
      scriptVersionId: z.uuid().optional(),
      noScript: z.boolean().optional(),
      resumePosition: z.boolean().optional()
    }),
    output: z.object({
      /** The player the file was handed to. */
      sourceId: z.string(),
      /** Which player was handed the script (settings "script route"). */
      route: z.enum(['internal', 'mfp']),
      /** Only on the MFP route; null otherwise, because MFP was not touched. */
      mfp: z
        .object({
          status: z.enum(['running', 'launched', 'unavailable']),
          /** Whether MFP's control plugin served this load. */
          pluginServed: z.boolean()
        })
        .nullable(),
      scriptVersionId: z.uuid().nullable()
    })
  },
  'playback:setPaused': {
    /**
     * Pause/resume the running playback. There is no "stop": mpv's stop
     * unloads the file, and an mpv started by MFP has no `--idle`, so it would
     * quit outright.
     */
    input: z.object({ paused: z.boolean() }),
    output: z.void()
  },
  'playback:status': {
    input: z.void(),
    output: z.object({
      mediaId: z.uuid().nullable(),
      /** The library the file belongs to, so its title and art can be asked for. */
      libraryId: z.uuid().nullable(),
      /** Version currently driving the axes; null when playing video only. */
      scriptVersionId: z.uuid().nullable(),
      positionMs: z.number().nullable(),
      durationMs: z.number().nullable(),
      paused: z.boolean().nullable(),
      /** The player's own volume, 0–100; null when it has none to report. */
      volume: z.number().nullable(),
      /**
       * What the player being followed can do. The transport controls are
       * drawn from this, so a player without a volume has no volume slider
       * rather than one that does nothing. Null when no player is connected.
       */
      capabilities: MediaSourceCapabilitiesSchema.nullable(),
      /** The file being played, even when the user opened it themselves. */
      path: z.string().nullable()
    })
  },
  'playback:setVolume': {
    input: z.object({ volume: z.number().min(0).max(100) }),
    output: z.void()
  },

  /*
   * The built-in picture.
   *
   * These are the wire between the main process, which holds what should be
   * playing, and whichever window is currently drawing it. Everything else
   * about playback goes through `playback:*` exactly as it does for mpv —
   * the built-in player is one entry in the player list, not a second system.
   */
  /**
   * What the picture should be showing right now.
   *
   * Read on mount: intent arrives as events afterwards, and a window that
   * opened after the last change would otherwise know nothing until the next
   * one — which for a picture already playing may never come.
   */
  'video:intent': {
    input: z.void(),
    output: InternalPlayerIntentSchema
  },
  /** This window is drawing the picture now; it starts getting intent events. */
  'video:claim': {
    input: z.object({ surface: z.enum(['docked', 'window']) }),
    output: InternalPlayerIntentSchema
  },
  /** This window is not drawing it any more (unmounted, or handed over). */
  'video:release': {
    input: z.void(),
    output: z.void()
  },
  /** Where the picture is and what it is doing, several times a second. */
  'video:report': {
    input: InternalPlayerReportSchema,
    output: z.void()
  },
  /**
   * The user closed the picture, and it is not being kept alive for its sound
   * (`playback.keepPlayingWhenClosed`): unload and let go of the player.
   */
  'video:close': {
    input: z.void(),
    output: z.void()
  },
  /** Move the picture into its own window, and back. */
  'video:detach': {
    input: z.void(),
    output: z.object({ detached: z.boolean() })
  },
  'video:attach': {
    input: z.void(),
    output: z.object({ detached: z.boolean() })
  },
  'video:surface': {
    input: z.void(),
    output: z.object({ detached: z.boolean() })
  },

  /*
   * Subtitles for the picture.
   *
   * The list is asked for when the menu opens rather than kept with the
   * intent: reading what is inside a container costs an ffmpeg run, and it is
   * wasted on every video nobody right-clicks.
   */
  'video:subtitleTracks': {
    input: z.object({ path: z.string() }),
    output: z.object({ tracks: z.array(SubtitleTrackSchema) })
  },
  /** The lines themselves, which the picture draws over the video. */
  'video:subtitleCues': {
    input: z.object({ track: SubtitleTrackSchema }),
    output: z.object({ cues: z.array(SubtitleCueSchema) })
  },
  /** Show this one, or none. The choice is kept for the next video. */
  'video:setSubtitle': {
    input: z.object({ track: SubtitleTrackSchema.nullable() }),
    output: z.void()
  },
  /** Nudge the lines earlier or later against the picture. */
  'video:setSubtitleOffset': {
    input: z.object({ offsetMs: z.number().int() }),
    output: z.void()
  },
  /**
   * Pick a subtitle file off the disk.
   *
   * The one place a file outside every library is read: the user chose it in
   * the system dialog, which is a stronger statement than any path check.
   * Null when the dialog was dismissed.
   */
  'video:pickSubtitleFile': {
    input: z.void(),
    output: z.object({ track: SubtitleTrackSchema.nullable() })
  },

  /*
   * The queue: what plays after this one.
   *
   * Separate from `playback:*` on purpose. Playback loads a file and reports
   * what happened; deciding what comes next is a different question, and one
   * that has to keep working when the engine underneath is replaced.
   */
  'queue:get': {
    input: z.void(),
    output: QueueStateSchema
  },
  'queue:start': {
    /** Take this list as the queue and play one of it. */
    input: z.object({
      source: QueueSourceSchema,
      items: z.array(z.object({ libraryId: z.uuid(), mediaId: z.uuid() })).min(1),
      at: z.number().int().nonnegative().default(0)
    }),
    output: z.void()
  },
  /**
   * Editing the queue. Items are named by id rather than by position: the list
   * moves under every write, and a position captured a moment ago is wrong by
   * the time it is used.
   */
  'queue:add': {
    /** `next` puts them straight after what is playing; `end` at the back. */
    input: z.object({
      items: z.array(QueueItemSchema).min(1),
      mode: z.enum(['next', 'end']).default('end'),
      /** A drop in the queue list: put them after this one (null = the front). */
      afterMediaId: z.uuid().nullish()
    }),
    output: QueueStateSchema
  },
  'queue:remove': {
    input: z.object({ items: z.array(QueueItemSchema).min(1) }),
    output: QueueStateSchema
  },
  'queue:move': {
    /** Put one after another; null = the front of the queue. */
    input: z.object({ mediaId: z.uuid(), afterMediaId: z.uuid().nullable() }),
    output: QueueStateSchema
  },
  'queue:clear': { input: z.void(), output: QueueStateSchema },
  'queue:saveAsPlaylist': {
    /** Keep what was assembled here, in this order. */
    input: z.object({ name: z.string().min(1) }),
    output: z.object({ name: z.string(), added: z.number().int().nonnegative() })
  },
  /** Play from the cursor — the bar's play button with nothing loaded yet. */
  'queue:resume': { input: z.void(), output: z.object({ moved: z.boolean() }) },
  'queue:next': { input: z.void(), output: z.object({ moved: z.boolean() }) },
  'queue:previous': { input: z.void(), output: z.object({ moved: z.boolean() }) },
  'queue:playAt': {
    input: z.object({ index: z.number().int().nonnegative() }),
    output: z.void()
  },
  'queue:setMode': {
    input: z.object({ shuffle: z.boolean().optional(), repeat: z.boolean().optional() }),
    output: QueueStateSchema
  },

  'playback:seek': {
    /** Jump to a position in the file currently playing. */
    input: z.object({ positionMs: z.number().nonnegative() }),
    output: z.void()
  },

  'playback:connStatus': {
    input: z.void(),
    output: z.object({
      /**
       * Null on the internal route: MFP is not merely off, it is not part of
       * this setup, and the sidebar leaves the row out rather than reporting a
       * program the user never opted into as missing.
       */
      mfp: z.enum(['running', 'off']).nullable()
    })
  },

  'playback:sources': {
    /** The player list with what each one is doing right now. */
    input: z.void(),
    output: z.array(MediaSourceStatusSchema)
  },
  'playback:setCurrentSource': {
    /**
     * Use this player from now on. The one being left is paused and let go of;
     * whatever the new one already has open becomes what the app is playing.
     */
    input: z.object({ id: z.uuid() }),
    output: z.array(MediaSourceStatusSchema)
  },
  'playback:launchMfp': {
    input: z.void(),
    output: z.object({ status: z.enum(['running', 'launched', 'unavailable']) })
  },
  'playback:detectMfp': {
    /** Settings helper: scan common MFP install paths. */
    input: z.void(),
    output: z.object({ path: z.string().nullable() })
  },

  'playback:sessionDirs': {
    /** Per-library playback session dirs to register as MFP script libraries. */
    input: z.void(),
    output: z.array(z.object({ libraryId: z.uuid(), name: z.string(), path: z.string() }))
  },
  'playback:mfpPluginStatus': {
    /** Path B: is the ManagerBridge plugin loaded and reachable? */
    input: z.void(),
    output: z.object({
      installed: z.boolean(),
      reachable: z.boolean(),
      version: z.string().nullable()
    })
  },
  'playback:restartMfp': {
    /** Close + relaunch MFP so it recompiles a freshly installed plugin. */
    input: z.void(),
    output: z.object({
      status: z.enum(['restarted', 'launched', 'still_running', 'unavailable'])
    })
  },
  'playback:installMfpPlugin': {
    /** Copy ManagerBridge.cs into MFP's Plugins dir; returns the target path. */
    input: z.object({ mfpExePath: z.string().optional() }).default({}),
    output: z.object({
      ok: z.boolean(),
      pluginPath: z.string().nullable(),
      /** Reason code when ok=false: mfp_not_found | copy_failed. */
      reason: z.string().nullable()
    })
  },

  'download:list': {
    input: z.void(),
    output: z.object({ jobs: z.array(DownloadJobSchema) })
  },
  'download:add': {
    /**
     * Enqueue a URL against a library. A folder/album link expands into one
     * job per file right here, so the returned list can hold several ids.
     * fileName overrides the guessed name — forum attachment URLs are content
     * hashes, and only the post knows what the file is actually called.
     */
    input: z.object({
      url: z.string().min(1),
      libraryId: z.uuid(),
      fileName: z.string().min(1).optional()
    }),
    output: z.object({ jobIds: z.array(z.uuid()) })
  },
  'download:addFromPost': {
    /**
     * Enqueue the links the user ticked in a parsed post. The jobs share a
     * batch so post-download ingest can fold the post's title/tags/source into
     * the video's sidecar and attach the scripts once everything has landed.
     */
    input: z.object({
      libraryId: z.uuid(),
      post: ScrapedPostSchema,
      urls: z.array(z.string()).min(1),
      /**
       * Post link URL → the direct link the user pasted for it. Lets a store
       * page (payhip) or a source whose parse broke be downloaded from an
       * address the user supplies, while the job keeps the post's identity —
       * its role, its batch, and the metadata written afterwards.
       */
      manualLinks: z.record(z.string(), z.string().min(1)).optional()
    }),
    output: z.object({ jobIds: z.array(z.uuid()), batchId: z.uuid() })
  },
  'download:pause': {
    input: z.object({ id: z.uuid() }),
    output: z.void()
  },
  'download:resume': {
    input: z.object({ id: z.uuid() }),
    output: z.void()
  },
  'download:retry': {
    /** Like resume, but also clears the retry budget a failed job used up. */
    input: z.object({ id: z.uuid() }),
    output: z.void()
  },
  'download:cancel': {
    /** Drops the job and its partial file; there is no cancelled state to keep. */
    input: z.object({ id: z.uuid() }),
    output: z.void()
  },
  'download:clearFinished': {
    input: z.void(),
    output: z.void()
  },
  'download:checkLinks': {
    /**
     * Are these links still good? Asked of a post's links before the user
     * commits to one, so a video taken down years ago reads as gone instead of
     * becoming a download that fails.
     *
     * Sources that answer in one request are checked as a matter of course;
     * the ones that need a page parse or a browser window answer `unknown`
     * until `force` says the user asked for that link specifically.
     */
    input: z.object({
      urls: z.array(z.string().min(1)).min(1),
      force: z.boolean().optional()
    }),
    output: z.object({
      statuses: z.record(z.string(), z.enum(['alive', 'gone', 'unknown', 'unchecked']))
    })
  },
  'deps:status': {
    /** yt-dlp and ffmpeg: what is installed, where it came from, is it current. */
    input: z.void(),
    output: z.object({ binaries: z.array(BinaryStatusSchema) })
  },
  'deps:install': {
    /** Download and install (or update) one binary; progress via `event:dep-progress`. */
    input: z.object({ id: BinaryIdSchema }),
    output: z.object({ binary: BinaryStatusSchema })
  },

  'scrape:isPostUrl': {
    /** Should the UI scrape this URL as a forum post, or just download it? */
    input: z.object({ url: z.string() }),
    output: z.object({ isPost: z.boolean() })
  },
  'scrape:parsePost': {
    /** Fetch + parse one EroScripts post; throws scrape_login_required if gated. */
    input: z.object({ url: z.string().min(1) }),
    output: ScrapedPostSchema
  },
  'scrape:checkExisting': {
    /**
     * Did a previous download of this post already land? Checked before
     * downloading, not after — telling the user afterwards would mean they
     * waited through gigabytes to find out.
     */
    input: z.object({ postUrl: z.string().min(1) }),
    output: z.object({
      existing: z
        .object({ libraryId: z.uuid(), mediaId: z.uuid(), filePath: z.string() })
        .nullable()
    })
  },
  'scrape:remoteImage': {
    /**
     * Fetch a post's preview image and hand it back inline. The renderer's CSP
     * allows `self`, `data:` and our media scheme only — deliberately, so a
     * forum post cannot make the app fetch arbitrary hosts — and the forum sits
     * behind bot management that only `net.fetch` gets through anyway.
     * Empty string when it cannot be had; a card without a picture is fine.
     */
    input: z.object({ url: z.string().min(1) }),
    output: z.object({ dataUrl: z.string() })
  },
  'scrape:loginStatus': {
    input: z.void(),
    output: z.object({ loggedIn: z.boolean() })
  },
  'scrape:login': {
    /** Opens the forum's own login page in a window; resolves once signed in. */
    input: z.void(),
    output: z.object({ loggedIn: z.boolean() })
  },
  'scrape:logout': {
    input: z.void(),
    output: z.void()
  },

  /**
   * Signing in to a download source. Only sources whose downloader reads the
   * app's session are listed.
   */
  'sites:list': {
    input: z.void(),
    output: z.object({
      sites: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          url: z.url(),
          /** Whether an account is needed to download from here at all. */
          need: z.enum(['no', 'some']),
          signedIn: z.boolean()
        })
      )
    })
  },
  'sites:login': {
    /** Opens the site in a window; resolves when the user closes it. */
    input: z.object({ id: z.string() }),
    output: z.object({ signedIn: z.boolean() })
  },
  'sites:signOut': {
    input: z.object({ id: z.string() }),
    output: z.void()
  },

  /**
   * The tag tree, the author and studio lists, the playlists and the saved
   * filters. Counts come with them: a filter row without a
   * count says nothing about whether ticking it is worth it.
   */
  'taxonomy:get': {
    input: z.void(),
    output: z.object({
      entities: z.record(
        z.enum(ENTITY_KINDS),
        z.array(
          z.object({
            name: z.string(),
            parent: z.string().nullable(),
            aliases: z.array(z.string()),
            description: z.string().nullable(),
            image: z.string().nullable(),
            /** Depth in the tree; the list is already in tree order. */
            depth: z.number().int().nonnegative(),
            /** Sort key inside the parent; what pinning a playlist sets. */
            order: z.number().int().nullable(),
            /** Media carrying this exact name. */
            count: z.number().int().nonnegative(),
            /** Including everything below it. */
            countWithDescendants: z.number().int().nonnegative()
          })
        )
      ),
      savedFilters: z.array(
        z.object({ id: z.uuid(), name: z.string(), filter: FilterNodeSchema })
      )
    })
  },
  'taxonomy:create': {
    input: z.object({ kind: z.enum(ENTITY_KINDS), name: z.string().min(1), parent: z.string().optional() }),
    output: z.void()
  },
  'taxonomy:update': {
    /** Renaming rewrites every sidecar carrying the old name. */
    input: z.object({
      kind: z.enum(ENTITY_KINDS),
      name: z.string().min(1),
      patch: z.object({
        name: z.string().optional(),
        parent: z.string().nullable().optional(),
        aliases: z.array(z.string()).optional(),
        description: z.string().optional(),
        image: z.string().optional(),
        order: z.number().int().optional()
      })
    }),
    output: z.object({ mediaRewritten: z.number().int().nonnegative() })
  },
  'taxonomy:delete': {
    /** Removes the name from the taxonomy and from every media carrying it. */
    input: z.object({ kind: z.enum(ENTITY_KINDS), name: z.string().min(1) }),
    output: z.object({ mediaRewritten: z.number().int().nonnegative() })
  },
  'taxonomy:merge': {
    input: z.object({ kind: z.enum(ENTITY_KINDS), from: z.string().min(1), into: z.string().min(1) }),
    output: z.object({ mediaRewritten: z.number().int().nonnegative() })
  },
  'taxonomy:setImage': {
    /**
     * Give an entity a cover picture, or clear it with a null path. The file is
     * copied into the app's own folder rather than referenced where it lies:
     * a taxonomy is app-level and outlives any one library, and a cover that
     * breaks when the user tidies their Pictures folder is not a cover.
     */
    input: z.object({
      kind: z.enum(ENTITY_KINDS),
      name: z.string().min(1),
      sourcePath: z.string().min(1).nullable()
    }),
    output: z.object({ dataUrl: z.string().nullable() })
  },
  'taxonomy:getImage': {
    /** The stored cover as a data URL; the renderer's CSP allows no file://. */
    input: z.object({ kind: z.enum(ENTITY_KINDS), name: z.string().min(1) }),
    output: z.object({ dataUrl: z.string().nullable() })
  },
  'taxonomy:queue': {
    /** Edits recorded but not yet run, from this session or the last one. */
    input: z.void(),
    output: z.object({ ops: z.array(QueuedOpSchema) })
  },
  'taxonomy:saveQueue': {
    input: z.object({ ops: z.array(QueuedOpSchema) }),
    output: z.void()
  },
  'taxonomy:saveFilter': {
    input: z.object({ name: z.string().min(1), filter: FilterNodeSchema }),
    output: z.object({ id: z.uuid() })
  },
  'taxonomy:deleteFilter': {
    input: z.object({ id: z.uuid() }),
    output: z.void()
  },

  'updates:state': {
    input: z.void(),
    output: UpdateStateSchema
  },
  'updates:check': {
    /** Look for a newer release on the configured channel; the result arrives as state. */
    input: z.void(),
    output: UpdateStateSchema
  },
  'updates:download': {
    /** Download the release the last check found; progress arrives as state. */
    input: z.void(),
    output: UpdateStateSchema
  },
  'updates:releases': {
    /** Every installable release, newest first. */
    input: z.void(),
    output: z.array(ReleaseSummarySchema)
  },
  'updates:install': {
    /** Download a specific release, older ones included, to replace this one. */
    input: z.object({ version: z.string().min(1) }),
    output: UpdateStateSchema
  },
  'updates:restart': {
    /** Quit and start again as the downloaded release. */
    input: z.void(),
    output: z.void()
  },
  'updates:skip': {
    /** Stop offering this version; a newer one is offered as usual. */
    input: z.object({ version: z.string().min(1) }),
    output: z.void()
  },
  'updates:startupNotices': {
    input: z.void(),
    output: StartupNoticesSchema
  },
  'updates:takePrompt': {
    /**
     * Is there a release to offer as part of the opening screen? True at most
     * once per run: read here, it is not offered again, so a window opened
     * later in the session is never interrupted by it.
     */
    input: z.void(),
    output: z.object({ offer: z.boolean() })
  },
  'updates:dismissWhatsNew': {
    input: z.void(),
    output: z.void()
  },
  'updates:dismissAnnouncement': {
    input: z.object({ id: z.string().min(1) }),
    output: z.void()
  },

  'settings:get': {
    input: z.void(),
    output: SettingsSchema
  },
  'settings:update': {
    /** Partial deep-merge update; main merges, re-validates, then persists. */
    input: z.record(z.string(), z.unknown()),
    output: SettingsSchema
  }
} as const

export type IpcContract = typeof ipcContract
export type IpcChannel = keyof IpcContract

export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>
export type IpcOutput<C extends IpcChannel> = z.output<IpcContract[C]['output']>

/**
 * main → renderer push events (subscriptions).
 * main sends via broadcast(); renderer subscribes via ipcOn().
 */
export const ipcEvents = {
  ...scriptPlayerIpcEvents,
  'event:open-settings': SettingsNavigationSchema,
  /**
   * The main window is being closed while a player has a window of its own:
   * ask before deciding its fate. Only the main window draws this, and it is
   * told which windows are open so it can name them.
   */
  'event:confirm-close': z.object({ video: z.boolean(), script: z.boolean() }),
  /** The main window appeared or went away; the detached players watch for it. */
  'event:main-window': z.object({ open: z.boolean() }),
  'event:libraries-changed': z.object({
    libraries: LibrariesFileSchema.shape.libraries
  }),
  'event:sync-progress': SyncProgressSchema,
  /** How far the startup sequence has got; only the startup card listens. */
  'event:startup': StartupStatusSchema,
  /** The library's index changed; media lists should be re-fetched. */
  'event:media-changed': z.object({ libraryId: z.uuid() }),
  /**
   * Something happened to a library that the window has to say out loud: the
   * disk holding it is full, or its index was damaged and got rebuilt. Startup
   * and add-library syncs are fire-and-forget — without this they would fail
   * only in the log.
   */
  'event:library-error': z.object({
    libraryId: z.uuid(),
    libraryName: z.string(),
    code: z.enum(APP_ERROR_CODES)
  }),
  /** The tag tree / entity lists changed; anything showing them reloads. */
  'event:taxonomy-changed': z.object({}),
  /** Currently playing media (null = idle/stopped). */
  'event:playback-changed': z.object({ mediaId: z.uuid().nullable() }),
  /** The queue, or the position in it, changed — including on auto-advance. */
  'event:queue-changed': QueueStateSchema,
  /** A job was added/removed or changed state; the list should be re-fetched. */
  'event:downloads-changed': z.object({}),
  /** Live rates for running jobs, batched at 4 Hz. */
  'event:download-progress': z.object({ jobs: z.array(DownloadProgressSchema) }),
  /** Install/update progress for yt-dlp or ffmpeg (the ffmpeg zip is large). */
  'event:dep-progress': InstallProgressSchema,
  /** The updater moved: checking, found a release, download progress, ready. */
  'event:update-state': UpdateStateSchema,

  /** How the library-wide post match is getting on. */
  'event:match-progress': MatchScanStatusSchema,
  /**
   * How far through a thread the scraper has read. A long thread is fetched a
   * page at a time behind a 1/s gate, so without this the panel would sit there
   * looking hung for ten seconds or more.
   */
  'event:scrape-progress': z.object({
    postsRead: z.number().int(),
    postsTotal: z.number().int()
  }),
  /** MultiFunPlayer's presence (sidebar); pushed on change. */
  'event:conn-status': z.object({
    /** Null off the MFP route: not part of this setup, so not reported on. */
    mfp: z.enum(['running', 'off']).nullable()
  }),
  /** The player list: connection state, and what each one is playing. */
  'event:playback-sources': z.array(MediaSourceStatusSchema),
  /** What the built-in picture should be showing; the surface matches it. */
  'event:video-intent': InternalPlayerIntentSchema,
  /** The picture moved between the main window and its own window. */
  'event:video-surface': z.object({ detached: z.boolean() })
} as const

export type IpcEvents = typeof ipcEvents
export type IpcEventChannel = keyof IpcEvents
export type IpcEventPayload<C extends IpcEventChannel> = z.output<IpcEvents[C]>

export { IPC_CHANNEL_PREFIXES, IPC_EVENT_PREFIX } from './channels'
