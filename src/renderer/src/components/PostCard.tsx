import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  CircleCheck,
  CircleHelp,
  Download,
  ExternalLink,
  FileText,
  Hand,
  Image as ImageIcon,
  Link as LinkIcon,
  Loader2,
  MessageSquareQuote,
  Plus,
  Radio,
  TriangleAlert,
  User,
  Video,
  X
} from 'lucide-react'
import type { ScrapedLink, ScrapedPost } from '@shared/schemas/scraped-post'
import HosterBadge, { hosterName } from './HosterBadge'
import { formatDate } from '../format'
import { ipcInvoke } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { useRemoteImage } from '../useRemoteImage'

/** What a liveness check found; `unchecked` means nobody has looked yet. */
type LinkStatus = 'alive' | 'gone' | 'unknown' | 'unchecked'
/** Why a check could not decide, when the host gave that much away. */
type LinkIssue = 'unreachable' | 'rate_limited' | 'site_changed' | 'verification_required'

/**
 * One parsed post: what it is, and one card per source with everything needed
 * to choose between them.
 *
 * The software never picks a source for the user: scripts start ticked because
 * you almost always want all of them, video links start unticked because
 * exactly one is usually right and only the user knows which.
 *
 * A source we cannot fetch — a shop, a Patreon, an unrecognised landing page —
 * gets no tick box at all, only a way to the site. This page is for what can be
 * had without a paywall; picking the file up afterwards belongs to the library.
 */

/** How long after the post a reply landed — a fresher mirror is usually the live one. */
function sincePost(postedAt: string, replyAt: string): string {
  const a = new Date(postedAt).getTime()
  const b = new Date(replyAt).getTime()
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return ''
  const days = Math.round((b - a) / 86_400_000)
  if (days < 1) return ''
  if (days < 60) return `+${days}d`
  return `+${Math.round(days / 30)}mo`
}

/**
 * Picture for one source card. pixeldrain renders its own poster frame, which
 * is worth more than the post's: it shows what that particular upload is. Every
 * other host either has no such endpoint or would need the page fetched first,
 * so those fall back to the post's preview — the links in a post are mirrors of
 * one video anyway.
 */
function linkThumbUrl(link: ScrapedLink, post: ScrapedPost): string {
  if (link.isScript) return ''
  if (link.hoster === 'pixeldrain') {
    try {
      const parsed = new URL(link.url)
      const id = /^\/(?:u|api\/file)\/([\w-]+)/i.exec(parsed.pathname)?.[1]
      if (id) return `${parsed.origin}/api/file/${id}/thumbnail?width=128&height=80`
    } catch {
      // The parser already validates normal links; a malformed added link just
      // falls back to the post image.
    }
  }
  return post.previewImage
}

