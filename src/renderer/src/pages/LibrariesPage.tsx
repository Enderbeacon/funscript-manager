import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RegisteredLibrary } from '@shared/schemas/app-config'
import type { IgnoredEntry } from '@shared/schemas/library-state'
import { askConfirm } from '../dialogs'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'

export default function LibrariesPage(): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [libraries, setLibraries] = useState<RegisteredLibrary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    ipcInvoke('library:list').then(setLibraries).catch(console.error)
  }, [])

  useEffect(() => {
    refresh()
    // Stay in sync with changes pushed by main (other windows / background flows).
    return ipcOn('event:libraries-changed', ({ libraries }) => setLibraries(libraries))
  }, [refresh])

  const addLibrary = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const { path } = await ipcInvoke('dialog:pickDirectory', { title: t('libraries.pickerTitle') })
      if (path) await ipcInvoke('library:add', { rootPath: path })
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const removeLibrary = async (id: string): Promise<void> => {
    setError(null)
    try {
      await ipcInvoke('library:remove', { id })
    } catch (e) {
      setError(toMessage(e))
    }
  }

  return (
    <>
      <div className="page-header libraries-header">
        <h1 className="page-title">{t('libraries.title')}</h1>
        <div className="libraries-header-actions">
          <button
            data-tour="library-add"
            className="primary"
            onClick={addLibrary}
            disabled={busy}
          >
            {t('libraries.add')}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {libraries.length === 0 ? (
        <div className="empty">{t('libraries.empty')}</div>
      ) : (
        libraries.map((lib) => (
          <div className="card" data-tour="library-row" key={lib.id}>
            <div className="row">
              <div className="grow">
                <div className="lib-name">{lib.name}</div>
                <div className="lib-path">{lib.rootPath}</div>
              </div>
              <button className="danger" onClick={() => removeLibrary(lib.id)}>
                {t('libraries.remove')}
              </button>
            </div>
            <FolderRemover libraryId={lib.id} />
            <IgnoredList libraryId={lib.id} />
          </div>
        ))
      )}
    </>
  )
}

interface LibraryFolder {
  path: string
  depth: number
  entries: number
  total: number
}

/**
 * Remove a whole folder from the library at once.
 *
 * A library picks up whatever is under its root, and some of what lands there
 * is not a media collection at all — a game's script folder puts a hundred
 * entries in the library that will never have a video. Taking those out one by
 * one is not a realistic offer.
 */
function FolderRemover({ libraryId }: { libraryId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    ipcInvoke('library:folders', { libraryId })
      .then((r) => setFolders(r.folders))
      .catch(() => setFolders([]))
  }, [libraryId])

  useEffect(() => {
    if (!open) return
    refresh()
    return ipcOn('event:media-changed', (p) => p.libraryId === libraryId && refresh())
  }, [libraryId, open, refresh])

  const remove = async (folder: LibraryFolder): Promise<void> => {
    const name = folder.path === '' ? t('libraries.folders.root') : folder.path
    const ok = await askConfirm({
      message: t('libraries.folders.confirm', { folder: name, count: folder.total }),
      confirmLabel: t('libraries.folders.remove'),
      danger: true
    })
    if (!ok) return
    setError(null)
    setBusy(folder.path)
    try {
      await ipcInvoke('library:removeFolder', { libraryId, folder: folder.path })
      refresh()
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setBusy(null)
    }
  }

  /** A folder is shown when every folder above it has been opened. */
  const visible = folders.filter((f) => {
    if (f.depth <= 1) return true
    const parent = f.path.slice(0, f.path.lastIndexOf('/'))
    let at: string | null = parent
    while (at) {
      if (!expanded.has(at)) return false
      const cut = at.lastIndexOf('/')
      at = cut === -1 ? null : at.slice(0, cut)
    }
    return true
  })

  const hasChildren = (folder: LibraryFolder): boolean =>
    folders.some((f) => f.path.startsWith(folder.path === '' ? '' : `${folder.path}/`) && f !== folder)

  const toggle = (path: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <div className="ignored-block">
      <button className="ghost sm" onClick={() => setOpen(!open)}>
        {t('libraries.folders.toggle')}
      </button>

      {open && (
        <>
          {error && <div className="error-banner">{error}</div>}
          {folders.length === 0 ? (
            <div className="empty sm">{t('libraries.folders.empty')}</div>
          ) : (
            <div className="box folder-rows">
              {visible.map((folder) => (
                <div className="folder-row" key={folder.path || '/'}>
                  <div className="grow" style={{ paddingLeft: `${folder.depth * 1.1}rem` }}>
                    <button
                      className="ghost sm folder-name"
                      disabled={!hasChildren(folder)}
                      onClick={() => toggle(folder.path)}
                    >
                      {hasChildren(folder) ? (expanded.has(folder.path) ? '▾' : '▸') : '·'}{' '}
                      {folder.path === ''
                        ? t('libraries.folders.root')
                        : folder.path.split('/').pop()}
                    </button>
                    <span className="folder-count">
                      {t('libraries.folders.count', { count: folder.total })}
                    </span>
                  </div>
                  <button
                    className="ghost sm"
                    disabled={busy !== null || folder.total === 0}
                    onClick={() => void remove(folder)}
                  >
                    {busy === folder.path
                      ? t('libraries.folders.removing')
                      : t('libraries.folders.remove')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The entries removed from this library with their files left in place.
 *
 * Without somewhere to see it, "remove from library" is a one-way door with no
 * handle on the other side: the file is still on disk, the library keeps
 * refusing to index it, and nothing on screen explains why.
 */
function IgnoredList({ libraryId }: { libraryId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [entries, setEntries] = useState<IgnoredEntry[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    ipcInvoke('library:listIgnored', { libraryId })
      .then((r) => setEntries(r.entries))
      .catch(() => setEntries([]))
  }, [libraryId])

  useEffect(() => {
    refresh()
    return ipcOn('event:media-changed', (p) => p.libraryId === libraryId && refresh())
  }, [libraryId, refresh])

  if (entries.length === 0) return null

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
      refresh()
    } catch (e) {
      setError(toMessage(e))
    }
  }

  return (
    <div className="ignored-block">
      <button className="ghost sm" onClick={() => setOpen(!open)}>
        {t('libraries.ignored.toggle', { count: entries.length })}
      </button>

      {open && (
        <>
          {error && <div className="error-banner">{error}</div>}
          <div className="box ignored-rows">
            {entries.map((entry) => (
              <div className="ignored-row" key={entry.id}>
                <div className="grow">
                  <div className="ignored-title">{entry.title || entry.path.split('/').pop()}</div>
                  <div className="ignored-path">{entry.path}</div>
                </div>
                <button className="ghost sm" onClick={() => void act(() =>
                  ipcInvoke('library:restoreIgnored', { libraryId, id: entry.id })
                )}>
                  {t('libraries.ignored.restore')}
                </button>
              </div>
            ))}
          </div>
          <button className="ghost sm" onClick={() => void act(() =>
            ipcInvoke('library:clearIgnored', { libraryId })
          )}>
            {t('libraries.ignored.clearAll')}
          </button>
        </>
      )}
    </div>
  )
}
