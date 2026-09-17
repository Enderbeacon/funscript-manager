import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LogIn, Newspaper, Search } from 'lucide-react'
import type { ScrapedLink, ScrapedPost } from '@shared/schemas/scraped-post'
import type { RegisteredLibrary } from '@shared/schemas/app-config'
import PostCard from '../components/PostCard'
import DownloadRail from '../components/DownloadRail'
import Select from '../components/Select'
import { ipcInvoke, ipcOn } from '../ipc'
import { showToast } from '../toasts'
import { useErrorMessage } from '../useErrorMessage'

/**
 * Posts: paste forum links, choose what to download.
 *
 * Several posts at a time, because that is how people actually browse a
 * thread list. Each is parsed on its own and appears as soon as it is ready —
 * a 233-post thread takes ~18s behind the 1 req/s gate, and making the other
 * two wait for it would be the whole session.
 *
 * The rail is the glance version of the queue; its bottom button opens the
 * complete queue without navigating away from the parsed posts.
 */

interface Pending {
  /** The pasted address; also the identity of the card. */
  url: string
  state: 'parsing' | 'ready' | 'error'
  post?: ScrapedPost
  error?: string
  needsLogin?: boolean
  /** Library path of a media already carrying this post URL. */
  alreadyHave?: string | null
  /** How far the scraper has read this thread. */
  read?: { postsRead: number; postsTotal: number }
  /** Queueing the ticked links is under way. */
  queueing?: boolean
  /** Why the last attempt to queue this post's links did not go through. */
  downloadError?: string | null
}