function LinkCard({
  link,
  post,
  checked,
  disabled,
  status,
  issue,
  checking,
  onCheck,
  onToggle
}: {
  link: ScrapedLink
  post: ScrapedPost
  checked: boolean
  disabled: boolean
  /** Liveness verdict, when one has been reached for this link. */
  status?: LinkStatus
  /** Why an `unknown` verdict is one. */
  issue?: LinkIssue
  checking: boolean
  onCheck?: () => void
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const thumb = useRemoteImage(linkThumbUrl(link, post))

  /**
   * The state of the check, always said out loud.
   *
   * Every outcome gets a line, including the two that used to be silent: a link
   * that passed showed nothing (the button simply vanished, which reads as "it
   * did not work"), and a check that could not decide showed nothing either.
   * Asking a question and getting no answer back is worse than not asking.
   *
   * "Could not tell" keeps a way to try again, and says so — it is not a
   * verdict on the link, it is the absence of one.
   */
  const recheck = (label: string, icon: React.ReactNode, className: string): React.JSX.Element => (
    <button
      className={className}
      onClick={(e) => {
        e.preventDefault()
        onCheck?.()
      }}
      title={onCheck ? t('posts.recheck') : undefined}
    >
      {icon}
      {label}
    </button>
  )

  const liveness = checking ? (
    <div className="lk-check">
      <Loader2 size={12} className="spin" />
      {t('posts.checking')}
    </div>
  ) : status === 'gone' ? (
    recheck(t('posts.linkDead'), <TriangleAlert size={12} />, 'lk-dead')
  ) : status === 'alive' ? (
    recheck(t('posts.linkAlive'), <CircleCheck size={12} />, 'lk-alive')
  ) : status === 'unknown' ? (
    // Said as the reason when there is one: "could not tell" reads as the app
    // failing, where "can't reach gofile" tells the user what to look at.
    recheck(
      issue
        ? t(`posts.linkIssue.${issue}`, { host: hosterName(link.hoster) })
        : t('posts.linkUnsure'),
      <CircleHelp size={12} />,
      'lk-unsure'
    )
  ) : onCheck ? (
    // Nothing has looked at this one. It reads as the offer it is.
    recheck(t('posts.checkLink'), <Radio size={12} />, 'lk-check')
  ) : null

  /**
   * When the check cannot decide, the page itself is the quickest way to find
   * out: one look in the browser shows a file, a removal notice or a challenge.
   */
  const lookYourself =
    !checking && status === 'unknown' ? (
      <a className="lk-look" href={link.url} target="_blank" rel="noreferrer">
        <ExternalLink size={12} />
        {t('posts.openSite')}
      </a>
    ) : null

  const body = (
    <>
      {!link.isScript && (
        <div className="lk-thumb sfw">
          {thumb ? <img src={thumb} alt="" loading="lazy" /> : <ImageIcon size={15} />}
        </div>
      )}
      <div className="lk-main">
        <div className="lk-top">
          <HosterBadge
            hoster={link.hoster}
            {...(link.hoster === 'unknown' ? { label: hostOf(link.url) } : {})}
          />
          <span className="lk-name" title={link.url}>
            {link.label}
          </span>
        </div>
        {link.label !== link.url && <div className="lk-url">{link.url}</div>}
        {link.notAVideo && <div className="lk-why">{t('posts.notAVideo')}</div>}
        {/* The author's own words. Between three mirrors of one video this is
            usually the only thing that says which to take. */}
        {link.note && <div className="lk-note">{link.note}</div>}
        {link.fromPost && (
          <div className="lk-reply">
            <div className="lk-reply-head">
              <MessageSquareQuote size={13} />
              <b>
                #{link.fromPost.number} {link.fromPost.author}
              </b>
              {link.fromPost.createdAt && (
                <span>
                  {formatDate(link.fromPost.createdAt)}
                  {sincePost(post.createdAt, link.fromPost.createdAt) &&
                    ` · ${sincePost(post.createdAt, link.fromPost.createdAt)}`}
                </span>
              )}
            </div>
            {link.fromPost.excerpt && <div className="lk-reply-body">{link.fromPost.excerpt}</div>}
          </div>
        )}
      </div>
      {/* Beside the link while there is room, under it when there is not — a
          row of its own for one short chip made every card taller for nothing. */}
      {liveness && (
        <div className="lk-state">
          {liveness}
          {lookYourself}
        </div>
      )}
    </>
  )

  if (!link.downloadable) {
    return (
      <div className="lk locked">
        <span className="lk-spacer" />
        {body}
        <a className="ghost lk-go" href={link.url} target="_blank" rel="noreferrer">
          <ExternalLink size={13} />
          {t('posts.openSite')}
        </a>
      </div>
    )
  }

  return (
    <label className={`lk${checked ? ' on' : ''}${status === 'gone' ? ' dead' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      {body}
    </label>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export default function PostCard({
  post: parsed,
  alreadyHave,
  disabled,
  error,
  onRemove,
  onDownload,
  onSaveForLater
}: {
  post: ScrapedPost
  /** Library path of a media already carrying this post URL, if any. */
  alreadyHave: string | null
  disabled: boolean
  /** Why the last press of Download did not queue anything. */
  error: string | null
  onRemove: () => void
  /** The post as the user sees it — with any links they added — and what they ticked. */
  onDownload: (post: ScrapedPost, links: ScrapedLink[]) => void
  onSaveForLater: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const poster = useRemoteImage(parsed.previewImage)

  /**
   * Links the user pasted in: a mirror found somewhere else, or the direct file
   * behind a page the app could not read. They join the post's own links, so
   * they download and file along with the post rather than as strays.
   */
  const [added, setAdded] = useState<ScrapedLink[]>([])
  const post = useMemo(
    () => (added.length === 0 ? parsed : { ...parsed, links: [...parsed.links, ...added] }),
    [parsed, added]
  )
  const [adding, setAdding] = useState(false)
  const [pasted, setPasted] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  const scripts = post.links.filter((l) => l.isScript)
  /**
   * The post's own structure decides; the domain is consulted only when the
   * post gave none. The author knows what each link is for, a host list only
   * knows what a domain usually is.
   */
  const isVideo = (l: ScrapedLink): boolean => {
    if (l.isScript) return false
    if (l.section === 'video') return true
    if (l.section === 'unknown') return l.hoster !== 'unknown'
    return false
  }
  const videos = post.links.filter(isVideo)
  const others = post.links.filter((l) => !l.isScript && !isVideo(l))

  const fromReplies = videos.filter((l) => l.fromPost)
  const authorVideos = videos.filter((l) => !l.fromPost)
  /**
   * Replacement mirrors stay folded: a long thread turns up half a dozen, and
   * expanded they bury the author's own link under strangers' re-uploads.
   */
  const [showMirrors, setShowMirrors] = useState(false)
  const [showOthers, setShowOthers] = useState(false)

  const [picked, setPicked] = useState<Set<string>>(() => {
    const start = new Set(scripts.filter((l) => l.downloadable).map((l) => l.url))
    const bestVideo = authorVideos.find((l) => l.downloadable)
    if (bestVideo) start.add(bestVideo.url)
    return start
  })

  const toggle = (url: string): void =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })

  const [status, setStatus] = useState<Record<string, LinkStatus>>({})
  const [issues, setIssues] = useState<Record<string, LinkIssue>>({})
  const [checking, setChecking] = useState<string[]>([])

  const runCheck = async (urls: string[], force: boolean): Promise<Record<string, LinkStatus>> => {
    if (urls.length === 0) return {}
    setChecking((cur) => [...cur, ...urls])
    try {
      const { statuses, issues: found } = await ipcInvoke('download:checkLinks', { urls, force })
      setStatus((cur) => ({ ...cur, ...statuses }))
      setIssues((cur) => {
        const next = { ...cur }
        for (const url of urls) delete next[url]
        return { ...next, ...found }
      })
      return statuses
    } catch {
      // A check that cannot run leaves every link exactly as unproven as it was.
      return {}
    } finally {
      setChecking((cur) => cur.filter((u) => !urls.includes(u)))
    }
  }

  /**
   * Check the author's own video links as soon as the post appears, and only
   * go looking further when one of them is dead: that is the moment the
   * replacement links buried in the replies stop being noise and become the
   * answer, so they get unfolded, checked, and one of them ticked.
   *
   * Posts here are years old as often as not. Finding out a link died before
   * queueing it is the whole point — after is just a failed download.
   */
  /**
   * A link turned out to be dead — from the automatic pass or from the user
   * pressing check, it makes no difference. Unfold what the thread offered
   * instead, find out which of those still work, and move the tick off the
   * dead one. This is the follow-up the whole check exists for.
   */
  const findReplacement = useCallback(
    async (dead: string[], known: Record<string, LinkStatus>): Promise<void> => {
      if (dead.length === 0) return
      setShowMirrors(true)
      const mirrors = fromReplies
        .filter((l) => l.downloadable && known[l.url] === undefined)
        .map((l) => l.url)
      const verdict = { ...known, ...(await runCheck(mirrors, false)) }

      setPicked((cur) => {
        const next = new Set(cur)
        let lost = false
        for (const url of dead) if (next.delete(url)) lost = true
        // Only fill the gap the dead link left. A user who already ticked
        // something else has made the choice this would be guessing at.
        if (!lost) return next
        if ([...authorVideos, ...fromReplies].some((l) => next.has(l.url))) return next
        const alternative = [...authorVideos, ...fromReplies].find(
          (l) => l.downloadable && verdict[l.url] !== 'gone'
        )
        if (alternative) next.add(alternative.url)
        return next
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [post.postUrl]
  )

  const checkOne = async (url: string): Promise<void> => {
    const verdict = await runCheck([url], true)
    if (verdict[url] === 'gone') await findReplacement([url], verdict)
  }

  useEffect(() => {
    let live = true
    const run = async (): Promise<void> => {
      const authorUrls = authorVideos.filter((l) => l.downloadable).map((l) => l.url)
      const first = await runCheck(authorUrls, false)
      if (!live) return
      const dead = authorUrls.filter((u) => first[u] === 'gone')
      if (dead.length > 0) await findReplacement(dead, first)
    }
    void run()
    return () => {
      live = false
    }
    // The post is fixed for the life of this card; its links never change.
  }, [post.postUrl])

  const addLink = async (): Promise<void> => {
    const url = pasted.trim()
    if (!url) return
    try {
      const link = await ipcInvoke('scrape:describeLink', { url })
      setAddError(null)
      setPasted('')
      setAdding(false)
      // Already in the post: pasting it again means "this one".
      if (!post.links.some((l) => l.url === link.url)) setAdded((cur) => [...cur, link])
      if (link.downloadable) setPicked((cur) => new Set(cur).add(link.url))
      if (link.downloadable && !link.isScript) void runCheck([link.url], false)
    } catch (e) {
      setAddError(toMessage(e))
    }
  }

  const cancelAdding = (): void => {
    setAdding(false)
    setPasted('')
    setAddError(null)
  }

  const chosen = post.links.filter((l) => l.downloadable && picked.has(l.url))
  const nothingToFetch = post.links.every((l) => !l.downloadable)

  const card = (link: ScrapedLink): React.JSX.Element => (
    <LinkCard
      key={link.url}
      link={link}
      post={post}
      checked={picked.has(link.url)}
      disabled={disabled}
      {...(status[link.url] ? { status: status[link.url] } : {})}
      {...(issues[link.url] ? { issue: issues[link.url] } : {})}
      checking={checking.includes(link.url)}
      // Only a video link is worth checking: a script is a few kilobytes the
      // download itself settles faster than a check would.
      {...(link.downloadable && isVideo(link) ? { onCheck: () => void checkOne(link.url) } : {})}
      onToggle={() => toggle(link.url)}
    />
  )

  return (
    <article className="post" data-tour="post-card">
      <div className="post-head">
        <div className="post-thumb sfw">
          {poster ? (
            <img src={poster} alt="" loading="lazy" />
          ) : (
            <ImageIcon size={17} />
          )}
        </div>
        <div className="post-main">
          <div className="post-title">{post.title}</div>
          <div className="post-sub">
            {post.author && (
              <span className="post-author">
                <User size={12} />
                {post.author}
              </span>
            )}
            {post.createdAt && <span>{formatDate(post.createdAt)}</span>}
            {post.tags.slice(0, 6).map((tag) => (
              <span key={tag} className="badge">
                {tag}
              </span>
            ))}
            {post.tags.length > 6 && <span>+{post.tags.length - 6}</span>}
          </div>
        </div>
        <div className="post-tools">
          <a className="icon-btn" href={post.postUrl} target="_blank" rel="noreferrer" title={t('posts.openPost')}>
            <ExternalLink size={15} />
          </a>
          <button className="icon-btn" onClick={onRemove} title={t('posts.remove')}>
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="post-body">
        {/* First thing in the card: when the post's own links are dead or
            unreadable, a link found elsewhere is how the download happens. */}
        {adding ? (
          <form
            className="post-add"
            onSubmit={(e) => {
              e.preventDefault()
              void addLink()
            }}
          >
            <input
              className="settings-input"
              autoFocus
              value={pasted}
              placeholder={t('posts.addLinkPlaceholder')}
              onChange={(e) => setPasted(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancelAdding()
              }}
            />
            <button className="primary" type="submit" disabled={!pasted.trim()}>
              <Plus size={14} />
              {t('posts.addLinkConfirm')}
            </button>
            <button className="ghost" type="button" onClick={cancelAdding}>
              {t('common.cancel')}
            </button>
          </form>
        ) : (
          <button className="post-add-open" onClick={() => setAdding(true)}>
            <LinkIcon size={14} />
            {t('posts.addLink')}
          </button>
        )}
        {addError && <div className="post-fail">{addError}</div>}

        {alreadyHave && (
          <div className="post-have">
            <TriangleAlert size={13} />
            {t('downloads.alreadyHave', { file: alreadyHave })}
          </div>
        )}

        {post.links.length === 0 && <div className="dl-hint">{t('downloads.noLinks')}</div>}

        {nothingToFetch && post.links.length > 0 && (
          <div className="group-head">
            <Hand size={13} />
            {t('posts.nothingFetchable')}
          </div>
        )}

        {videos.length > 0 && (
          <>
            {!nothingToFetch && (
              <div className="group-head">
                <Video size={13} />
                {t('posts.videoGroup', { count: videos.length })}
              </div>
            )}
            <div className="lk-list">{authorVideos.map(card)}</div>
            {fromReplies.length > 0 &&
              (showMirrors ? (
                <div className="lk-list lk-mirrors">{fromReplies.map(card)}</div>
              ) : (
                <button className="lk-more" onClick={() => setShowMirrors(true)}>
                  <ChevronDown size={13} />
                  {t('posts.mirrorsInReplies', { count: fromReplies.length })}
                </button>
              ))}
          </>
        )}

        {scripts.length > 0 && (
          <>
            <div className="group-head">
              <FileText size={13} />
              {t('posts.scriptGroup', { count: scripts.length })}
            </div>
            <div className="lk-list">{scripts.map(card)}</div>
          </>
        )}

        {others.length > 0 &&
          (showOthers ? (
            <>
              <div className="group-head">{t('downloads.otherLinks')}</div>
              <div className="lk-list">{others.map(card)}</div>
            </>
          ) : (
            <button className="lk-more" onClick={() => setShowOthers(true)}>
              <ChevronDown size={13} />
              {t('downloads.otherLinks')} ({others.length})
            </button>
          ))}
      </div>

      {error && (
        <div className="post-fail post-fail-bar">
          <TriangleAlert size={13} />
          {error}
        </div>
      )}

      <div className="post-bar">
        {nothingToFetch ? (
          <>
            <span className="post-sum">{t('posts.metadataOnlyHint')}</span>
            <div className="post-bar-actions">
              <button className="ghost" disabled={disabled} onClick={onRemove}>
                {t('posts.remove')}
              </button>
              <button className="primary" disabled={disabled} onClick={onSaveForLater}>
                {t('posts.saveForLater')}
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="post-sum">{t('posts.selected', { count: chosen.length })}</span>
            <div className="post-bar-actions">
              <button className="ghost" disabled={disabled} onClick={() => setPicked(new Set())}>
                {t('posts.clearSelection')}
              </button>
              <button
                className="primary"
                disabled={disabled || chosen.length === 0}
                onClick={() => onDownload(post, chosen)}
              >
                <Download size={15} />
                {t('posts.download')}
              </button>
            </div>
          </>
        )}
      </div>
    </article>
  )
}
