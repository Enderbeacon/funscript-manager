import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, DownloadCloud, ExternalLink, Heart, X } from 'lucide-react'
import type { MediaDetail, ScriptVersionInfo } from '@shared/schemas/media-index'
import { SCRIPT_AXIS_KEYS, type NameField } from '@shared/schemas/media-meta'
import type { MediaSelection } from '../App'
import WantedPanel from '../components/WantedPanel'
import HosterBadge from '../components/HosterBadge'
import DeleteMediaDialog from '../components/DeleteMediaDialog'
import RenameMediaDialog from '../components/RenameMediaDialog'
import NameChips, { KIND_COLOR, type Taxonomy } from '../components/NameChips'
import PostMatchFinder from '../components/PostMatchFinder'
import { NAME_FIELDS_UI, type NameFilter, type NamePick } from '../filters'
import Select from '../components/Select'
import { ipcInvoke, ipcOn } from '../ipc'
import { isPreviewable, mediaPreviewUrl } from '../mediaUrl'
import { useErrorMessage } from '../useErrorMessage'

/**
 * Single-media detail: preview + a heatmap
 * strip tight beneath it, then the playback actions, then the script-version
 * list. Selecting a version drives the heatmap and what the next play uses —
 * it never switches a running playback on its own; "switch playback" does
 * that, in place and preserving the position, and only shows up while
 * something is playing and the selection differs from it. Playing persists the
 * choice as lastUsedScriptVersionId (main side) for next time.
 */

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Hours only when there are any: 32:18 reads better than 0:32:18. */
function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s)
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Axis guessed from a funscript filename, matching the scanner's convention
 * (`clip.authorA.roll.funscript` → roll). The picker pre-fills it; the user
 * can always correct it before adding.
 */
function guessAxis(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  const segments = name.replace(/\.funscript$/i, '').split('.')
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!.toLowerCase()
    if ((SCRIPT_AXIS_KEYS as readonly string[]).includes(seg)) return seg
  }
  return 'main'
}

/** Filename minus the extension and any axis token — a decent version name. */
function suggestName(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  const segments = name.replace(/\.funscript$/i, '').split('.')
  const axis = guessAxis(filePath)
  const kept = segments.filter((s) => s.toLowerCase() !== axis)
  return (kept.length > 0 ? kept : segments).join('.')
}

/**
 * Real paths of the .funscript files in a drop. Electron 32 removed
 * `File.path`; the preload bridge is the only way back to a real path.
 */
function droppedScripts(e: React.DragEvent): string[] {
  return Array.from(e.dataTransfer.files)
    .map((f) => window.fsmgr.pathForFile(f))
    .filter((p) => p !== '' && /\.funscript$/i.test(p))
}

/** Default selection: lastUsed → isDefault → first. */
function initialVersionId(detail: MediaDetail): string | null {
  const { scriptVersions: vs, lastUsedScriptVersionId: last } = detail
  if (last && vs.some((v) => v.id === last)) return last
  return vs.find((v) => v.isDefault)?.id ?? vs[0]?.id ?? null
}

