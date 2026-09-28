import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RegisteredLibrary } from '@shared/schemas/app-config'
import type { IgnoredEntry, MetaLocation, MetaStatus } from '@shared/schemas/library-state'
import Select from '../components/Select'
import { askConfirm } from '../dialogs'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { showToast } from '../toasts'

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
    try {
      await ipcInvoke('library:remove', { id })
    } catch (e) {
      // The row may be far down the list, out of sight of the page's top.
      showToast({ message: toMessage(e) })
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
          <LibraryCard key={lib.id} library={lib} onRemove={() => void removeLibrary(lib.id)} />
        ))
      )}
    </>
  )
}

/**
 * One library: what it is on top, then its settings and its upkeep side by
 * side. The lists those buttons open take the card's full width below both,
 * since a folder tree squeezed into half a card is unreadable.
 */
function LibraryCard({
  library,
  onRemove
}: {
  library: RegisteredLibrary
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [panel, setPanel] = useState<'folders' | 'ignored' | null>(null)
  const ignored = useIgnored(library.id)
  const toggle = (next: 'folders' | 'ignored'): void => setPanel((cur) => (cur === next ? null : next))

  return (
    <div className="card" data-tour="library-row">
      <div className="row">
        <div className="grow">
          <div className="lib-name">{library.name}</div>
          <div className="lib-path">{library.rootPath}</div>
        </div>
        <button className="danger" onClick={onRemove}>
          {t('libraries.remove')}
        </button>
      </div>

      <div className="lib-sections">
        <section className="lib-section">
          <h3 className="lib-section-title">{t('libraries.meta.label')}</h3>
          <MetaLocationField libraryId={library.id} />
        </section>
        <section className="lib-section">
          <h3 className="lib-section-title">{t('libraries.entries')}</h3>
          <div className="lib-actions">
            <button
              className="ghost sm"
              aria-expanded={panel === 'folders'}
              onClick={() => toggle('folders')}
            >
              {t('libraries.folders.toggle')}
            </button>
            {ignored.entries.length > 0 && (
              <button
                className="ghost sm"
                aria-expanded={panel === 'ignored'}
                onClick={() => toggle('ignored')}
              >
                {t('libraries.ignored.toggle', { count: ignored.entries.length })}
              </button>
            )}
          </div>
        </section>
      </div>

      {panel === 'folders' && <FolderRemover libraryId={library.id} />}
      {panel === 'ignored' && ignored.entries.length > 0 && (
        <IgnoredList libraryId={library.id} entries={ignored.entries} refresh={ignored.refresh} />
      )}
    </div>
  )
}

/**
 * Where this library keeps its metadata files, and how far moving them has got.
 *
 * Changing it only records the new place; the library's scan moves the files
 * over in the background, and they are read from wherever they are meanwhile.
 * A folder outside the library is the last choice in the list rather than a
 * control of its own: it is one more answer to the same question.
 */
function MetaLocationField({ libraryId }: { libraryId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [status, setStatus] = useState<MetaStatus | null>(null)
  const [moving, setMoving] = useState<{ processed: number; total: number } | null>(null)
  /** "Another folder" is chosen in the list, and no folder has been picked yet. */
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    ipcInvoke('library:metaStatus', { libraryId })
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [libraryId])

  useEffect(() => {
    refresh()
    const offChanged = ipcOn('event:media-changed', (p) => p.libraryId === libraryId && refresh())
    const offError = ipcOn('event:library-error', (p) => p.libraryId === libraryId && refresh())
    const offProgress = ipcOn('event:sync-progress', (p) => {
      if (p.libraryId !== libraryId) return
      if (p.phase === 'moving') setMoving({ processed: p.processed, total: p.total })
      else if (p.phase === 'done') {
        setMoving(null)
        refresh()
      }
    })
    return () => {
      offChanged()
      offError()
      offProgress()
    }
  }, [libraryId, refresh])

  if (!status) return null

  const act = async (fn: () => Promise<MetaStatus>): Promise<boolean> => {
    setError(null)
    try {
      setStatus(await fn())
      return true
    } catch (e) {
      setError(toMessage(e))
      return false
    }
  }

  const choose = (location: MetaLocation): void => {
    if (location === 'custom') {
      if (status.location !== 'custom') setPicking(true)
      return
    }
    setPicking(false)
    void act(() => ipcInvoke('library:setMetaLocation', { libraryId, location }))
  }

  const pickFolder = async (): Promise<void> => {
    const { path } = await ipcInvoke('dialog:pickDirectory', { title: t('libraries.meta.pickerTitle') })
    if (!path) return
    const done = await act(() =>
      ipcInvoke('library:setMetaLocation', { libraryId, location: 'custom', folder: path })
    )
    if (done) setPicking(false)
  }

  const forget = async (folder: string): Promise<void> => {
    const ok = await askConfirm({
      message: t('libraries.meta.forgetConfirm', { folder }),
      confirmLabel: t('libraries.meta.forget'),
      danger: true
    })
    if (ok) await act(() => ipcInvoke('library:forgetMetaFolder', { libraryId, folder }))
  }

  const retry = async (): Promise<void> => {
    setError(null)
    try {
      await ipcInvoke('library:sync', { id: libraryId })
    } catch (e) {
      setError(toMessage(e))
    }
    refresh()
  }

  const isCustom = status.location === 'custom'

  return (
    <>
      <Select
        className="block"
        ariaLabel={t('libraries.meta.label')}
        value={picking ? 'custom' : status.location}
        onChange={choose}
        options={[
          { value: 'beside', label: t('libraries.meta.beside') },
          { value: 'library', label: t('libraries.meta.library') },
          { value: 'custom', label: t('libraries.meta.custom') }
        ]}
      />

      {(picking || isCustom) && (
        <div className="box meta-custom">
          <p className="settings-hint">{t('libraries.meta.customWarning')}</p>
          {isCustom && <div className="lib-path">{status.customDir}</div>}
          <div className="lib-actions">
            <button className="ghost sm" onClick={() => void pickFolder()}>
              {isCustom ? t('libraries.meta.changeFolder') : t('libraries.meta.chooseFolder')}
            </button>
            {picking && (
              <button className="ghost sm" onClick={() => setPicking(false)}>
                {t('common.cancel')}
              </button>
            )}
          </div>
        </div>
      )}

      {moving ? (
        <p className="settings-hint">
          {t('libraries.meta.moving', { processed: moving.processed, total: moving.total })}
        </p>
      ) : (
        status.pending > 0 && (
          <p className="settings-hint">{t('libraries.meta.pending', { count: status.pending })}</p>
        )
      )}

      {status.unreachable.map((folder) => (
        <div className="error-banner meta-unreachable" key={folder}>
          <span>{t('libraries.meta.unreachable', { folder })}</span>
          <div className="lib-actions">
            <button className="ghost sm" onClick={() => void retry()}>
              {t('libraries.meta.retry')}
            </button>
            <button className="ghost sm" onClick={() => void forget(folder)}>
              {t('libraries.meta.forget')}
            </button>
          </div>
        </div>
      ))}

      {error && <div className="error-banner">{error}</div>}
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    ipcInvoke('library:folders', { libraryId })
      .then((r) => setFolders(r.folders))
      .catch(() => setFolders([]))
  }, [libraryId])

  useEffect(() => {
    refresh()
    return ipcOn('event:media-changed', (p) => p.libraryId === libraryId && refresh())
  }, [libraryId, refresh])

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
    <div className="lib-panel">
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
function useIgnored(libraryId: string): { entries: IgnoredEntry[]; refresh: () => void } {
  const [entries, setEntries] = useState<IgnoredEntry[]>([])

  const refresh = useCallback(() => {
    ipcInvoke('library:listIgnored', { libraryId })
      .then((r) => setEntries(r.entries))
      .catch(() => setEntries([]))
  }, [libraryId])

  useEffect(() => {
    refresh()
    return ipcOn('event:media-changed', (p) => p.libraryId === libraryId && refresh())
  }, [libraryId, refresh])

  return { entries, refresh }
}

function IgnoredList({
  libraryId,
  entries,
  refresh
}: {
  libraryId: string
  entries: IgnoredEntry[]
  refresh: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [error, setError] = useState<string | null>(null)

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
    <div className="lib-panel">
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
    </div>
  )
}
