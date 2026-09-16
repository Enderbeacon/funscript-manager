import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { BookOpen, House } from 'lucide-react'
import { siGithub } from 'simple-icons'
import { COPYRIGHT_NOTICE } from '@shared/constants'
import type { IpcOutput } from '@shared/ipc/contract'
import { ipcInvoke } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { useDialogEscape } from '../components/ConfirmDialog'
import UpdatesCard from '../components/UpdatesCard'
import brandWordmark from '../assets/brand/wordmark.svg?raw'

/**
 * What this build is, and how to move to another one.
 *
 * Its own entry in the rail rather than a card in settings: an update is
 * something people come looking for, and the settings page is where it was
 * least likely to be found.
 */

const REPOSITORY = 'https://github.com/Enderbeacon/funscript-manager'
const WEBSITE = 'https://enderbeacon.github.io/funscript-manager/'

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

        {/* In the grid, so each row is a pair with one gap across and down. */}
        <ProjectCard />
        <LicensesCard />
      </div>
    </div>
  )
}

/**
 * A personal word from the author, deliberately in English in every language.
 * When a supporter page exists, add its link below and say so here.
 */
const AUTHOR_NOTE =
  "Hi, thanks for using Funscript Manager! It's a personal project I build and maintain in my " +
  'free time. If you find it useful, consider giving it a star on GitHub or reporting any bugs ' +
  'you run into. Thank you!'

/** The project itself: its name, where to find it, and a note from the author. */
function ProjectCard(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="card about-project">
      {/* Inline rather than an <img>: the lettering takes its colors from the
          theme, which an image cannot see. The markup is our own asset. */}
      <div
        className="about-wordmark"
        role="img"
        aria-label={t('app.title')}
        dangerouslySetInnerHTML={{ __html: brandWordmark }}
      />
      <div className="about-links">
        <button className="ghost" onClick={() => window.open(WEBSITE, '_blank')}>
          <House size={14} />
          {t('about.website')}
        </button>
        <button className="ghost" onClick={() => window.open(`${WEBSITE}guide/`, '_blank')}>
          <BookOpen size={14} />
          {t('about.documentation')}
        </button>
        <button className="ghost" onClick={() => window.open(REPOSITORY, '_blank')}>
          <svg className="about-brand-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d={siGithub.path} />
          </svg>
          GitHub
        </button>
      </div>
      <p className="about-note">
        {AUTHOR_NOTE}
        <span className="about-signature">— Enderbeacon</span>
      </p>
    </div>
  )
}

type LicenseId = 'app' | 'thirdParty'

/**
 * What the license means, in English in every language: a translation could
 * read as a different promise from the one the license text makes.
 */
const LICENSE_SUMMARY =
  'Released under the GNU AGPL v3.0 or later, without any warranty. The open-source ' +
  'components it uses keep their own licenses.'

/** The app's own license and every third-party one it carries. */
function LicensesCard(): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [failed, setFailed] = useState<string | null>(null)
  const [shown, setShown] = useState<{ which: LicenseId; text: string } | null>(null)

  const open = (which: LicenseId): void => {
    setFailed(null)
    ipcInvoke('app:readLicense', { which })
      .then(({ text }) => setShown({ which, text }))
      .catch((e) => setFailed(toMessage(e)))
  }

  return (
    <div className="card">
      <h2 className="settings-section-title">{t('about.licenses')}</h2>
      <p className="about-copyright">{COPYRIGHT_NOTICE}</p>
      <p className="settings-hint">{LICENSE_SUMMARY}</p>
      <div className="about-links">
        <button className="ghost" onClick={() => open('app')}>
          {t('about.licenseText')}
        </button>
        <button className="ghost" onClick={() => open('thirdParty')}>
          {t('about.thirdPartyLicenses')}
        </button>
      </div>
      {failed && <p className="mfp-install-error">{failed}</p>}
      {shown && (
        <LicenseDialog
          title={t(shown.which === 'app' ? 'about.licenseText' : 'about.thirdPartyLicenses')}
          text={shown.text}
          onClose={() => setShown(null)}
        />
      )}
    </div>
  )
}

function LicenseDialog({
  title,
  text,
  onClose
}: {
  title: string
  text: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  useDialogEscape(onClose)
  return createPortal(
    <div className="modal-scrim">
      <div className="modal license-modal">
        <div className="modal-head">
          <span className="grow">{title}</span>
        </div>
        <div className="modal-body">
          <pre className="license-text">{text}</pre>
        </div>
        <div className="modal-foot">
          <div className="grow" />
          <button className="primary" autoFocus onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
