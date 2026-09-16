import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CircleCheck,
  Download,
  ExternalLink,
  FolderOpen,
  Link as LinkIcon,
  Merge,
  TriangleAlert
} from 'lucide-react'
import type { MediaDetail } from '@shared/schemas/media-index'
import HosterBadge from './HosterBadge'
import MergeWantedDialog from './MergeWantedDialog'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'

/**
 * The entry exists, the file does not. Everything the post
 * carried is already filed; this is the one thing outstanding, so it says where
 * to get it and gives the three ways to hand it over:
 *
 *   - point at a file already on disk
 *   - drop one onto the panel
 *   - paste a direct link and let the queue fetch it
 *
 * The paste route is what the posts page used to offer for Payhip. It belongs
 * here instead: pasting a link is something you do *after* paying, which is
 * minutes or days after the post was parsed.
 */
export default function WantedPanel({
  detail,
  onFilled,
  onMerged
}: {
  detail: MediaDetail
  onFilled: () => void
  /** The entry was folded into another one and no longer exists. */
  onMerged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [merging, setMerging] = useState(false)
  const [directUrl, setDirectUrl] = useState('')
  /** Files already in the library whose name matches what this entry wants. */
  const [matches, setMatches] = useState<
    { mediaId: string; filePath: string; fileName: string }[]
  >([])

  const loadMatches = useCallback(() => {
    ipcInvoke('library:wantedMatches', { libraryId: detail.libraryId, mediaId: detail.id })
      .then((r) => setMatches(r.matches))
      .catch(() => setMatches([]))
  }, [detail.libraryId, detail.id])

  useEffect(() => {
    loadMatches()
    // A file dropped into the library root shows up on the next scan, not on
    // this render — so re-ask whenever the index moves.
    return ipcOn('event:media-changed', loadMatches)
  }, [loadMatches])

  const attach = async (sourcePath: string): Promise<void> => {
    setBusy(true)
    try {
      await ipcInvoke('library:attachWanted', {
        libraryId: detail.libraryId,
        mediaId: detail.id,
        sourcePath
      })
      setError(null)
      onFilled()
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const pick = async (): Promise<void> => {
    const { path } = await ipcInvoke('dialog:pickFile', { title: t('wanted.pickTitle') })
    if (path) await attach(path)
  }

  const queue = async (): Promise<void> => {
    const url = directUrl.trim()
    if (!url) return
    setBusy(true)
    try {
      // Tied to this entry, so the file fills it whatever name it arrives under.
      await ipcInvoke('download:add', { url, libraryId: detail.libraryId, mediaId: detail.id })
      setDirectUrl('')
      setPasting(false)
      setError(null)
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`wanted${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        const file = e.dataTransfer.files[0]
        // Electron exposes the real path on dropped files; without one there is
        // nothing to copy from.
        const path = file ? window.fsmgr.pathForFile(file) : ''
        if (path) void attach(path)
      }}
    >
      <div className="wanted-head">
        <TriangleAlert size={14} />
        {t('wanted.title')}
      </div>
      {detail.wanted && detail.wanted.sources.length > 0 && (
        <>
          <div className="wanted-sub">{t('wanted.sourcesHint')}</div>
          <div className="wanted-sources">
            {detail.wanted.sources.map((s) => (
              <div className="wanted-source" key={s.url}>
                <HosterBadge hoster={s.hoster} {...(s.hoster === 'unknown' ? { label: hostOf(s.url) } : {})} />
                <span className="wanted-source-label" title={s.url}>
                  {s.label || s.url}
                </span>
                <a className="ghost" href={s.url} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} />
                  {t('posts.openSite')}
                </a>
              </div>
            ))}
          </div>
        </>
      )}

      {error && <div className="error-banner">{error}</div>}

      {/* A file already in the library that shares this entry's name. Asked,
          never applied: a name match is a good guess and a bad decision to
          make on someone's behalf. */}
      {matches.map((match) => (
        <div className="wanted-guess" key={match.mediaId}>
          <CircleCheck size={15} />
          <span className="wanted-guess-text">
            {t('wanted.matchQuestion', { file: match.fileName })}
          </span>
          <span className="wanted-guess-acts">
            <button
              className="ghost"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                ipcInvoke('library:dismissWantedMatch', {
                  libraryId: detail.libraryId,
                  mediaId: detail.id,
                  candidateId: match.mediaId
                })
                  .then(() => setMatches((cur) => cur.filter((m) => m.mediaId !== match.mediaId)))
                  .catch((e) => setError(toMessage(e)))
                  .finally(() => setBusy(false))
              }}
            >
              {t('wanted.matchNo')}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                ipcInvoke('library:linkWanted', {
                  libraryId: detail.libraryId,
                  mediaId: detail.id,
                  candidateId: match.mediaId
                })
                  // This entry is gone now; the metadata lives on the file.
                  .then(() => onMerged())
                  .catch((e) => setError(toMessage(e)))
                  .finally(() => setBusy(false))
              }}
            >
              {t('wanted.matchYes')}
            </button>
          </span>
        </div>
      ))}

      <div className="wanted-acts">
        <button className="primary" disabled={busy} onClick={() => void pick()}>
          <FolderOpen size={15} />
          {t('wanted.pickFile')}
        </button>
        <button className="ghost" disabled={busy} onClick={() => setPasting((v) => !v)}>
          <LinkIcon size={15} />
          {t('wanted.pasteLink')}
        </button>
        {/* The guesses above only appear on a name match, which is the one
            thing that failed when a scene ends up filed twice. */}
        <button className="ghost" disabled={busy} onClick={() => setMerging(true)}>
          <Merge size={15} />
          {t('wanted.mergeInto')}
        </button>
      </div>

      {merging && (
        <MergeWantedDialog
          libraryId={detail.libraryId}
          from={{
            mediaId: detail.id,
            name: detail.title || detail.fileName,
            path: detail.filePath,
            wanted: true
          }}
          onClose={() => setMerging(false)}
          onDone={() => {
            setMerging(false)
            onMerged()
          }}
        />
      )}

      {pasting && (
        <div className="wanted-paste">
          <input
            className="settings-input"
            type="url"
            value={directUrl}
            placeholder={t('wanted.pastePlaceholder')}
            onChange={(e) => setDirectUrl(e.target.value)}
          />
          <button className="primary" disabled={busy || !directUrl.trim()} onClick={() => void queue()}>
            <Download size={15} />
            {t('wanted.queue')}
          </button>
        </div>
      )}

      <div className="wanted-drop">{t('wanted.dropHint')}</div>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
