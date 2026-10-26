import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ScriptMatchPreview } from '@shared/schemas/script-match'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import Select from './Select'

/** Review a whole library's unpaired scripts, including separate source folders. */
export default function ScriptMatchingPanel({ libraryId }: { libraryId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [preview, setPreview] = useState<ScriptMatchPreview | null>(null)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const generation = useRef(0)
  const acting = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const next = await ipcInvoke('library:scriptMatches', { libraryId })
      if (request !== generation.current) return
      setPreview(next)
      setChoices((previous) => Object.fromEntries(next.groups.map((group) => {
        const value = previous[group.id]
        return [group.id, value !== undefined && (value === '' || group.candidates.some((candidate) => candidate.mediaId === value))
          ? value : group.suggestedMediaId ?? '']
      })))
    } catch (e) {
      if (request === generation.current) setError(toMessage(e))
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [libraryId, toMessage])

  useEffect(() => {
    void refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = ipcOn('event:media-changed', (event) => {
      if (event.libraryId === libraryId && !acting.current) {
        clearTimeout(timer)
        timer = setTimeout(() => { if (!acting.current) void refresh() }, 350)
      }
    })
    return () => { generation.current++; clearTimeout(timer); off() }
  }, [libraryId, refresh])

  const act = async (action: () => Promise<void>): Promise<void> => {
    acting.current = true
    setBusy(true)
    setError(null)
    setResult(null)
    generation.current++
    setLoading(false)
    try {
      await action()
      await refresh()
    } catch (e) {
      setError(toMessage(e))
    } finally {
      acting.current = false
      setBusy(false)
    }
  }

  const addFolder = async (): Promise<void> => {
    await act(async () => {
      const { path } = await ipcInvoke('dialog:pickDirectory', { title: t('libraries.scripts.pickFolder') })
      if (!path) return
      await ipcInvoke('library:setScriptFolders', { libraryId, folders: [...(preview?.folders ?? []), path] })
    })
  }

  const apply = async (): Promise<void> => {
    await act(async () => {
      const selected = Object.entries(choices).filter(([, mediaId]) => mediaId)
        .map(([groupId, mediaId]) => ({ groupId, mediaId }))
      const applied = await ipcInvoke('library:applyScriptMatches', { libraryId, choices: selected })
      setResult(t('libraries.scripts.result', applied))
    })
  }

  const selectedCount = Object.values(choices).filter(Boolean).length
  return (
    <div className="lib-panel script-matching-panel" aria-busy={busy || loading}>
      <p className="settings-hint">{t('libraries.scripts.hint')}</p>
      <div className="lib-actions">
        <button className="ghost sm" disabled={busy || loading || !preview} onClick={() => void addFolder()}>
          {t('libraries.scripts.addFolder')}
        </button>
        <button className="ghost sm" disabled={busy || loading} onClick={() => void act(async () => {
          await ipcInvoke('library:sync', { id: libraryId })
        })}>{loading ? t('libraries.scripts.scanning') : t('libraries.scripts.refresh')}</button>
      </div>
      {preview && preview.folders.length > 0 && (
        <div className="box script-source-folders">
          <p className="settings-hint">{t('libraries.scripts.copyHint')}</p>
          {preview.folders.map((folder) => (
            <div className="row" key={folder}>
              <span className="lib-path grow">{folder}</span>
              <button className="ghost sm" disabled={busy || loading} onClick={() => void act(async () => {
                await ipcInvoke('library:setScriptFolders', { libraryId,
                  folders: preview.folders.filter((path) => path !== folder) })
              })}>{t('libraries.scripts.removeFolder')}</button>
            </div>
          ))}
        </div>
      )}
      {preview?.unreachable.map((folder) => (
        <div className="error-banner" key={folder}>{t('libraries.scripts.unreachable', { folder })}</div>
      ))}
      {error && <div className="error-banner">{error}</div>}
      {result && <p role="status" className="settings-hint">{result}</p>}
      {preview && (preview.groups.length ? (
        <>
          <div className="lib-actions">
            <button className="ghost sm" disabled={busy || loading} onClick={() => setChoices(Object.fromEntries(
              preview.groups.map((group) => [group.id, group.suggestedMediaId ?? ''])
            ))}>{t('libraries.scripts.selectSuggested')}</button>
            <button className="ghost sm" disabled={busy || loading} onClick={() => setChoices(Object.fromEntries(
              preview.groups.map((group) => [group.id, ''])
            ))}>
              {t('libraries.scripts.clear')}
            </button>
            <button className="primary sm" disabled={busy || loading || selectedCount === 0} onClick={() => void apply()}>
              {t('libraries.scripts.apply', { count: selectedCount })}
            </button>
          </div>
          <div className="box script-match-rows">
            {preview.groups.map((group) => (
              <div className="script-match-row" key={group.id}>
                <div className="script-match-source">
                  <div className="lib-path">{group.scriptPath}</div>
                  <details>
                    <summary className="settings-hint">{t('libraries.scripts.files', { count: group.files.length })}
                      {group.copy ? ` · ${t('libraries.scripts.copy')}` : ''}
                    </summary>
                    {group.files.map((file) => <div className="lib-path" key={file}>{file}</div>)}
                  </details>
                </div>
                <Select
                  className="script-match-target"
                  ariaLabel={t('libraries.scripts.target', { script: group.scriptPath })}
                  value={choices[group.id] ?? ''}
                  disabled={busy || loading}
                  onChange={(value) => setChoices((previous) => ({ ...previous, [group.id]: value }))}
                  options={[
                    { value: '', label: t('libraries.scripts.skip') },
                    ...group.candidates.map((candidate) => ({ value: candidate.mediaId,
                      label: `${candidate.filePath} · ${t(`libraries.scripts.${candidate.kind}`)}` }))
                  ]}
                />
              </div>
            ))}
          </div>
        </>
      ) : <p className="settings-hint">{t('libraries.scripts.empty')}</p>)}
      {preview !== null && preview.unmatched > 0 && (
        <p className="settings-hint">{t('libraries.scripts.unmatched', { count: preview.unmatched })}</p>
      )}
    </div>
  )
}
