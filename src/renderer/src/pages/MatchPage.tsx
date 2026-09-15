import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Link2, Pause, Play, Search, SkipForward, Square, X } from 'lucide-react'
import type { MatchQueueItem, MatchScanStatus, PostCandidate } from '@shared/schemas/post-match'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'

/**
 * Finding the forum posts a whole library came from.
 *
 * Two halves that run independently. The pass at the top asks the forum about
 * every entry that has no post recorded — hours of work at one search every
 * couple of seconds, so it pauses, resumes and survives being left alone. The
 * queue below is what the user actually spends time on, and it is built to be
 * worked with the keyboard alone: a library with two thousand entries is not a
 * list anybody is going to click through.
 *
 * Only conclusive matches are applied by the pass itself. Everything on this
 * page is a resemblance waiting for a person to say yes.
 */

const PAGE_SIZE = 40

export default function MatchPage(): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [status, setStatus] = useState<MatchScanStatus | null>(null)
  const [items, setItems] = useState<MatchQueueItem[]>([])
  const [queued, setQueued] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Which candidate of the current entry is in focus (keyboard picks this one). */
  const [pick, setPick] = useState(0)

  /**
   * Entries decided in this session, by `libraryId:mediaId`.
   *
   * Deciding does not wait for the write, so a refill that lands in between
   * would read the entry back out of the queue database still marked `queued`
   * and put it straight back on screen — the user confirms a match and the same
   * card is still sitting there. Anything in this set is filtered out of every
   * refill, whatever the database currently says.
   */
  const decided = useRef(new Set<string>())
  const keyOf = (item: { libraryId: string; mediaId: string }): string =>
    `${item.libraryId}:${item.mediaId}`

  /** Bumped whenever something might mean there is more to load. */
  const [needsRefill, setNeedsRefill] = useState(0)

  /** One refill at a time; several events can ask for one at once. */
  const refilling = useRef(false)

  const loadQueue = useCallback(async () => {
    if (refilling.current) return
    refilling.current = true
    try {
      const page = await ipcInvoke('match:queue', { limit: PAGE_SIZE, offset: 0 })
      setItems(page.items.filter((item) => !decided.current.has(keyOf(item))))
      setQueued(page.queued)
      setError(null)
    } catch (e) {
      setError(toMessage(e))
    } finally {
      refilling.current = false
    }
  }, [toMessage])

  useEffect(() => {
    void loadQueue()
    ipcInvoke('match:status').then(setStatus).catch(() => {})
    // The pass keeps adding to the queue underneath the reviewer. Its progress
    // events are the cue to top up — the refill itself only happens when the
    // local list has run out, so rows never shuffle mid-decision.
    const off = ipcOn('event:match-progress', (next) => {
      setStatus(next)
      setNeedsRefill((n) => n + 1)
    })
    return off
  }, [loadQueue])

  useEffect(() => {
    if (items.length === 0) void loadQueue()
  }, [items.length, needsRefill, loadQueue])

  const current = items[cursor] ?? null
  useEffect(() => setPick(0), [cursor])

  // Removing the last row leaves the cursor past the end; walking back one is
  // the only correction it ever needs.
  useEffect(() => {
    setCursor((c) => (c > 0 && c >= items.length ? Math.max(0, items.length - 1) : c))
  }, [items.length])

  /**
   * Take an entry off the queue. Identity, not position: the list can be
   * refilled between a decision and this running, and an index would then
   * remove somebody else.
   */
  const advance = useCallback((item: MatchQueueItem) => {
    decided.current.add(keyOf(item))
    setItems((cur) => cur.filter((row) => keyOf(row) !== keyOf(item)))
    setQueued((n) => Math.max(0, n - 1))
  }, [])

  /**
   * Accepting moves on at once and lets the write happen behind it.
   *
   * Reviewing a queue is a rhythm, and waiting for a disk write between every
   * decision breaks it — over a few hundred entries that wait is most of the
   * time spent. The write cannot fail in a way that needs the entry back on
   * screen either: `match:apply` reads the candidate the app already scored and
   * writes one sidecar, so the only failures are a locked file or a full disk,
   * and those get said out loud rather than silently re-queued.
   */
  const accept = useCallback(
    (item: MatchQueueItem, candidate: PostCandidate) => {
      advance(item)
      setNotice(t('match.applying', { title: candidate.title }))
      ipcInvoke('match:apply', {
        libraryId: item.libraryId,
        mediaId: item.mediaId,
        topicId: candidate.topicId
      })
        .then((result) => {
          setNotice(t('match.applied', { title: result.postTitle, tags: result.tagsAdded.length }))
        })
        .catch((e) => setError(`${item.fileName}: ${toMessage(e)}`))
    },
    [advance, t, toMessage]
  )

  /** Same rule as accepting: the screen moves, the sidecar catches up. */
  const reject = useCallback(
    (item: MatchQueueItem, candidate: PostCandidate) => {
      // Whether the entry is finished is decided from what is on screen, not
      // from what the write comes back with — that is the whole point of not
      // waiting for it.
      if (item.candidates.length <= 1) {
        advance(item)
      } else {
        setItems((cur) =>
          cur.map((row) =>
            keyOf(row) === keyOf(item)
              ? { ...row, candidates: row.candidates.filter((c) => c.topicId !== candidate.topicId) }
              : row
          )
        )
        setPick(0)
      }
      ipcInvoke('match:reject', {
        libraryId: item.libraryId,
        mediaId: item.mediaId,
        topicId: candidate.topicId
      }).catch((e) => setError(`${item.fileName}: ${toMessage(e)}`))
    },
    [advance, toMessage]
  )

  const settle = useCallback(
    (item: MatchQueueItem) => {
      advance(item)
      ipcInvoke('match:settle', { libraryId: item.libraryId, mediaId: item.mediaId }).catch((e) =>
        setError(`${item.fileName}: ${toMessage(e)}`)
      )
    },
    [advance, toMessage]
  )

  /**
   * Keyboard review — the difference between working through a queue and
   * clicking through one.
   *
   * Both hands are catered for: WASD and the arrows navigate the same way, so
   * the hand that is not on the mouse can do it. That is why "none of these"
   * sits on X — it used to be S, which is now the down key.
   *
   * Held in a ref so the listener does not resubscribe on every state change.
   */
  const handlers = useRef({ current, pick, accept, reject, settle, advance })
  handlers.current = { current, pick, accept, reject, settle, advance }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const h = handlers.current
      if (!h.current) return
      const candidate = h.current.candidates[h.pick]
      switch (e.key.toLowerCase()) {
        case 'y':
        case 'enter':
          if (candidate) h.accept(h.current, candidate)
          break
        case 'n':
          if (candidate) h.reject(h.current, candidate)
          break
        // Not `s`: that is the down key on the other half of the keyboard, and
        // "none of these" is not something to do by reaching for a direction.
        case 'x':
          h.settle(h.current)
          break
        case 's':
        case 'arrowdown':
          e.preventDefault()
          setPick((p) => Math.min(p + 1, h.current!.candidates.length - 1))
          break
        case 'w':
        case 'arrowup':
          e.preventDefault()
          setPick((p) => Math.max(0, p - 1))
          break
        case 'd':
        case 'arrowright':
          e.preventDefault()
          setCursor((c) => c + 1)
          break
        case 'a':
        case 'arrowleft':
          e.preventDefault()
          setCursor((c) => Math.max(0, c - 1))
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const running = status?.running === true
  const paused = status?.paused === true

  return (
    <div className="match-page">
      <h1 className="page-title">
        <Link2 size={19} />
        {t('nav.match')}
      </h1>
      <div className="page-sub">{t('match.pageSub')}</div>

      <section className="match-run">
        <div className="match-run-actions">
          {!running && (
            <button
              data-tour="match-start"
              className="primary"
              onClick={() => {
                void ipcInvoke('match:start', { libraryIds: [], rescan: false }).catch((e) =>
                  setError(toMessage(e))
                )
              }}
            >
              <Play size={14} />
              {t('match.startScan')}
            </button>
          )}
          {running && !paused && (
            <button className="ghost" onClick={() => void ipcInvoke('match:pause')}>
              <Pause size={14} />
              {t('match.pause')}
            </button>
          )}
          {running && paused && (
            <button className="primary" onClick={() => void ipcInvoke('match:resume')}>
              <Play size={14} />
              {t('match.resume')}
            </button>
          )}
          {running && (
            <button className="ghost" onClick={() => void ipcInvoke('match:stop')}>
              <Square size={13} />
              {t('match.stop')}
            </button>
          )}
        </div>

        {status && (running || status.scanned > 0) && (
          <>
            <div className="match-bar">
              <div
                className="match-bar-fill"
                style={{
                  width: `${status.total > 0 ? Math.round((status.scanned / status.total) * 100) : 0}%`
                }}
              />
            </div>
            <div className="match-run-stats">
              <span>{t('match.progress', { done: status.scanned, total: status.total })}</span>
              <span>{t('match.autoApplied', { count: status.applied })}</span>
              <span>{t('match.foundNone', { count: status.none })}</span>
              {status.currentPath && <span className="match-current">{status.currentPath}</span>}
            </div>
          </>
        )}

        {/* A run that stopped because the forum said no carries the reason, not
            a silent halt: the counters would otherwise just stop moving. */}
        {status?.error && <div className="error-banner">{toMessage(status.error)}</div>}
      </section>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="detail-notice">{notice}</div>}

      <section className="match-review" data-tour="match-review">
        <div className="match-review-head">
          <h2>{t('match.queueTitle', { count: queued })}</h2>
          <span className="match-keys">{t('match.keys')}</span>
        </div>

        {!current && <p className="empty">{t('match.queueEmpty')}</p>}

        {current && (
          <div className="match-card">
            <div className="match-local">
              <div className="match-local-name" title={current.filePath}>
                {current.fileName}
              </div>
              <div className="match-local-path">{current.filePath}</div>
            </div>

            <div className="match-candidates">
              {current.candidates.map((candidate, index) => (
                <div
                  key={candidate.topicId}
                  className={`postmatch-row tier-${candidate.tier}${index === pick ? ' picked' : ''}`}
                  onMouseEnter={() => setPick(index)}
                >
                  <div className="postmatch-main">
                    <div className="postmatch-title">
                      <span className={`postmatch-tier tier-${candidate.tier}`}>
                        {t(`match.tier.${candidate.tier}`)}
                      </span>
                      <a href={candidate.url} target="_blank" rel="noreferrer">
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
                      {candidate.tags.length > 0 && (
                        <span>{candidate.tags.slice(0, 6).join(' · ')}</span>
                      )}
                      {candidate.alreadyLinked && (
                        <span className="postmatch-linked">{t('match.alreadyLinked')}</span>
                      )}
                    </div>
                  </div>
                  <div className="match-row-actions">
                    <button
                      className="ghost sm"
                      onClick={() => accept(current, candidate)}
                    >
                      <Check size={13} />
                      {t('match.use')}
                    </button>
                    <button
                      className="icon-btn"
                      title={t('match.notThis')}
                      aria-label={t('match.notThis')}
                      onClick={() => reject(current, candidate)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="match-card-foot">
              <button className="ghost" onClick={() => settle(current)}>
                <SkipForward size={13} />
                {t('match.noneOfThese')}
              </button>
              <span className="match-position">
                {t('match.position', { at: cursor + 1, of: items.length })}
              </span>
            </div>
          </div>
        )}
      </section>

      <p className="match-hint">
        <Search size={12} />
        {t('match.singleHint')}
      </p>
    </div>
  )
}
