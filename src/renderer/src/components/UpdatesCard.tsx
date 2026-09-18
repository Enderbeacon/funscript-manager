import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Settings } from '@shared/schemas/app-config'
import type { ReleaseSummary, UpdateChannel, UpdateState } from '@shared/schemas/updates'
import { compareVersions } from '@shared/semver'
import { askConfirm } from '../dialogs'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import Markdown from './Markdown'
import Select from './Select'
import { DownloadBar } from './UpdateNotices'

/**
 * Updates: what is running, which releases to follow, and every published
 * release for going to a specific one — back to an older version included,
 * after saying what that can cost.
 */
export default function UpdatesCard(): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [state, setState] = useState<UpdateState | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [releases, setReleases] = useState<ReleaseSummary[] | null>(null)
  const [releasesError, setReleasesError] = useState<string | null>(null)

  // The release list is fetched at startup, so asking for it here is normally
  // instant; loading it with the card rather than on expanding keeps the list
  // ready by the time anyone opens it.
  const loadReleases = (): void => {
    setReleasesError(null)
    ipcInvoke('updates:releases')
      .then(setReleases)
      .catch((e) => setReleasesError(toMessage(e)))
  }

  useEffect(() => {
    ipcInvoke('settings:get').then(setSettings).catch(() => {})
    ipcInvoke('updates:state').then(setState).catch(() => {})
    loadReleases()
    const offState = ipcOn('event:update-state', setState)
    const offReleases = ipcOn('event:releases', (list) => {
      setReleases(list)
      setReleasesError(null)
    })
    return () => {
      offState()
      offReleases()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onPatch = async (patch: Record<string, unknown>): Promise<void> => {
    setSettings(await ipcInvoke('settings:update', patch))
  }

  const run = (action: () => Promise<unknown>): void => {
    setFailed(null)
    action().catch((e) => setFailed(toMessage(e)))
  }

  const install = async (release: ReleaseSummary): Promise<void> => {
    if (!state) return
    const older = compareVersions(release.version, state.currentVersion) < 0
    const ok = await askConfirm({
      message: older
        ? t('updates.confirmOlder', { version: release.version })
        : t('updates.confirmInstall', { version: release.version }),
      confirmLabel: t('updates.install'),
      danger: older
    })
    if (ok) run(() => ipcInvoke('updates:install', { version: release.version }))
  }

  if (!state || !settings) {
    return (
      <div className="card">
        <h2 className="settings-section-title">{t('updates.title')}</h2>
      </div>
    )
  }

  const busy = state.phase === 'checking' || state.phase === 'downloading'
  const release = state.release
  // The release on offer while there is one, otherwise the one running.
  const pending = state.phase === 'available' || state.phase === 'downloading' || state.phase === 'ready'
  const notes = (pending ? release : releases?.find((r) => r.version === state.currentVersion))?.notes.trim()

  return (
    <div className="card updates-card">
      <h2 className="settings-section-title">{t('updates.title')}</h2>

      <div className="updates-split">
        <div className="updates-main">
          <div className="update-current">
            <span>{t('updates.current', { version: state.currentVersion })}</span>
            {state.currentVersion.includes('-') && <span className="badge accent">{t('updates.channelBeta')}</span>}
          </div>

          <div className="settings-field">
            <span className="settings-label">{t('updates.channel')}</span>
            <Select<UpdateChannel>
              className="block"
              value={settings.updates.channel}
              onChange={(channel) => void onPatch({ updates: { channel } })}
              options={[
                { value: 'stable', label: t('updates.channelStable') },
                { value: 'beta', label: t('updates.channelBeta') }
              ]}
            />
          </div>

          <label className="close-remember">
            <input
              type="checkbox"
              checked={settings.updates.autoCheck}
              onChange={(e) => void onPatch({ updates: { autoCheck: e.target.checked } })}
            />
            {t('updates.autoCheck')}
          </label>

          <div className="update-status">
            <span className="grow">
              {state.phase === 'checking' && t('updates.checking')}
              {state.phase === 'upToDate' && t('updates.upToDate')}
              {state.phase === 'available' && release && t('updates.available', { version: release.version })}
              {state.phase === 'ready' && release && t('updates.ready', { version: release.version })}
              {state.phase === 'error' && state.error && (
                <span className="settings-error">{t(`errors.${state.error}`)}</span>
              )}
            </span>
            {(state.phase === 'idle' || state.phase === 'upToDate' || state.phase === 'error' || state.phase === 'checking') && (
              <button className="ghost" disabled={busy} onClick={() => run(() => ipcInvoke('updates:check'))}>
                {t('updates.check')}
              </button>
            )}
            {state.phase === 'available' && release &&
              (state.supported ? (
                <button className="primary" onClick={() => run(() => ipcInvoke('updates:download'))}>
                  {t('updates.download')}
                </button>
              ) : (
                <button className="primary" onClick={() => window.open(release.url, '_blank')}>
                  {t('updates.openRelease')}
                </button>
              ))}
            {state.phase === 'ready' && (
              <button className="primary" onClick={() => run(() => ipcInvoke('updates:restart'))}>
                {t('updates.restart')}
              </button>
            )}
          </div>
          {state.phase === 'downloading' && <DownloadBar progress={state.progress} />}
          {state.phase === 'ready' && <p className="settings-hint">{t('updates.readyHint')}</p>}
          {!state.supported && <p className="settings-hint">{t('updates.notSupported')}</p>}
          {failed && <p className="mfp-install-error">{failed}</p>}
        </div>

        {/* What to read and where else to go: beside the status, not below it. */}
        <div className="updates-side">
          {notes && (
            <details className="mfp-alt">
              <summary>{t('updates.notes')}</summary>
              <Markdown source={notes} />
            </details>
          )}

          <details
            className="mfp-alt"
            // Only a failed load is tried again on opening; a loaded list refreshes itself.
            onToggle={(e) => e.currentTarget.open && releasesError && loadReleases()}
          >
            <summary>{t('updates.otherVersions')}</summary>
            {releasesError && <p className="mfp-install-error">{releasesError}</p>}
            {!releases && !releasesError && <p className="settings-hint">{t('updates.releasesLoading')}</p>}
            {releases && releases.length === 0 && <p className="settings-hint">{t('updates.noReleases')}</p>}
            {releases && releases.length > 0 && (
              <ul className="release-list">
                {releases.map((r) => {
                  const current = r.version === state.currentVersion
                  return (
                    <li key={r.tag} className="release-row">
                      <span className="release-version">{r.version}</span>
                      {r.channel === 'beta' && <span className="badge accent">{t('updates.channelBeta')}</span>}
                      {r.publishedAt && (
                        <span className="release-date">{new Date(r.publishedAt).toLocaleDateString()}</span>
                      )}
                      <span className="grow" />
                      {current && <span className="badge">{t('updates.installed')}</span>}
                      {/* Without the updater there is nothing to install with, so the
                          row offers the download page instead of a dead button. */}
                      {!current && !state.supported && (
                        <button
                          className="ghost"
                          title={t('updates.openRelease')}
                          onClick={() => window.open(r.url, '_blank')}
                        >
                          {t('updates.openReleaseShort')}
                        </button>
                      )}
                      {!current && state.supported && (
                        <button
                          className="ghost"
                          disabled={busy || state.phase === 'ready'}
                          title={busy || state.phase === 'ready' ? t('updates.installBusy') : undefined}
                          onClick={() => void install(r)}
                        >
                          {t('updates.install')}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </details>
        </div>
      </div>
    </div>
  )
}