export default function MediaDetailPage({
  selection,
  onBack,
  picked,
  onPickName
}: {
  selection: MediaSelection
  onBack: () => void
  /** What the list behind the panel is filtered by, per kind of name. */
  picked: Record<NameField, NameFilter>
  /** Clicking a name here picks it the way its sidebar row would. */
  onPickName: (field: NameField, name: string, pick: NamePick) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [detail, setDetail] = useState<MediaDetail | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [thumb, setThumb] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [heatmap, setHeatmap] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [paused, setPaused] = useState(false)
  /** Version the playback is actually driving (null = video only / stopped). */
  const [playingVersionId, setPlayingVersionId] = useState<string | null>(null)
  const [positionMs, setPositionMs] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Non-error feedback (e.g. "these files were copied next to the media"). */
  const [notice, setNotice] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  /** Files dropped on the script section, waiting for the form to open on them. */
  const [droppedPaths, setDroppedPaths] = useState<string[]>([])
  const [dropping, setDropping] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [tab, setTab] = useState<'overview' | 'file' | 'source'>('overview')
  const [deleting, setDeleting] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  /** The title as the sidecar last reported it — what a draft is "clean" against. */
  const serverTitle = useRef('')
  // Latest selection for callbacks that must not re-subscribe.
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId

  const { libraryId, mediaId } = selection

  const loadDetail = useCallback(async () => {
    try {
      const d = await ipcInvoke('media:get', { libraryId, mediaId })
      if (!d) {
        setNotFound(true)
        return
      }
      setDetail(d)
      // This runs on every index change, not only when the panel opens. A
      // half-typed title is the user's; only a field they have not touched
      // follows what came back.
      const title = d.title ?? ''
      setTitleDraft((cur) => (cur === serverTitle.current ? title : cur))
      serverTitle.current = title
      setSelectedId((cur) =>
        cur && d.scriptVersions.some((v) => v.id === cur) ? cur : initialVersionId(d)
      )
      setError(null)
    } catch (e) {
      setError(toMessage(e))
    }
  }, [libraryId, mediaId, toMessage])

  // Initial detail + thumbnail + current playing state.
  useEffect(() => {
    void loadDetail()
    ipcInvoke('media:getThumbnail', { libraryId, mediaId })
      .then(({ dataUrl }) => setThumb(dataUrl))
      .catch(() => setThumb(null))
    ipcInvoke('playback:status')
      .then((s) => {
        const mine = s.mediaId === mediaId
        setPlaying(mine)
        setPaused(mine && s.paused === true)
        setPlayingVersionId(mine ? s.scriptVersionId : null)
      })
      .catch(() => {})
  }, [libraryId, mediaId, loadDetail])

  // Push events: index changes (scripts edited on disk) + playback state.
  useEffect(() => {
    const offChanged = ipcOn('event:media-changed', ({ libraryId: lib }) => {
      if (lib === libraryId) void loadDetail()
    })
    const offPlayback = ipcOn('event:playback-changed', ({ mediaId: playingMedia }) =>
      setPlaying(playingMedia === mediaId)
    )
    return () => {
      offChanged()
      offPlayback()
    }
  }, [libraryId, mediaId, loadDetail])

  // Live position + pause readout while this media plays (extrapolated clock).
  useEffect(() => {
    if (!playing) {
      setPositionMs(null)
      setPaused(false)
      setPlayingVersionId(null)
      return
    }
    let alive = true
    const tick = (): void => {
      ipcInvoke('playback:status')
        .then((s) => {
          if (!alive) return
          const mine = s.mediaId === mediaId
          setPositionMs(mine ? s.positionMs : null)
          setPaused(mine && s.paused === true)
          setPlayingVersionId(mine ? s.scriptVersionId : null)
        })
        .catch(() => {})
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [playing, mediaId])

  // Heatmap follows the selected version.
  useEffect(() => {
    if (!selectedId) {
      setHeatmap(null)
      return
    }
    let alive = true
    ipcInvoke('media:getHeatmap', { libraryId, mediaId, scriptVersionId: selectedId })
      .then(({ dataUrl }) => alive && setHeatmap(dataUrl))
      .catch(() => alive && setHeatmap(null))
    return () => {
      alive = false
    }
  }, [libraryId, mediaId, selectedId])

  // The vocabulary the chip pickers offer; reloaded when it changes anywhere.
  useEffect(() => {
    const load = (): void => {
      ipcInvoke('taxonomy:get').then(setTaxonomy).catch(() => setTaxonomy(null))
    }
    load()
    return ipcOn('event:taxonomy-changed', load)
  }, [])

  /** Both writes go straight to the sidecar; the panel shows what came back. */
  const saveNames = async (field: NameField, names: string[]): Promise<void> => {
    setBusy(true)
    try {
      setDetail(await ipcInvoke('media:setNames', { libraryId, mediaId, field, names }))
      setError(null)
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const saveTitle = (): void => {
    if (!detail || titleDraft === (detail.title ?? '')) return
    setBusy(true)
    ipcInvoke('media:setUserMeta', { libraryId, mediaId, title: titleDraft })
      .then((d) => {
        setDetail(d)
        serverTitle.current = d.title ?? ''
      })
      .catch((e) => setError(toMessage(e)))
      .finally(() => setBusy(false))
  }

  const saveRating = async (rating: number | null): Promise<void> => {
    setBusy(true)
    try {
      setDetail(await ipcInvoke('media:setUserMeta', { libraryId, mediaId, rating }))
      setError(null)
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const saveSources = async (sources: MediaDetail['sources']): Promise<void> => {
    setBusy(true)
    try {
      setDetail(await ipcInvoke('media:setSources', { libraryId, mediaId, sources }))
      setError(null)
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Read the forum post this media came from and take what it says.
   *
   * Applied straight away rather than previewed: nothing is replaced or
   * removed, so the worst a wrong link does is add a few tags that can be
   * taken off again. What it did is reported afterwards, because "it worked"
   * and "it found nothing" look identical otherwise.
   */
  const fetchFromPost = async (url: string, setTitle = false): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await ipcInvoke('media:applyPostLink', {
        targets: [{ libraryId, mediaId }],
        postUrl: url,
        setTitle
      })
      await loadDetail()
      setError(null)
      const added =
        result.tagsAdded.length + result.scriptAuthorsAdded.length + result.videoAuthorsAdded.length
      setNotice(
        added === 0 && !result.titlesSet
          ? t('detail.fetchPostNothing', { title: result.postTitle })
          : t('detail.fetchPostDone', {
              title: result.postTitle,
              tags: result.tagsAdded.length,
              authors: result.scriptAuthorsAdded.length
            })
      )
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const saveFavorite = async (favorite: boolean): Promise<void> => {
    setBusy(true)
    try {
      setDetail(await ipcInvoke('media:setUserMeta', { libraryId, mediaId, favorite }))
      setError(null)
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const playVersion = useCallback(
    async (
      versionId: string | null,
      resumePosition: boolean,
      noScript = false
    ): Promise<void> => {
      setBusy(true)
      try {
        const res = await ipcInvoke('playback:play', {
          libraryId,
          mediaId,
          ...(versionId && !noScript ? { scriptVersionId: versionId } : {}),
          ...(noScript ? { noScript: true } : {}),
          resumePosition
        })
        setPlayingVersionId(res.scriptVersionId)
        if (res.scriptVersionId) setSelectedId(res.scriptVersionId)
        setError(null)
      } catch (e) {
        setError(toMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [libraryId, mediaId, toMessage]
  )

  const setDefaultVersion = useCallback(
    async (versionId: string): Promise<void> => {
      setBusy(true)
      try {
        const d = await ipcInvoke('media:setDefaultScriptVersion', {
          libraryId,
          mediaId,
          scriptVersionId: versionId
        })
        if (d) setDetail(d)
        setError(null)
      } catch (e) {
        setError(toMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [libraryId, mediaId, toMessage]
  )

  const setInheritAxes = useCallback(
    async (versionId: string, inherit: boolean): Promise<void> => {
      setBusy(true)
      try {
        const d = await ipcInvoke('media:setVersionInheritAxes', {
          libraryId,
          mediaId,
          scriptVersionId: versionId,
          inherit
        })
        if (d) setDetail(d)
        setError(null)
        // Applies to the axes being driven right now, so reload in place.
        if (playing && versionId === playingVersionId) {
          await playVersion(versionId, true)
        }
      } catch (e) {
        setError(toMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [libraryId, mediaId, playing, playingVersionId, playVersion, toMessage]
  )

  const updateVersion = useCallback(
    async (versionId: string, edit: VersionEdit): Promise<void> => {
      setBusy(true)
      try {
        const d = await ipcInvoke('media:updateScriptVersion', {
          libraryId,
          mediaId,
          scriptVersionId: versionId,
          ...edit
        })
        if (d) setDetail(d)
        setError(null)
      } catch (e) {
        setError(toMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [libraryId, mediaId, toMessage]
  )

  /**
   * Add every version the form built, one call each — the sidecar takes one
   * version at a time. Stops at the first failure and reports how many landed,
   * so the form can drop those and keep the rest for a retry.
   */
  const addVersions = useCallback(
    async (inputs: AddVersionInput[]): Promise<number> => {
      setBusy(true)
      const copied: string[] = []
      let added = 0
      let failure: string | null = null
      try {
        for (const input of inputs) {
          const res = await ipcInvoke('media:addScriptVersion', { libraryId, mediaId, ...input })
          added++
          copied.push(...res.copied)
          if (res.detail) {
            setDetail(res.detail)
            // Land on what was just added: it is the last entry.
            const last = res.detail.scriptVersions.at(-1)
            if (last) setSelectedId(last.id)
          }
        }
      } catch (e) {
        failure = toMessage(e)
      } finally {
        setBusy(false)
      }
      setError(failure)
      setNotice(
        copied.length > 0 ? t('detail.addVersionCopied', { files: copied.join(', ') }) : null
      )
      return added
    },
    [libraryId, mediaId, t, toMessage]
  )

  const deleteVersion = useCallback(
    async (versionId: string): Promise<void> => {
      setBusy(true)
      try {
        const res = await ipcInvoke('media:deleteScriptVersion', {
          libraryId,
          mediaId,
          scriptVersionId: versionId
        })
        if (res.detail) {
          setDetail(res.detail)
          setSelectedId((cur) =>
            cur && res.detail!.scriptVersions.some((v) => v.id === cur)
              ? cur
              : initialVersionId(res.detail!)
          )
        }
        // Sidecar entry is gone either way; only the file move can fail.
        setError(
          res.failed.length > 0
            ? t('detail.deleteFilesFailed', { files: res.failed.join(', ') })
            : null
        )
      } catch (e) {
        setError(toMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [libraryId, mediaId, t, toMessage]
  )

  /*
   * Whether there is any player to play into at all.
   *
   * Not "is one connected": pressing play connects the first player that can
   * take a file, and for mpv that also starts it — which is the whole point of
   * having it in the list. Only an empty list leaves the button with nothing
   * to do, and then it says so rather than failing on the click.
   */
  const [hasPlayer, setHasPlayer] = useState(true)

  useEffect(() => {
    const apply = (sources: { capabilities: { open: boolean } }[]): void =>
      setHasPlayer(sources.some((source) => source.capabilities.open))
    ipcInvoke('playback:sources').then(apply).catch(() => {})
    return ipcOn('event:playback-sources', apply)
  }, [])

  // Pause, never stop: mpv's stop unloads the file and an mpv started by MFP
  // has no --idle, so it would quit.
  const togglePause = useCallback(async (): Promise<void> => {
    const next = !paused
    setPaused(next) // optimistic; the 1s status poll corrects it
    try {
      await ipcInvoke('playback:setPaused', { paused: next })
    } catch (e) {
      setPaused(!next)
      setError(toMessage(e))
    }
  }, [paused, toMessage])

  // Selecting a version only stages it — switching what is actually playing is
  // an explicit action (the "switch playback" button), so a stray click never
  // reloads a running session.
  const selectVersion = (versionId: string): void => {
    if (versionId === selectedRef.current) return
    setSelectedId(versionId)
  }

  /** Head row: whatever the panel is showing, plus the way out of it. */
  const head = (title: string, extra?: React.ReactNode): React.JSX.Element => (
    <div className="panel-head">
      <span className="grow" title={title}>
        {title}
      </span>
      {extra}
      <button
        className="panel-close"
        onClick={onBack}
        title={t('detail.close')}
        aria-label={t('detail.close')}
      >
        ✕
      </button>
    </div>
  )

  if (notFound) {
    return (
      <div className="panel">
        {head(t('detail.notFound'))}
        <div className="panel-body">
          <div className="empty">{t('detail.notFound')}</div>
        </div>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="panel">
        {head('…')}
        <div className="panel-body">
          {error ? <div className="error-banner">{error}</div> : <div className="empty">…</div>}
        </div>
      </div>
    )
  }

  const canPlay = !detail.missing
  // "Switch playback" only makes sense once something is playing and the user
  // has picked a different version than the one driving it.
  const canSwitch = playing && selectedId !== null && selectedId !== playingVersionId

  return (
    <div className="panel">
      {head(
        detail.title ?? detail.fileName,
        /* Beside the title, because it is a judgement about this one media —
           the same place the rating lives, one level up. */
        <button
          className={`panel-star${detail.favorite ? ' on' : ''}`}
          disabled={busy}
          onClick={() => void saveFavorite(!detail.favorite)}
          title={t(detail.favorite ? 'media.batch.favoriteOff' : 'media.batch.favoriteOn')}
          aria-label={t(detail.favorite ? 'media.batch.favoriteOff' : 'media.batch.favoriteOn')}
          aria-pressed={detail.favorite}
        >
          <Heart size={16} fill={detail.favorite ? 'currentColor' : 'none'} />
        </button>
      )}

      {/* Tabs stay put: the overview is the working surface, and losing the way
          back to it partway down a version list is how you lose your place. */}
      <div className="ptabs">
        {(['overview', 'file', 'source'] as const).map((key) => (
          <button key={key} className={`ptab${tab === key ? ' on' : ''}`} onClick={() => setTab(key)}>
            {t(`detail.tab.${key}`)}
          </button>
        ))}
      </div>

      <div className="panel-body">
        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="detail-notice">{notice}</div>}

        <div className="detail-preview">
          {thumb ? (
            <img className="detail-thumb" src={thumb} alt="" />
          ) : (
            <span className="detail-preview-ext">
              {detail.fileName.split('.').pop()?.toUpperCase()}
            </span>
          )}
          {!detail.missing && isPreviewable(detail.fileName) && !previewFailed && (
            <video
              className="detail-preview-video"
              src={mediaPreviewUrl(libraryId, mediaId)}
              muted
              autoPlay
              loop
              playsInline
              preload="metadata"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget
                if (Number.isFinite(v.duration)) v.currentTime = Math.min(v.duration * 0.1, 20)
              }}
              onError={() => setPreviewFailed(true)}
            />
          )}
          {positionMs !== null && <span className="detail-timestamp">{formatTime(positionMs)}</span>}
        </div>

        <div className={`detail-heatmap${heatmap ? '' : ' empty'}`}>
          {heatmap && <img src={heatmap} alt="" />}
        </div>

        <div className="detail-panel-body">
          {detail.wanted ? (
            <WantedPanel detail={detail} onFilled={() => void loadDetail()} onMerged={onBack} />
          ) : (
            detail.missing && (
              <div className="detail-missing">
                <span className="badge danger">{t('media.badges.missing')}</span>
              </div>
            )
          )}

          {tab === 'overview' && (
          <>
          {/* Dropping funscripts anywhere on this section opens the form with
              them. While it is open the form takes the drop itself, so the
              files always land in the list the user is looking at. */}
          <div
            className={`detail-scripts${dropping ? ' dropping' : ''}`}
            onDragOver={(e) => {
              if (adding || busy || !e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              setDropping(true)
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={(e) => {
              if (adding || busy) return
              e.preventDefault()
              setDropping(false)
              const paths = droppedScripts(e)
              if (paths.length === 0) return
              setDroppedPaths(paths)
              setAdding(true)
            }}
          >
          <div className="detail-section-header">
            <span className="detail-section-label">{t('detail.scripts')}</span>
            <span className="detail-section-meta">
              {t('detail.versions', { count: detail.scriptVersions.length })}
              {/* The form carries its own cancel, so this only opens it. */}
              {!adding && (
                <button
                  className="ghost detail-add-version"
                  disabled={busy}
                  onClick={() => {
                    setDroppedPaths([])
                    setAdding(true)
                  }}
                >
                  + {t('detail.addVersion')}
                </button>
              )}
            </span>
          </div>

          {adding && (
            <AddVersionForm
              disabled={busy}
              initialPaths={droppedPaths}
              onCancel={() => setAdding(false)}
              onSubmit={async (inputs) => {
                const added = await addVersions(inputs)
                if (added === inputs.length) setAdding(false)
                return added
              }}
            />
          )}

          {detail.scriptVersions.length === 0 ? (
            <div className="empty detail-noversions">{t('detail.noVersions')}</div>
          ) : (
            <ul className="version-list">
              {detail.scriptVersions.map((v) => (
                <VersionRow
                  key={v.id}
                  version={v}
                  selected={v.id === selectedId}
                  isLastUsed={v.id === detail.lastUsedScriptVersionId}
                  disabled={busy}
                  onSelect={() => selectVersion(v.id)}
                  onSetDefault={() => void setDefaultVersion(v.id)}
                  onDelete={() => void deleteVersion(v.id)}
                  onToggleInherit={() => void setInheritAxes(v.id, !v.inheritAxes)}
                  onEdit={(edit) => void updateVersion(v.id, edit)}
                />
              ))}
            </ul>
          )}
          </div>

          {/* One row per kind, edited in place. Six headings on their own
              lines was most of the panel. */}
          <div className="detail-section-header">
            <span className="detail-section-label">{t('media.info.title')}</span>
          </div>
          {NAME_FIELDS_UI.map((field) => (
            <div className="mrow" key={field}>
              <span className="mk">
                <i className="chip-dot" style={{ background: KIND_COLOR[field] }} />
                {t(`media.filter.kind.${field}`)}
              </span>
              <NameChips
                field={field}
                names={detail[field]}
                taxonomy={taxonomy}
                compact
                picked={picked[field]}
                onPick={(name, pick) => onPickName(field, name, pick)}
                confirmRemove
                onChange={(names) => void saveNames(field, names)}
              />
            </div>
          ))}
          <div className="mrow">
            <span className="mk">{t('media.info.rating')}</span>
            <span className="fstars">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={`fstar${(detail.rating ?? 0) >= n ? ' on' : ''}`}
                  disabled={busy}
                  onClick={() => void saveRating(detail.rating === n ? null : n)}
                  aria-label={t('media.filter.ratingAtLeast', { n })}
                >
                  ★
                </button>
              ))}
            </span>
          </div>
          </>
          )}

          {tab === 'file' && (
            <>
              <div className="lab">{t('detail.titleField')}</div>
              <input
                className="settings-input"
                value={titleDraft}
                disabled={busy}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => e.key === 'Enter' && saveTitle()}
              />

              <div className="lab">{t('detail.file')}</div>
              <div className="box">
                <div className="kv">
                  <span>{t('detail.fileName')}</span>
                  <span className="kv-v">{detail.fileName}</span>
                </div>
                <div className="kv">
                  <span>{t('detail.size')}</span>
                  <span className="kv-v">{formatSize(detail.fileSize) || '—'}</span>
                </div>
                {/* Absent means not probed yet, not zero — so the row goes. */}
                {detail.durationMs !== null && (
                  <div className="kv">
                    <span>{t('media.field.durationMs')}</span>
                    <span className="kv-v">{formatDuration(detail.durationMs)}</span>
                  </div>
                )}
                {(detail.codec || detail.resolution) && (
                  <div className="kv">
                    <span>{t('detail.codec')}</span>
                    <span className="kv-v">
                      {[detail.codec, detail.resolution].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                )}
                <div className="kv">
                  <span>{t('detail.addedAt')}</span>
                  <span className="kv-v">{detail.createdAt ? detail.createdAt.slice(0, 10) : '—'}</span>
                </div>
              </div>

              <div className="lab">{t('detail.location')}</div>
              <div className="box path">{detail.absPath || detail.filePath}</div>
              <div className="row detail-file-actions">
                {/* Works for a placeholder too: it lands in the folder the
                    video is expected in. */}
                <button
                  className="ghost"
                  onClick={() => void ipcInvoke('media:reveal', { libraryId, mediaId }).catch(() => {})}
                >
                  {t('detail.reveal')}
                </button>
                <button className="ghost" disabled={busy} onClick={() => setRenaming(true)}>
                  {t('media.rename.action')}
                </button>
                {/* Last, and the only one that reads as a warning: the two
                    others here rearrange things, this one can end them. */}
                <button className="ghost danger" disabled={busy} onClick={() => setDeleting(true)}>
                  {t('media.delete.action')}
                </button>
              </div>

              {/* Only shown when there is one: a placeholder has no file to hash. */}
              {detail.fingerprint && (
                <>
                  <div className="lab">{t('detail.fingerprint')}</div>
                  <div className="box path muted">
                    blake3 · {detail.fingerprint.slice(0, 16)}… ·{' '}
                    {detail.fileSize?.toLocaleString() ?? '—'} B
                  </div>
                </>
              )}

              <div className="lab">{t('detail.companions')}</div>
              <div className="box">
                <div className="kv">
                  <span>{t('detail.scripts')}</span>
                  <span className="kv-v">
                    {t('detail.scriptFiles', {
                      count: detail.scriptVersions.reduce((n, v) => n + v.files.length, 0)
                    })}
                  </span>
                </div>
                <div className="kv">
                  <span>{t('detail.versionsLabel')}</span>
                  <span className="kv-v">{detail.scriptVersions.length}</span>
                </div>
                <div className="kv">
                  <span>{t('detail.subtitles')}</span>
                  <span className="kv-v">
                    {detail.subtitles.length === 0
                      ? '—'
                      : `${detail.subtitles.length} · ${detail.subtitles.map((s) => s.language ?? '?').join(', ')}`}
                  </span>
                </div>
              </div>
            </>
          )}

          {tab === 'source' && (
            <>
              <SourceList
                sources={detail.sources}
                libraryId={libraryId}
                mediaId={mediaId}
                disabled={busy}
                onSave={(sources) => void saveSources(sources)}
                onFetchPost={(url) => void fetchFromPost(url)}
                onPickMatch={(url) => void fetchFromPost(url, true)}
              />
              <OtherLinks links={detail.postLinks} />
            </>
          )}
        </div>
      </div>

      {/* Playing is what the panel is for, so it stays reachable from anywhere
          in it — including the bottom of a long version list. */}
      {canPlay && (
        <div className="panel-foot detail-actions">
          <button
            className="primary detail-play-btn grow"
            disabled={busy || (!hasPlayer && !playing)}
            title={!hasPlayer && !playing ? t('detail.noPlayer') : undefined}
            onClick={() => (playing ? void togglePause() : void playVersion(selectedId, false))}
          >
            {!playing
              ? `▶ ${t('media.play')}`
              : paused
                ? `▶ ${t('detail.resume')}`
                : `⏸ ${t('detail.pause')}`}
          </button>
          {canSwitch && (
            <button
              className="ghost detail-switch-btn"
              disabled={busy}
              onClick={() => void playVersion(selectedId, true)}
            >
              {t('detail.switchScript')}
            </button>
          )}
          {detail.scriptVersions.length > 0 && (
            <button
              className="ghost detail-play-video-btn"
              disabled={busy || (!hasPlayer && !playing)}
              title={!hasPlayer && !playing ? t('detail.noPlayer') : t('detail.playVideoOnlyHint')}
              // Available mid-playback too: dropping the script keeps the
              // current position, it just stops driving the device.
              onClick={() => void playVersion(null, playing, true)}
            >
              {t('detail.playVideoOnly')}
            </button>
          )}
          {!hasPlayer && <span className="detail-play-note">{t('detail.noPlayer')}</span>}
        </div>
      )}

      {deleting && (
        <DeleteMediaDialog
          targets={[{ libraryId, mediaId }]}
          onClose={() => setDeleting(false)}
          onDone={() => {
            setDeleting(false)
            // The entry this panel is about no longer exists; staying open to
            // show "not found" would be the panel arguing with itself.
            onBack()
          }}
        />
      )}

      {renaming && (
        <RenameMediaDialog
          libraryId={libraryId}
          mediaId={mediaId}
          currentName={detail.fileName}
          onClose={() => setRenaming(false)}
          onDone={() => {
            setRenaming(false)
            void loadDetail()
          }}
        />
      )}
    </div>
  )
}

/** Fields of a version the detail page can edit (main merges, null clears). */
interface VersionEdit {
  name?: string
  author?: string | null
  sourceUrl?: string | null
  notes?: string | null
}

interface AddVersionInput {
  name: string
  /** Axis → absolute path of a picked .funscript; `main` is required. */
  files: Record<string, string>
}

function VersionRow({
  version,
  selected,
  isLastUsed,
  disabled,
  onSelect,
  onSetDefault,
  onDelete,
  onToggleInherit,
  onEdit
}: {
  version: ScriptVersionInfo
  selected: boolean
  isLastUsed: boolean
  disabled: boolean
  onSelect: () => void
  onSetDefault: () => void
  onDelete: () => void
  onToggleInherit: () => void
  onEdit: (edit: VersionEdit) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  // Collapsing the row (or a finished delete) must not leave a primed confirm.
  useEffect(() => {
    if (!selected) {
      setConfirmingDelete(false)
      setEditing(false)
    }
  }, [selected])
  // Axes as badges rather than a line of text: solid is this version's own,
  // outlined is borrowed from the default multi-axis one. Four versions each
  // spelling out "↳ main · roll · pitch · surge" was most of the panel.
  const borrowed = new Set(version.borrowedAxes)
  const shown = [...new Set([...version.axes, ...version.borrowedAxes])]
  const order = SCRIPT_AXIS_KEYS.filter((a) => shown.includes(a))

  return (
    <li className={`version-item${selected ? ' selected' : ''}`}>
      <button className="version-row" onClick={onSelect} disabled={disabled}>
        <span className={`version-radio${selected ? ' on' : ''}`} />
        <span className="version-name" title={version.author ? `${version.name} · ${version.author}` : version.name}>
          {version.name}
        </span>
        {/* Who wrote it, on the row rather than in a tooltip. Which scripter's
            version this is is the main thing people choose between, and the
            name of the version is often just a file-name fragment. Hidden when
            it repeats the version name, which is what grouping falls back to. */}
        {version.author && version.author !== version.name && (
          <span className="version-author" title={version.author}>
            {version.author}
          </span>
        )}
        {version.isDefault && <span className="version-flag">{t('detail.default')}</span>}
        {isLastUsed && !version.isDefault && <span className="version-flag">{t('detail.lastUsed')}</span>}
        <span className="version-axes-badges">
          {order.map((axis) => (
            <span
              key={axis}
              className={`ax${borrowed.has(axis) ? ' borrowed' : ''}`}
              title={t(borrowed.has(axis) ? 'detail.axisBorrowed' : 'detail.axisOwn', { axis })}
            >
              {axis === 'main' ? 'M' : axis[0]!.toUpperCase()}
            </span>
          ))}
        </span>
      </button>
      {selected && (
        <div className="version-detail">
          <span className="version-axes">↳ {version.axes.join(' · ')}</span>
          {version.sourceUrl && (
            <a
              className="version-source"
              href={version.sourceUrl}
              target="_blank"
              rel="noreferrer"
              title={version.sourceUrl}
            >
              🔗 {version.sourceUrl}
            </a>
          )}
          {version.notes && <span className="version-notes">{version.notes}</span>}
          {editing ? (
            <EditVersionForm
              version={version}
              disabled={disabled}
              onCancel={() => setEditing(false)}
              onSubmit={(edit) => {
                setEditing(false)
                onEdit(edit)
              }}
            />
          ) : confirmingDelete ? (
            <div className="version-confirm">
              <span className="version-confirm-text">
                {t('detail.deleteConfirm')}
                <span className="version-confirm-files">{version.files.join(' · ')}</span>
              </span>
              <span className="version-confirm-buttons">
                <button
                  className="danger"
                  disabled={disabled}
                  onClick={() => {
                    setConfirmingDelete(false)
                    onDelete()
                  }}
                >
                  {t('detail.deleteVersion')}
                </button>
                <button className="ghost" disabled={disabled} onClick={() => setConfirmingDelete(false)}>
                  {t('detail.cancel')}
                </button>
              </span>
            </div>
          ) : (
            <div className="version-actions">
              {version.canInheritAxes && (
                <button
                  className={`ghost version-inherit${version.inheritAxes ? ' on' : ''}`}
                  disabled={disabled}
                  onClick={onToggleInherit}
                  title={
                    version.inheritedFrom
                      ? t('detail.inheritAxesFrom', { name: version.inheritedFrom })
                      : undefined
                  }
                >
                  {version.inheritAxes ? '☑' : '☐'} {t('detail.inheritAxes')}
                </button>
              )}
              {!version.isDefault && (
                <button className="ghost" disabled={disabled} onClick={onSetDefault}>
                  {t('detail.setDefault')}
                </button>
              )}
              <button className="ghost" disabled={disabled} onClick={() => setEditing(true)}>
                {t('detail.editVersion')}
              </button>
              <button className="ghost" disabled={disabled} onClick={() => setConfirmingDelete(true)}>
                {t('detail.deleteVersion')}
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * Rename + author / source / notes for one version. Only the fields the user
 * actually changed are sent, so a concurrent edit elsewhere is not overwritten
 * by stale form values; clearing a field sends null.
 */
function EditVersionForm({
  version,
  disabled,
  onCancel,
  onSubmit
}: {
  version: ScriptVersionInfo
  disabled: boolean
  onCancel: () => void
  onSubmit: (edit: VersionEdit) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(version.name)
  const [author, setAuthor] = useState(version.author ?? '')
  const [sourceUrl, setSourceUrl] = useState(version.sourceUrl ?? '')
  const [notes, setNotes] = useState(version.notes ?? '')

  const submit = (): void => {
    const edit: VersionEdit = {}
    if (name.trim() !== version.name) edit.name = name.trim()
    if (author.trim() !== (version.author ?? '')) edit.author = author.trim() || null
    if (sourceUrl.trim() !== (version.sourceUrl ?? '')) edit.sourceUrl = sourceUrl.trim() || null
    if (notes.trim() !== (version.notes ?? '')) edit.notes = notes.trim() || null
    onSubmit(edit)
  }

  return (
    <form
      className="version-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label className="version-field">
        <span>{t('detail.versionName')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="version-field">
        <span>{t('detail.versionAuthor')}</span>
        <input value={author} onChange={(e) => setAuthor(e.target.value)} />
      </label>
      <label className="version-field">
        <span>{t('detail.versionSource')}</span>
        <input
          type="url"
          placeholder="https://…"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
        />
      </label>
      <label className="version-field">
        <span>{t('detail.versionNotes')}</span>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="version-actions">
        <button className="primary" type="submit" disabled={disabled || !name.trim()}>
          {t('detail.save')}
        </button>
        <button className="ghost" type="button" disabled={disabled} onClick={onCancel}>
          {t('detail.cancel')}
        </button>
      </div>
    </form>
  )
}

/** The three kinds of address a media can carry, in the order they read. */
const SOURCE_TYPES = ['eroscripts', 'original', 'other'] as const

type MediaSource = MediaDetail['sources'][number]

function sameSources(a: MediaSource[], b: MediaSource[]): boolean {
  return a.length === b.length && a.every((s, i) => s.url === b[i]?.url && s.type === b[i]?.type)
}

/**
 * Is this an address, or words to search the forum with? A scheme — or a host
 * followed by a path — says the user has already found the post and is telling
 * us where it is, so there is nothing left to look for.
 */
function looksLikeUrl(text: string): boolean {
  const value = text.trim()
  return /^https?:\/\/\S+$/i.test(value) || /^[\w-]+(\.[\w-]+)+\/\S+$/.test(value)
}

/** Host of a URL, for the line under the address. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Where this media came from — and, for anything the app did not download
 * itself, where the user says it came from.
 *
 * A download fills this in on its own (the post, and the address the bytes
 * actually came from). Everything else in a library arrived some other way, so
 * the list is editable: rows can be added, retyped and removed. Nothing is
 * written until Save, because a half-typed URL is not a correction.
 */
function SourceList({
  sources,
  libraryId,
  mediaId,
  disabled,
  onSave,
  onFetchPost,
  onPickMatch
}: {
  sources: MediaSource[]
  libraryId: string
  mediaId: string
  disabled: boolean
  onSave: (sources: MediaSource[]) => void
  /** Read the post at this URL and fold what it says into the media. */
  onFetchPost: (url: string) => void
  /**
   * The user said a searched-for post IS this entry. Same fold-in, except the
   * post's title becomes the entry's — that is the answer to "what is this
   * scene called", and a filename is not worth keeping over it.
   */
  onPickMatch: (url: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<MediaSource[]>(sources)
  const [adding, setAdding] = useState('')
  /** Typed into an empty fixed slot and not committed yet, by slot. */
  const [pending, setPending] = useState<Partial<Record<MediaSource['type'], string>>>({})
  const draftRef = useRef(draft)
  draftRef.current = draft
  /** The rows as the sidecar last reported them — what a draft is "clean" against. */
  const server = useRef(sources)

  // The panel can be looking at a different media than it was a moment ago —
  // but it also reloads whenever the index moves, and rows being edited must
  // survive that.
  useEffect(() => {
    if (sameSources(draftRef.current, server.current)) {
      setDraft(sources)
      setAdding('')
      setPending({})
    }
    server.current = sources
  }, [sources])

  const dirty = !sameSources(draft, sources)

  const add = (): void => {
    const url = adding.trim()
    if (!url) return
    // eroscripts links identify themselves; anything else is the user's own
    // note about where this came from until they say otherwise.
    const type: MediaSource['type'] = /discuss\.eroscripts\.com/i.test(url) ? 'eroscripts' : 'other'
    setDraft((cur) => [...cur, { type, url }])
    setAdding('')
  }

  /**
   * Two of these rows are not the user's to classify: the post the scene was
   * found in, and the address this copy actually came down from. Those are
   * facts about the download, so they get a fixed label instead of a kind
   * picker — a dropdown there only offers the chance to mislabel them. The
   * slots are shown even when empty, because "no post link recorded" is worth
   * knowing and is somewhere to paste one.
   */
  const fixedIndex = (type: MediaSource['type']): number => draft.findIndex((s) => s.type === type)
  const postAt = fixedIndex('eroscripts')
  const downloadAt = fixedIndex('original')
  const extras = draft
    .map((source, index) => ({ source, index }))
    .filter(({ index }) => index !== postAt && index !== downloadAt)

  /**
   * Take what has been typed into an empty slot. Pasting the post link is
   * almost always the first half of "and take its tags", so that happens in
   * the same breath rather than leaving the button to be found.
   */
  const commitFixed = (type: MediaSource['type']): void => {
    const url = (pending[type] ?? '').trim()
    if (!url) return
    setPending((cur) => ({ ...cur, [type]: '' }))
    setDraft((cur) => [...cur, { type, url }])
    if (type === 'eroscripts') onFetchPost(url)
  }

  const fixedRow = (type: MediaSource['type'], index: number): React.JSX.Element => {
    const typed = pending[type] ?? ''
    return (
    <div className="src-row fixed" key={type}>
      <span className="src-fixed-kind">{t(`detail.sourceKind.${type}`)}</span>
      {index === -1 ? (
        <>
          <input
            className="search grow"
            value={typed}
            disabled={disabled}
            placeholder={t('detail.sourceFixedEmpty')}
            onChange={(e) => setPending((cur) => ({ ...cur, [type]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitFixed(type)
            }}
          />
          {/* The link is not taken until something says so, and Enter is not
              something. A pasted address gets the button that reads it; the
              other slot just records what it is given. */}
          {(type === 'eroscripts' ? looksLikeUrl(typed) : typed.trim().length > 0) && (
            <button className="ghost sm" disabled={disabled} onClick={() => commitFixed(type)}>
              {type === 'eroscripts' && <DownloadCloud size={13} />}
              {t(type === 'eroscripts' ? 'detail.fetchPost' : 'detail.addSource')}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="src-main">
            <a
              className="src-url"
              href={draft[index]!.url}
              target="_blank"
              rel="noreferrer"
              title={draft[index]!.url}
            >
              {draft[index]!.url}
            </a>
            <span className="src-host">{hostOf(draft[index]!.url)}</span>
          </div>
          {type === 'eroscripts' && (
            <button
              className="ghost sm"
              disabled={disabled}
              title={t('detail.fetchPostHint')}
              onClick={() => onFetchPost(draft[index]!.url)}
            >
              <DownloadCloud size={13} />
              {t('detail.fetchPost')}
            </button>
          )}
          <button
            className="icon-btn"
            disabled={disabled}
            title={t('detail.removeSource')}
            aria-label={t('detail.removeSource')}
            onClick={() => setDraft((cur) => cur.filter((_, i) => i !== index))}
          >
            <X size={14} />
          </button>
        </>
      )}
    </div>
    )
  }

  return (
    <div className="src-list">
      {fixedRow('eroscripts', postAt)}
      {/* Offered while the slot is empty and nothing has been pasted into it:
          searching for a post whose address is sitting in the box above is not
          what the click means, and that button is where the eye goes. Applying
          a pick is the same fill-from-post as pasting the link, which records
          the source itself. */}
      {postAt === -1 && !looksLikeUrl(pending.eroscripts ?? '') && (
        <PostMatchFinder
          libraryId={libraryId}
          mediaId={mediaId}
          disabled={disabled}
          onPick={onPickMatch}
        />
      )}
      {fixedRow('original', downloadAt)}

      {extras.length > 0 && <div className="lab">{t('detail.sourcesExtra')}</div>}

      {extras.map(({ source, index }) => (
        <div className="src-row" key={`${source.url}:${index}`}>
          <div className="src-main">
            <a className="src-url" href={source.url} target="_blank" rel="noreferrer" title={source.url}>
              {source.url}
            </a>
            <span className="src-host">{hostOf(source.url)}</span>
          </div>
          {/* Only the ones the user added themselves get a kind: the two above
              already know what they are. */}
          <Select
            className="src-type"
            value={source.type}
            disabled={disabled}
            ariaLabel={t('detail.sourceType')}
            options={SOURCE_TYPES.map((type) => ({
              value: type,
              label: t(`detail.sourceKind.${type}`)
            }))}
            onChange={(type) =>
              setDraft((cur) => cur.map((s, i) => (i === index ? { ...s, type } : s)))
            }
          />
          <button
            className="icon-btn"
            disabled={disabled}
            title={t('detail.removeSource')}
            aria-label={t('detail.removeSource')}
            onClick={() => setDraft((cur) => cur.filter((_, i) => i !== index))}
          >
            <X size={14} />
          </button>
        </div>
      ))}

      <div className="src-add">
        <input
          className="search"
          value={adding}
          disabled={disabled}
          placeholder={t('detail.addSourcePlaceholder')}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <button className="ghost" disabled={disabled || !adding.trim()} onClick={add}>
          {t('detail.addSource')}
        </button>
      </div>

      {dirty && (
        <div className="src-foot">
          <button className="primary" disabled={disabled} onClick={() => onSave(draft)}>
            {t('detail.save')}
          </button>
          <button className="ghost" disabled={disabled} onClick={() => setDraft(sources)}>
            {t('detail.cancel')}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The post's links the app has no downloader for — a shop, a Patreon, someone's
 * own host. Folded away because there is nothing to decide about them: they are
 * kept so that a year from now, when the post is gone, the sidecar still says
 * where else this could be got.
 */
function OtherLinks({
  links
}: {
  links: { url: string; hoster: string; label: string }[]
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (links.length === 0) return null

  return (
    <div className="other-links">
      <button className="other-links-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={13} className={open ? 'rot' : ''} />
        {t('detail.otherLinks', { count: links.length })}
      </button>
      {open && (
        <div className="wanted-sources">
          {links.map((link) => (
            <div className="wanted-source" key={link.url}>
              <HosterBadge
                hoster={link.hoster}
                {...(link.hoster === 'unknown' ? { label: hostOf(link.url) } : {})}
              />
              <span className="wanted-source-label" title={link.url}>
                {link.label || link.url}
              </span>
              <a className="ghost" href={link.url} target="_blank" rel="noreferrer">
                <ExternalLink size={13} />
                {t('posts.openSite')}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Manually add versions from funscript files anywhere on disk, picked or
 * dropped — scripts outside the media's folder are never grouped
 * automatically, so this is the only way they become versions. The form builds as many versions as the files describe —
 * each one a name plus at most one file per axis, `main` required, the shape
 * the sidecar stores.
 */

/** One version being built: a name and the files assigned to it. */
interface DraftVersion {
  id: number
  name: string
}

interface DraftFile {
  path: string
  axis: string
  versionId: number
}

interface Draft {
  versions: DraftVersion[]
  files: DraftFile[]
  nextId: number
}

/**
 * Each new file starts a version of its own, so picking four main scripts adds
 * four versions rather than a conflict. A non-main axis instead joins the
 * version whose suggested name it shares, when that version has no such axis
 * yet — `clip.a` and `clip.a.roll` are one version by every convention the
 * scanner uses. Anything mis-grouped is moved with the version picker.
 */
function addPaths(draft: Draft, paths: string[]): Draft {
  const versions = [...draft.versions]
  const files = [...draft.files]
  let nextId = draft.nextId
  for (const path of paths) {
    if (files.some((f) => f.path === path)) continue
    const axis = guessAxis(path)
    const name = suggestName(path)
    const host =
      axis === 'main'
        ? undefined
        : versions.find(
            (v) => v.name === name && !files.some((f) => f.versionId === v.id && f.axis === axis)
          )
    const versionId = host?.id ?? nextId++
    if (!host) versions.push({ id: versionId, name })
    files.push({ path, axis, versionId })
  }
  return { versions, files, nextId }
}

/** A version with no files left is not a version. */
function pruneEmpty(draft: Draft): Draft {
  return {
    ...draft,
    versions: draft.versions.filter((v) => draft.files.some((f) => f.versionId === v.id))
  }
}

function AddVersionForm({
  disabled,
  initialPaths,
  onCancel,
  onSubmit
}: {
  disabled: boolean
  /** Files dropped before the form opened; picked up once, on mount. */
  initialPaths: string[]
  onCancel: () => void
  /** Adds the versions and answers how many of them landed. */
  onSubmit: (inputs: AddVersionInput[]) => Promise<number>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Draft>(() =>
    addPaths({ versions: [], files: [], nextId: 1 }, initialPaths)
  )
  const [dropping, setDropping] = useState(false)

  const pick = async (): Promise<void> => {
    const { paths } = await ipcInvoke('dialog:pickScripts', { title: t('detail.pickScripts') })
    if (paths.length > 0) setDraft((cur) => addPaths(cur, paths))
  }

  const filesOf = (versionId: number): DraftFile[] =>
    draft.files.filter((f) => f.versionId === versionId)

  const setAxis = (path: string, axis: string): void =>
    setDraft((cur) => ({
      ...cur,
      files: cur.files.map((f) => (f.path === path ? { ...f, axis } : f))
    }))

  /** `new` splits the file off into a version of its own. */
  const setVersion = (path: string, target: string): void =>
    setDraft((cur) => {
      if (target !== 'new') {
        const versionId = Number(target)
        return pruneEmpty({
          ...cur,
          files: cur.files.map((f) => (f.path === path ? { ...f, versionId } : f))
        })
      }
      const versionId = cur.nextId
      return pruneEmpty({
        versions: [...cur.versions, { id: versionId, name: suggestName(path) }],
        files: cur.files.map((f) => (f.path === path ? { ...f, versionId } : f)),
        nextId: versionId + 1
      })
    })

  const removeFile = (path: string): void =>
    setDraft((cur) => pruneEmpty({ ...cur, files: cur.files.filter((f) => f.path !== path) }))

  const rename = (versionId: number, name: string): void =>
    setDraft((cur) => ({
      ...cur,
      versions: cur.versions.map((v) => (v.id === versionId ? { ...v, name } : v))
    }))

  const problemOf = (versionId: number): 'duplicateAxis' | 'needsMain' | null => {
    const axes = filesOf(versionId).map((f) => f.axis)
    if (new Set(axes).size !== axes.length) return 'duplicateAxis'
    if (!axes.includes('main')) return 'needsMain'
    return null
  }

  const canSubmit =
    draft.versions.length > 0 &&
    draft.versions.every((v) => v.name.trim().length > 0 && problemOf(v.id) === null)

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    const inputs = draft.versions.map((v) => ({
      name: v.name.trim(),
      files: Object.fromEntries(filesOf(v.id).map((f) => [f.axis, f.path]))
    }))
    const added = await onSubmit(inputs)
    // Whatever landed is in the list now; the rest stays here for a retry.
    if (added > 0 && added < inputs.length) {
      const kept = new Set(draft.versions.slice(added).map((v) => v.id))
      setDraft((cur) =>
        pruneEmpty({
          ...cur,
          versions: cur.versions.filter((v) => kept.has(v.id)),
          files: cur.files.filter((f) => kept.has(f.versionId))
        })
      )
    }
  }

  const versionOptions = [
    ...draft.versions.map((v, i) => ({
      value: String(v.id),
      label: v.name.trim() || `#${i + 1}`
    })),
    { value: 'new', label: t('detail.newVersion') }
  ]

  return (
    <form
      className={`version-form add-version-form${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.stopPropagation()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDropping(false)
        const paths = droppedScripts(e)
        if (paths.length > 0) setDraft((cur) => addPaths(cur, paths))
      }}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="add-version-pick">
        <button className="ghost" type="button" disabled={disabled} onClick={() => void pick()}>
          {t('detail.pickScripts')}
        </button>
        <span className="add-version-hint">{t('detail.dropScripts')}</span>
      </div>

      {draft.versions.map((version, i) => {
        const problem = problemOf(version.id)
        return (
          <div className="add-version-group" key={version.id}>
            <label className="version-field">
              <span>{t('detail.versionName')}</span>
              <input value={version.name} onChange={(e) => rename(version.id, e.target.value)} />
            </label>

            {filesOf(version.id).map((file) => (
              <div className="add-version-file" key={file.path}>
                <span className="add-version-name" title={file.path}>
                  {file.path.split(/[\\/]/).pop()}
                </span>
                <Select
                  className="axis"
                  value={file.axis}
                  disabled={disabled}
                  ariaLabel={t('detail.fileAxis')}
                  onChange={(axis) => setAxis(file.path, axis)}
                  options={SCRIPT_AXIS_KEYS.map((a) => ({ value: a, label: a }))}
                />
                <Select
                  className="version-pick"
                  value={String(version.id)}
                  disabled={disabled}
                  ariaLabel={t('detail.fileVersion')}
                  onChange={(target) => setVersion(file.path, target)}
                  options={versionOptions}
                />
                <button
                  className="ghost"
                  type="button"
                  disabled={disabled}
                  title={t('detail.removeFile')}
                  aria-label={t('detail.removeFile')}
                  onClick={() => removeFile(file.path)}
                >
                  ✕
                </button>
              </div>
            ))}

            {problem === 'duplicateAxis' && (
              <span className="add-version-warn">{t('detail.addVersionDuplicateAxis')}</span>
            )}
            {problem === 'needsMain' && (
              <span className="add-version-warn">{t('detail.addVersionNeedsMain')}</span>
            )}
            {i === draft.versions.length - 1 && (
              <span className="add-version-hint">{t('detail.addVersionHint')}</span>
            )}
          </div>
        )
      })}

      <div className="version-actions">
        <button className="primary" type="submit" disabled={disabled || !canSubmit}>
          {draft.versions.length > 1
            ? t('detail.addVersionsCount', { count: draft.versions.length })
            : t('detail.addVersion')}
        </button>
        <button className="ghost" type="button" disabled={disabled} onClick={onCancel}>
          {t('detail.cancel')}
        </button>
      </div>
    </form>
  )
}
