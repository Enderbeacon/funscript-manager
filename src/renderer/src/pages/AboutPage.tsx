import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IpcOutput } from '@shared/ipc/contract'
import { ipcInvoke } from '../ipc'
import UpdatesCard from '../components/UpdatesCard'

/**
 * What this build is, and how to move to another one.
 *
 * Its own entry in the rail rather than a card in settings: an update is
 * something people come looking for, and the settings page is where it was
 * least likely to be found.
 */

const REPOSITORY = 'https://github.com/Enderbeacon/funscript-manager'

export default function AboutPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [info, setInfo] = useState<IpcOutput<'app:getInfo'> | null>(null)

  useEffect(() => {
    ipcInvoke('app:getInfo').then(setInfo).catch(() => {})
  }, [])

  return (
    <div className="settings-page about-page">
      <h1 className="page-title">{t('nav.about')}</h1>

      <div className="about-cols">
        <UpdatesCard />

        <div className="card">
          <h2 className="settings-section-title">{t('about.title')}</h2>
          <p className="about-name">{t('app.title')}</p>
          <dl className="about-facts">
            <dt>{t('about.version')}</dt>
            <dd>{info?.version ?? '…'}</dd>
            <dt>Electron</dt>
            <dd>{info?.electron ?? '…'}</dd>
            <dt>{t('about.dataFolder')}</dt>
            <dd className="about-path" title={info?.userDataPath ?? ''}>
              {info?.userDataPath ?? '…'}
            </dd>
          </dl>
          <div className="about-links">
            <button className="ghost" onClick={() => window.open(REPOSITORY, '_blank')}>
              {t('about.repository')}
            </button>
            <button className="ghost" onClick={() => window.open(`${REPOSITORY}/releases`, '_blank')}>
              {t('about.releases')}
            </button>
            <button className="ghost" onClick={() => window.open(`${REPOSITORY}/issues`, '_blank')}>
              {t('about.issues')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
