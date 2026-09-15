import { useTranslation } from 'react-i18next'
import { Check, GraduationCap } from 'lucide-react'
import { SECTIONS } from './steps'
import { closeTourMenu, openTourMenu, resetTour, startSection, useTour } from './tour'

/**
 * The way back into the tour, at any time. Every section can be replayed on
 * its own, so a user who skipped the one about downloading posts a month ago
 * can go straight to it without sitting through setup again.
 */
export default function TourButton(): React.JSX.Element {
  const { t } = useTranslation()
  const tour = useTour()

  return (
    <div className="topbar-tour">
      <button
        className={`topbar-btn${tour.menu ? ' active' : ''}`}
        data-tour="topbar-tour"
        onClick={() => (tour.menu ? closeTourMenu() : openTourMenu())}
        title={t('tour.title')}
        aria-label={t('tour.title')}
      >
        <GraduationCap size={15} />
      </button>
      {tour.menu && (
        <>
          <div className="topbar-scrim" onClick={closeTourMenu} />
          <div className="topbar-menu tour-menu">
            {SECTIONS.map((section) => (
              <button key={section.id} onClick={() => startSection(section.id, true)}>
                <span className="grow">{t(`tour.section.${section.id}`)}</span>
                {tour.progress.seen.includes(section.id) && <Check size={13} />}
              </button>
            ))}
            <button className="tour-menu-reset" onClick={resetTour}>
              {t('tour.reset')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
