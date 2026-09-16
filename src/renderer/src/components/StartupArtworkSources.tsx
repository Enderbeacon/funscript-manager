import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Settings } from '@shared/schemas/app-config'
import { folderRef, parseFolderRef } from '@shared/schemas/taxonomy'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'

type Artwork = Settings['ui']['startupArtwork']
const KINDS = ['tags', 'playlists', 'folders'] as const
type Kind = (typeof KINDS)[number]
type Option = { value: string; label: string }

export default function StartupArtworkSources({ value, libraryId, disabled, onChange }: {
  value: Artwork
  libraryId: string
  disabled: boolean
  onChange: (value: Artwork) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [options, setOptions] = useState<Record<Kind, Option[]>>({ tags: [], playlists: [], folders: [] })
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let generation = 0
    const load = async (): Promise<void> => {
      const request = ++generation
      try {
        const [taxonomy, { folders }, libraries] = await Promise.all([
          ipcInvoke('taxonomy:get'),
          ipcInvoke('library:folders', { libraryId: libraryId || undefined }),
          ipcInvoke('library:list')
        ])
        if (cancelled || request !== generation) return
        const names = new Map(libraries.map((library) => [library.id, library.name]))
        setOptions({
          tags: taxonomy.entities.tags.map(({ name }) => ({ value: name, label: name })),
          playlists: taxonomy.entities.playlists.map(({ name }) => ({ value: name, label: name })),
          folders: folders.map((folder) => ({
            value: folderRef(folder.libraryId, folder.path),
            label: `${names.get(folder.libraryId) ?? folder.libraryId} / ${folder.path}`
          }))
        })
        setError(null)
      } catch (e) {
        if (!cancelled && request === generation) setError(toMessage(e))
      } finally {
        if (!cancelled && request === generation) setLoading(false)
      }
    }
    setLoading(true)
    void load()
    const off = [
      ipcOn('event:taxonomy-changed', () => void load()),
      ipcOn('event:libraries-changed', () => void load())
    ]
    return () => { cancelled = true; off.forEach((unsubscribe) => unsubscribe()) }
  }, [libraryId, toMessage])

  const toggle = (kind: Kind, name: string): void => {
    const selected = value[kind]
    const next = selected.includes(name) ? selected.filter((entry) => entry !== name) : [...selected, name]
    void onChange({ ...value, [kind]: next })
  }

  return (
    <div className="startup-artwork-sources">
      <p className="settings-hint">{t('settings.startupArtwork.sourcesHint')}</p>
      <div className="row">
        <input className="settings-input grow" type="search" value={search}
          placeholder={t('settings.startupArtwork.search')} aria-label={t('settings.startupArtwork.search')}
          onChange={(event) => setSearch(event.target.value)} />
        <button className="ghost sm" disabled={disabled || KINDS.every((kind) => value[kind].length === 0)}
          onClick={() => void onChange({ ...value, tags: [], playlists: [], folders: [] })}>
          {t('settings.startupArtwork.clear')}
        </button>
      </div>
      {error && <p className="error-banner">{error}</p>}
      <div className="startup-artwork-source-lists">
        {KINDS.map((kind) => {
          // Keep saved choices removable even after their source was deleted.
          const known = new Set(options[kind].map((option) => option.value))
          const rows = [...options[kind], ...value[kind].filter((entry) => !known.has(entry)).map((entry) => ({
            value: entry, label: kind === 'folders' ? (parseFolderRef(entry)?.path || entry) : entry
          }))].filter((option) => option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
          return (
            <fieldset key={kind} disabled={disabled}>
              <legend>{t(`settings.startupArtwork.${kind}`)} <span>{value[kind].length || ''}</span></legend>
              <div className="startup-artwork-source-list">
                {rows.map((option) => (
                  <label key={option.value} title={option.label}>
                    <input type="checkbox" checked={value[kind].includes(option.value)}
                      onChange={() => toggle(kind, option.value)} />
                    <span>{option.label}</span>
                  </label>
                ))}
                {rows.length === 0 && <p className="settings-hint">
                  {t(loading ? 'settings.startupArtwork.loading' : 'settings.startupArtwork.empty')}
                </p>}
              </div>
            </fieldset>
          )
        })}
      </div>
    </div>
  )
}
