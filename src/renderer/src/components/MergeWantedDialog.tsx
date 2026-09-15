import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { MediaListItem } from '@shared/schemas/media-index'
import { ipcInvoke } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { useEscape } from '../useEscape'

/**
 * Fold placeholder entries into the one that survives.
 *
 * A video and the scripts posted with it land under names close enough for a
 * person and too far apart for the scanner, and the library ends up holding the
 * scene twice — or several times over, once per scripter who posted for it. The
 * automatic offer only fires on a name match, which is exactly what did not
 * happen here, so this asks instead.
 *
 * Two ways in, one dialog. From a placeholder's own panel there is one entry to
 * fold and the target has to be searched for; from the grid the rows are
 * already chosen and the only question is which of them stays.
 */

const CANDIDATE_LIMIT = 60

export interface MergeRow {
  mediaId: string
  name: string
  path: string
  /** Still waiting for its file — the only kind that can be folded away. */
  wanted: boolean
}

export default function MergeWantedDialog({
  libraryId,
  from,
  rows,
  onClose,
  onDone
}: {
  libraryId: string
  /** Panel: the single entry to fold; the dialog searches for its target. */
  from?: MergeRow
  /** Grid: everything selected; the survivor is chosen among these. */
  rows?: MergeRow[]
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [search, setSearch] = useState('')
  const [candidates, setCandidates] = useState<MediaListItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only one row can survive a merge of placeholders alone; with a real entry
  // among them there is no choice to make, so it is simply the one.
  const forced = useMemo(() => rows?.find((r) => !r.wanted) ?? null, [rows])
  const [picked, setPicked] = useState<string | null>(
    forced?.mediaId ?? rows?.[0]?.mediaId ?? null
  )

  useEscape(onClose, !busy)

  // Same library only: script paths in a sidecar are relative to its own root.
  useEffect(() => {
    if (rows) return
    let live = true
    const timer = setTimeout(() => {
      void ipcInvoke('media:list', {
        libraryId,
        offset: 0,
        limit: CANDIDATE_LIMIT,
        ...(search.trim() ? { search: search.trim() } : {})
      })
        .then((page) => {
          if (!live) return
          setCandidates(page.items.filter((i) => i.id !== from?.mediaId && !i.wanted))
        })
        .catch((e) => live && setError(toMessage(e)))
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [libraryId, from?.mediaId, search, rows, toMessage])

  const sourceIds = rows
    ? rows.filter((r) => r.mediaId !== picked).map((r) => r.mediaId)
    : from
      ? [from.mediaId]
      : []

  const run = async (): Promise<void> => {
    if (!picked || sourceIds.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await ipcInvoke('library:mergeWanted', { libraryId, targetId: picked, sourceIds })
      onDone()
    } catch (e) {
      setError(toMessage(e))
      setBusy(false)
    }
  }

  return (
    <div className="modal-scrim">
      <div className="modal merge-modal">
        <div className="modal-head">
          <span className="grow">{t('media.merge.title')}</span>
          <button className="ghost sm" disabled={busy} onClick={onClose} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          {rows ? (
            <>
              <div className="lab">{t('media.merge.keepWhich')}</div>
              <div className="box merge-list">
                {rows.map((row) => (
                  <button
                    key={row.mediaId}
                    className={`merge-row${picked === row.mediaId ? ' on' : ''}`}
                    disabled={busy || (forced !== null && row.wanted)}
                    onClick={() => setPicked(row.mediaId)}
                  >
                    <span className={`version-radio${picked === row.mediaId ? ' on' : ''}`} />
                    <span className="merge-row-name" title={row.path}>
                      {row.name}
                    </span>
                    {row.wanted && (
                      <span className="merge-row-flag">{t('media.badges.wanted')}</span>
                    )}
                    <span className="merge-row-path" title={row.path}>
                      {row.path}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="lab">{t('media.merge.pickTarget', { from: from?.name ?? '' })}</div>
              <input
                className="search"
                value={search}
                autoFocus
                disabled={busy}
                placeholder={t('media.merge.searchPlaceholder')}
                onChange={(e) => setSearch(e.target.value)}
              />

              <div className="box merge-list">
                {candidates === null ? (
                  <div className="empty">…</div>
                ) : candidates.length === 0 ? (
                  <div className="empty">{t('media.merge.noCandidates')}</div>
                ) : (
                  candidates.map((item) => (
                    <button
                      key={item.id}
                      className={`merge-row${picked === item.id ? ' on' : ''}`}
                      disabled={busy}
                      onClick={() => setPicked(item.id)}
                    >
                      <span className={`version-radio${picked === item.id ? ' on' : ''}`} />
                      <span className="merge-row-name" title={item.filePath}>
                        {item.title || item.fileName}
                      </span>
                      <span className="merge-row-path" title={item.filePath}>
                        {item.filePath}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}

          <div className="mixed-note">{t('media.merge.note')}</div>
        </div>

        <div className="modal-foot">
          <div className="grow" />
          <button className="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="primary"
            disabled={busy || !picked || sourceIds.length === 0}
            onClick={() => void run()}
          >
            {t('media.merge.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
