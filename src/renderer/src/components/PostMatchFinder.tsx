import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import type { PostCandidate, PostMatchResult } from '@shared/schemas/post-match'
import { ipcInvoke } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'

/**
 * "Which forum post is this?" for an entry that has no post link.
 *
 * The app searches with the entry's own names and shows what came back with
 * the reason for each, because the reason is the only thing that makes a
 * candidate checkable — a title alone looks equally plausible whether the
 * evidence behind it was a matching script filename or three shared words.
 *
 * Nothing is applied here. Picking one hands the URL up to the same
 * fill-from-post the user gets when pasting a link by hand.
 */
export default function PostMatchFinder({
  libraryId,
  mediaId,
  disabled,
  onPick
}: {
  libraryId: string
  mediaId: string
  disabled: boolean
  onPick: (url: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PostMatchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** Which entry the shown result belongs to, so a panel switch clears it. */
  const forMedia = useRef(mediaId)

  useEffect(() => {
    if (forMedia.current === mediaId) return
    forMedia.current = mediaId
    setOpen(false)
    setResult(null)
    setQuery('')
    setError(null)
  }, [mediaId])

  const run = async (override?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const found = await ipcInvoke('match:findPost', {
        libraryId,
        mediaId,
        ...(override ? { query: override } : {})
      })
      setResult(found)
      // Seed the box with what was actually asked, so re-asking is an edit
      // rather than retyping the filename from scratch.
      if (!override && found.queriesTried.length > 0) setQuery(found.queriesTried[0]!.query)
    } catch (e) {
      setError(toMessage(e))
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        className="ghost sm"
        disabled={disabled}
        title={t('match.findHint')}
        onClick={() => {
          setOpen(true)
          void run()
        }}
      >
        <Search size={13} />
        {t('match.find')}
      </button>
    )
  }

  return (
    <div className="postmatch">
      <div className="postmatch-head">
        <input
          className="search grow"
          value={query}
          disabled={busy}
          placeholder={t('match.queryPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) void run(query.trim())
          }}
        />
        <button className="ghost sm" disabled={busy || !query.trim()} onClick={() => void run(query.trim())}>
          {t('match.searchAgain')}
        </button>
        <button
          className="icon-btn"
          title={t('match.close')}
          aria-label={t('match.close')}
          onClick={() => setOpen(false)}
        >
          <X size={14} />
        </button>
      </div>

      {busy && <div className="postmatch-note">{t('match.searching')}</div>}
      {error && <div className="err">{error}</div>}

      {!busy && result && result.candidates.length === 0 && (
        <div className="postmatch-note">{t('match.nothing')}</div>
      )}

      {!busy &&
        result?.candidates.map((candidate) => (
          <Candidate
            key={candidate.topicId}
            candidate={candidate}
            disabled={disabled}
            onPick={() => onPick(candidate.url)}
          />
        ))}
    </div>
  )
}

function Candidate({
  candidate,
  disabled,
  onPick
}: {
  candidate: PostCandidate
  disabled: boolean
  onPick: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className={`postmatch-row tier-${candidate.tier}`}>
      <div className="postmatch-main">
        <div className="postmatch-title">
          <span className={`postmatch-tier tier-${candidate.tier}`}>
            {t(`match.tier.${candidate.tier}`)}
          </span>
          <a href={candidate.url} target="_blank" rel="noreferrer" title={candidate.url}>
            {candidate.title}
          </a>
        </div>
        <div className="postmatch-why">
          {candidate.evidence.map((e) => (
            <span key={e.kind} className={`postmatch-ev ev-${e.kind}`}>
              {t(`match.why.${e.kind}`, { detail: e.detail })}
            </span>
          ))}
        </div>
        <div className="postmatch-meta">
          {candidate.author && <span>{t('match.by', { author: candidate.author })}</span>}
          {candidate.tags.length > 0 && <span>{candidate.tags.slice(0, 6).join(' · ')}</span>}
          {candidate.alreadyLinked && (
            <span className="postmatch-linked">{t('match.alreadyLinked')}</span>
          )}
        </div>
      </div>
      <button className="ghost sm" disabled={disabled} onClick={onPick}>
        {t('match.use')}
      </button>
    </div>
  )
}