export default function PostsPage({
  onOpenDownloads
}: {
  onOpenDownloads: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [input, setInput] = useState('')
  const [libraries, setLibraries] = useState<RegisteredLibrary[]>([])
  const [libraryId, setLibraryId] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const [busy, setBusy] = useState(false)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  /** Which card the scrape-progress event belongs to: parsing is sequential. */
  const parsingUrl = useRef<string | null>(null)

  useEffect(() => {
    Promise.all([
      ipcInvoke('library:list'),
      ipcInvoke('settings:get').catch(() => null)
    ])
      .then(([libs, settings]) => {
        setLibraries(libs)
        const remembered = settings?.ui.postDownloadLibraryId ?? ''
        setLibraryId(
          remembered && libs.some((library) => library.id === remembered)
            ? remembered
            : (libs[0]?.id ?? '')
        )
      })
      .catch(() => {})
    ipcInvoke('scrape:loginStatus')
      .then(({ loggedIn }) => setSignedIn(loggedIn))
      .catch(() => setSignedIn(null))
  }, [])

  const setDownloadLibrary = (id: string): void => {
    setLibraryId(id)
    void ipcInvoke('settings:update', { ui: { postDownloadLibraryId: id } }).catch(console.error)
  }

  useEffect(
    () =>
      ipcOn('event:scrape-progress', (p) => {
        const url = parsingUrl.current
        if (!url) return
        setPending((cur) => cur.map((c) => (c.url === url ? { ...c, read: p } : c)))
      }),
    []
  )

  const update = (url: string, patch: Partial<Pending>): void =>
    setPending((cur) => cur.map((c) => (c.url === url ? { ...c, ...patch } : c)))

  /**
   * One line per address. Forum posts get a card to confirm; anything else
   * goes straight into the queue.
   */
  const parseAll = useCallback(async () => {
    const urls = [...new Set(input.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean))]
    if (urls.length === 0 || !libraryId) return
    setBusy(true)

    const fresh = urls.filter((u) => !pending.some((p) => p.url === u))
    // Newest paste on top, where the box it came from is; within one paste the
    // lines keep their order.
    setPending((cur) => [...fresh.map((url): Pending => ({ url, state: 'parsing' })), ...cur])
    setInput('')

    for (const url of fresh) {
      parsingUrl.current = url
      try {
        const { isPost } = await ipcInvoke('scrape:isPostUrl', { url })
        if (!isPost) {
          await ipcInvoke('download:add', { url, libraryId })
          setPending((cur) => cur.filter((c) => c.url !== url))
          continue
        }
        const post = await ipcInvoke('scrape:parsePost', { url })
        const { existing } = await ipcInvoke('scrape:checkExisting', { postUrl: url })
        update(url, { state: 'ready', post, alreadyHave: existing?.filePath ?? null, read: undefined })
      } catch (e) {
        const needsLogin = String(e).includes('scrape_login_required')
        if (needsLogin) setSignedIn(false)
        update(url, { state: 'error', error: toMessage(e), needsLogin, read: undefined })
      }
    }
    parsingUrl.current = null
    setBusy(false)
  }, [input, libraryId, pending, toMessage])

  const login = useCallback(async () => {
    try {
      const { loggedIn } = await ipcInvoke('scrape:login')
      setSignedIn(loggedIn)
      if (loggedIn) setPending((cur) => cur.filter((c) => c.state !== 'error'))
    } catch (e) {
      // The sign-in window has closed by now; nothing on the page is its place.
      showToast({ message: toMessage(e) })
    }
  }, [toMessage])

  /**
   * Queue what was ticked. A failure is said on the card it belongs to, next to
   * the button that was pressed — at the top of the page it read as the button
   * having done nothing. Nothing is queued when it fails, so pressing again is
   * safe.
   */
  const download = useCallback(
    async (entryUrl: string, post: ScrapedPost, links: ScrapedLink[]) => {
      update(entryUrl, { queueing: true, downloadError: null })
      try {
        await ipcInvoke('download:addFromPost', {
          libraryId,
          post,
          urls: links.map((l) => l.url)
        })
        setPending((cur) => cur.filter((c) => c.url !== entryUrl && c.post?.postId !== post.postId))
      } catch (e) {
        update(entryUrl, { queueing: false, downloadError: toMessage(e) })
      }
    },
    [libraryId, toMessage]
  )

  /** Nothing here can be fetched: keep the metadata so the file has a home later. */
  const saveForLater = useCallback(
    async (entryUrl: string, post: ScrapedPost) => {
      try {
        await ipcInvoke('library:addWanted', { libraryId, post })
        setPending((cur) => cur.filter((c) => c.post?.postId !== post.postId))
      } catch (e) {
        update(entryUrl, { downloadError: toMessage(e) })
      }
    },
    [libraryId, toMessage]
  )

  return (
    <>
      {/* The heading sits above both columns, so the rail starts level with the
          paste box rather than floating a title's height higher than it. */}
      <h1 className="page-title">
        <Newspaper size={19} />
        {t('nav.posts')}
      </h1>
      <div className="page-sub">{t('posts.subtitle')}</div>

      <div className="posts-layout">
        <div className="posts-main">

        <form
          className="intake"
          onSubmit={(e) => {
            e.preventDefault()
            void parseAll()
          }}
        >
          <div className="intake-row">
            <textarea
              data-tour="posts-input"
              className="intake-input"
              placeholder={t('posts.urlPlaceholder')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter parses, Shift+Enter adds a line: the box takes a list.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void parseAll()
                }
              }}
            />
            <button
              data-tour="posts-parse"
              className="primary"
              type="submit"
              disabled={busy || !input.trim() || !libraryId}
            >
              <Search size={15} />
              {t('posts.parse')}
            </button>
          </div>
          <div className="intake-foot" data-tour="posts-library">
            <span>{t('posts.downloadTo')}</span>
            <Select
              value={libraryId}
              onChange={setDownloadLibrary}
              disabled={libraries.length === 0}
              ariaLabel={t('posts.downloadTo')}
              options={libraries.map((l) => ({ value: l.id, label: l.name }))}
            />
            {/* Session state lives in the top bar now; only offer the way back
                in when it is actually in the way. */}
            {signedIn === false && (
              <button className="ghost intake-login" type="button" onClick={() => void login()}>
                <LogIn size={13} />
                {t('downloads.login')}
              </button>
            )}
          </div>
        </form>

        {libraries.length === 0 && <div className="dl-hint">{t('downloads.needLibrary')}</div>}

        {pending.length === 0 ? (
          <div className="empty">{t('posts.empty')}</div>
        ) : (
          pending.map((entry) =>
            entry.state === 'ready' && entry.post ? (
              <PostCard
                key={entry.url}
                post={entry.post}
                alreadyHave={entry.alreadyHave ?? null}
                disabled={entry.queueing ?? false}
                error={entry.downloadError ?? null}
                onRemove={() => setPending((cur) => cur.filter((c) => c.url !== entry.url))}
                onDownload={(post, links) => void download(entry.url, post, links)}
                onSaveForLater={() => void saveForLater(entry.url, entry.post!)}
              />
            ) : (
              <article key={entry.url} className="post post-thin">
                <div className="post-head">
                  <div className="post-main">
                    <div className="post-title-thin">{entry.url}</div>
                    {entry.state === 'parsing' ? (
                      <div className="post-progress">
                        <span>
                          {entry.read
                            ? t('downloads.readingReplies', {
                                read: entry.read.postsRead,
                                total: entry.read.postsTotal
                              })
                            : t('posts.parsing')}
                        </span>
                        <div className="bar">
                          <span
                            style={
                              entry.read
                                ? { width: `${(entry.read.postsRead / entry.read.postsTotal) * 100}%` }
                                : { width: '20%' }
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="post-error">
                        {entry.error}
                        {entry.needsLogin && (
                          <button className="ghost" onClick={() => void login()}>
                            {t('downloads.login')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    className="icon-btn"
                    onClick={() => setPending((cur) => cur.filter((c) => c.url !== entry.url))}
                    title={t('posts.remove')}
                  >
                    ×
                  </button>
                </div>
              </article>
            )
          )
        )}
        </div>

        <DownloadRail onOpenQueue={onOpenDownloads} />
      </div>
    </>
  )
}
