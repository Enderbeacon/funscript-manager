import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GraduationCap, X } from 'lucide-react'
import { TOUR_BUTTON, type TourStep } from './steps'
import {
  acceptOffer,
  currentSection,
  declineOffer,
  declineTour,
  dismissHint,
  nextStep,
  previousStep,
  skipEverything,
  skipSection,
  startSection,
  useTour
} from './tour'

/**
 * The tour's own layer: the dimmed window, the cut-out around whatever the
 * current step is about, and the card that explains it.
 *
 * The dimming is four rectangles rather than one box with a hole punched
 * through it, because the point of the hole is that the control inside it can
 * still be pressed — and a mask that covers the whole window cannot let a
 * click through, however it is painted.
 */

interface Box {
  top: number
  left: number
  width: number
  height: number
}

/** Distance between the cut-out and the card. */
const GAP = 14
const CARD_WIDTH = 340
/** How long a step's control gets to appear before the step reads as a note. */
const APPEAR_GRACE_MS = 1200
/** How long a step's control has to be on screen before a change to it is the user's. */
const SETTLE_MS = 800
/** The card left behind when the tour is turned down or left. */
const HINT_STEP: TourStep = { id: 'hint', anchor: TOUR_BUTTON, pad: 4 }

/**
 * Everything that opens on top of the page when a control is pressed: dialogs,
 * dropdown lists, context and chip menus, the top bar's menus.
 *
 * The tour's dimming sits above all of them, so pressing the control a step is
 * about — "add an output" — would open its choices underneath, dimmed and out
 * of reach. While one of these is open the cut-out moves to it instead. A new
 * kind of popup that the tour should make room for belongs in this list.
 */
const POPUPS = [
  '[role="dialog"]',
  '[role="listbox"]',
  '.modal',
  '.ctxmenu',
  '.chip-menu',
  '.name-search',
  '.topbar-menu'
].join(', ')
const POPUP_PAD = 6

/**
 * Where a step's anchor is: the one element, or the area covering the first
 * match of each selector. Null until at least one of them is on screen.
 */
function findAnchor(anchor: string | string[] | undefined): { element: Element; rect: Box } | null {
  if (!anchor) return null
  let first: Element | null = null
  let area: { top: number; left: number; right: number; bottom: number } | null = null
  for (const selector of Array.isArray(anchor) ? anchor : [anchor]) {
    const element = document.querySelector(selector)
    const rect = element?.getBoundingClientRect()
    if (!element || !rect || (rect.width === 0 && rect.height === 0)) continue
    first ??= element
    area = area
      ? {
          top: Math.min(area.top, rect.top),
          left: Math.min(area.left, rect.left),
          right: Math.max(area.right, rect.right),
          bottom: Math.max(area.bottom, rect.bottom)
        }
      : { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom }
  }
  if (!first || !area) return null
  return {
    element: first,
    rect: { top: area.top, left: area.left, width: area.right - area.left, height: area.bottom - area.top }
  }
}

/** The area every open popup covers, or null when none is open. */
function popupRect(): { top: number; left: number; right: number; bottom: number } | null {
  let area: { top: number; left: number; right: number; bottom: number } | null = null
  for (const element of document.querySelectorAll(POPUPS)) {
    if (element.closest('.tour-layer')) continue
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    area = area
      ? {
          top: Math.min(area.top, rect.top),
          left: Math.min(area.left, rect.left),
          right: Math.max(area.right, rect.right),
          bottom: Math.max(area.bottom, rect.bottom)
        }
      : { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom }
  }
  return area
}

/**
 * Follow the step's control, wherever it goes — or the popup it opened.
 *
 * A frame loop rather than a resize listener: the control can move because the
 * window changed, because a panel opened next to it, because the list it is in
 * scrolled, or because it is still animating into place. Measuring every frame
 * covers all of those, and only a changed rectangle reaches React.
 */
function useAnchor(
  step: TourStep | null,
  key: string
): { box: Box | null; missing: boolean; popup: boolean } {
  const [box, setBox] = useState<Box | null>(null)
  const [missing, setMissing] = useState(false)
  const [popup, setPopup] = useState(false)
  const scrolledFor = useRef('')

  // Joined so an array written inline in the step list does not restart the
  // loop on every render; `findAnchor` takes it apart again.
  const anchorKey = Array.isArray(step?.anchor) ? step.anchor.join('\n') : (step?.anchor ?? '')
  const pad = step?.pad ?? 0

  useEffect(() => {
    setMissing(false)
    const start = performance.now()
    // The previous step's cut-out stays up until this step's control has been
    // measured once, so the outline slides from one to the other instead of the
    // dimming closing for a frame in between. `null` means "not measured yet":
    // the first frame always replaces the old rectangle, found or not.
    let signature: string | null = null
    let frame = 0

    const show = (next: Box): void => {
      const nextSignature = `${next.top}|${next.left}|${next.width}|${next.height}`
      if (nextSignature === signature) return
      signature = nextSignature
      setBox(next)
      setMissing(false)
    }

    const tick = (): void => {
      frame = requestAnimationFrame(tick)

      const open = popupRect()
      setPopup(open !== null)
      if (open) {
        show({
          top: open.top - POPUP_PAD,
          left: open.left - POPUP_PAD,
          width: open.right - open.left + POPUP_PAD * 2,
          height: open.bottom - open.top + POPUP_PAD * 2
        })
        return
      }

      const found = findAnchor(anchorKey ? anchorKey.split('\n') : undefined)
      if (!found) {
        if (!anchorKey || performance.now() - start > APPEAR_GRACE_MS) setMissing(true)
        if (signature !== '') {
          signature = ''
          setBox(null)
        }
        return
      }

      // Once per step, and only when it is not already in view: a control the
      // user can see should not slide under them as the card appears.
      const { element, rect } = found
      if (scrolledFor.current !== key) {
        scrolledFor.current = key
        if (rect.top < 72 || rect.top + rect.height > window.innerHeight - 72) {
          element.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
      }

      show({
        top: rect.top - pad,
        left: rect.left - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2
      })
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [anchorKey, pad, key])

  return { box, missing, popup }
}

/**
 * Where the card goes: below the cut-out if it fits, then above, then beside.
 * Whichever side wins, the card is kept inside the window.
 */
function cardPosition(box: Box | null, width: number, height: number): { left: number; top: number } {
  const view = { w: window.innerWidth, h: window.innerHeight }
  if (!box) {
    return { left: (view.w - width) / 2, top: (view.h - height) / 2 }
  }

  const clamp = (value: number, max: number): number => Math.max(12, Math.min(value, max - 12))
  const below = view.h - (box.top + box.height) - GAP
  const above = box.top - GAP
  const right = view.w - (box.left + box.width) - GAP

  if (below >= height) {
    return {
      left: clamp(box.left + box.width / 2 - width / 2, view.w - width),
      top: box.top + box.height + GAP
    }
  }
  if (above >= height) {
    return {
      left: clamp(box.left + box.width / 2 - width / 2, view.w - width),
      top: box.top - GAP - height
    }
  }
  if (right >= width) {
    return {
      left: box.left + box.width + GAP,
      top: clamp(box.top + box.height / 2 - height / 2, view.h - height)
    }
  }
  return {
    left: clamp(box.left - GAP - width, view.w - width),
    top: clamp(box.top + box.height / 2 - height / 2, view.h - height)
  }
}

/**
 * The four rectangles that dim everything except the cut-out.
 *
 * Always the same four elements. Swapping in a single full-window sheet when
 * there is no cut-out would make React rebuild the other panels on the way
 * back, and each rebuilt panel replays its fade-in.
 *
 * No cut-out is a cut-out of no size in the middle of the window, in pixels
 * like every other one. The panels slide between cut-outs, and they only stay
 * edge to edge while sliding if every panel is moving between two rectangles of
 * the same kind — "the whole window" spelled as 100% slid against a pixel
 * rectangle opens a band of undimmed page for the length of the slide.
 */
function Mask({ box }: { box: Box | null }): React.JSX.Element {
  const cut = box ?? {
    top: Math.round(window.innerHeight / 2),
    left: Math.round(window.innerWidth / 2),
    width: 0,
    height: 0
  }
  const top = Math.max(0, cut.top)
  const left = Math.max(0, cut.left)
  const bottom = cut.top + cut.height
  const right = cut.left + cut.width
  return (
    <>
      <div className="tour-mask" style={{ left: 0, top: 0, width: '100%', height: top }} />
      <div className="tour-mask" style={{ left: 0, top: bottom, width: '100%', bottom: 0 }} />
      <div className="tour-mask" style={{ left: 0, top: cut.top, width: left, height: cut.height }} />
      <div className="tour-mask" style={{ left: right, top: cut.top, right: 0, height: cut.height }} />
      {box && (
        <div
          className="tour-ring"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
    </>
  )
}

export default function TourOverlay(): React.JSX.Element | null {
  const { t } = useTranslation()
  const tour = useTour()
  const section = currentSection()
  const step = tour.hint ? HINT_STEP : (section?.steps[tour.index] ?? null)
  const key = tour.hint ? 'hint' : `${tour.section ?? ''}:${tour.index}`

  const { box, missing, popup } = useAnchor(step, key)
  const card = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: CARD_WIDTH, height: 180 })

  /**
   * Steps the user has to carry out rather than read.
   *
   * Already satisfied when the step opens — the dependency was installed last
   * week — and it is just a note: moving on by itself would flash past before
   * anyone could read why they were being shown it. Only a change made while
   * the step is up carries the user forward.
   */
  const [satisfied, setSatisfied] = useState(true)
  const [waiting, setWaiting] = useState(false)

  useEffect(() => {
    const check = step?.done
    if (!check) {
      setSatisfied(true)
      setWaiting(false)
      return
    }
    const already = check()
    setSatisfied(already)
    // Drawn as a step to carry out straight away. Holding that back until the
    // reading below settles would redraw every such card a moment after it
    // appears, and most of them are not done yet.
    setWaiting(!already)
    if (already) return

    /*
     * "Not done" read the moment a step opens is often "not on screen yet": the
     * dependency rows appear only once their status has been fetched, and the
     * output list once the saved outputs are read. So what the screen shows is
     * not taken as the starting point until the step's control has been there
     * for a moment. Turning done inside that moment is the same as having been
     * done all along — a note, not the user's doing, and no moving on.
     */
    const anchor = step.anchor
    let shownSince: number | null = null
    let advance = 0
    const poll = window.setInterval(() => {
      if (shownSince === null && findAnchor(anchor)) {
        shownSince = performance.now()
      }
      if (!check()) return
      const settling = shownSince === null || performance.now() - shownSince < SETTLE_MS
      window.clearInterval(poll)
      setSatisfied(true)
      setWaiting(false)
      if (!settling) advance = window.setTimeout(nextStep, 500)
    }, 150)
    return () => {
      window.clearInterval(poll)
      window.clearTimeout(advance)
    }
  }, [step, key])

  useLayoutEffect(() => {
    const element = card.current
    if (!element) return
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      setSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [key, tour.welcome, tour.offer])

  const running = tour.section !== null && step !== null

  useEffect(() => {
    // An open popup has the keyboard: Escape closes it, not the tour, and the
    // arrow keys move through its list.
    if ((!running && !tour.hint && !tour.offer) || popup) return
    const hint = tour.hint
    const offer = tour.offer
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (offer) {
        if (event.key === 'Enter') acceptOffer()
        else if (event.key === 'Escape') declineOffer()
        else return
      } else if (hint) {
        if (event.key !== 'Escape' && event.key !== 'Enter') return
        dismissHint()
      } else if (event.key === 'ArrowRight') nextStep()
      else if (event.key === 'ArrowLeft') previousStep()
      else if (event.key === 'Escape') skipSection()
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    // Capture, so the tour answers Escape before the panels underneath it do.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [running, tour.hint, tour.offer, popup])

  if (tour.welcome) {
    const position = cardPosition(null, size.width, size.height)
    return (
      <div className="tour-layer">
        {/* The same Mask the steps use, so starting the tour keeps the dimming
            that is already up rather than fading it in a second time. */}
        <Mask box={null} />
        <div
          className="tour-card tour-welcome"
          ref={card}
          style={{ left: position.left, top: position.top, width: CARD_WIDTH }}
        >
          <div className="tour-card-title">
            <GraduationCap size={17} />
            {t('tour.welcome.title')}
          </div>
          <p className="tour-card-body">{t('tour.welcome.body')}</p>
          <div className="tour-card-actions">
            <button className="ghost sm" onClick={declineTour}>
              {t('tour.welcome.skip')}
            </button>
            <div className="grow" />
            <button className="primary sm" onClick={() => startSection('setup')}>
              {t('tour.welcome.start')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (tour.offer) {
    const position = cardPosition(null, size.width, size.height)
    return (
      <div className="tour-layer">
        <Mask box={null} />
        <div
          className="tour-card tour-welcome"
          ref={card}
          style={{ left: position.left, top: position.top, width: CARD_WIDTH }}
        >
          <div className="tour-card-title">
            <GraduationCap size={17} />
            {t('tour.offer.title')}
          </div>
          <p className="tour-card-body">
            {t('tour.offer.body', { section: t(`tour.section.${tour.offer}`) })}
          </p>
          <div className="tour-card-actions">
            <button className="ghost sm" onClick={declineOffer}>
              {t('tour.offer.skip')}
            </button>
            <div className="grow" />
            <button className="primary sm" onClick={acceptOffer}>
              {t('tour.offer.start')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (tour.hint) {
    const anchored = box !== null && !missing
    const position = cardPosition(anchored ? box : null, size.width, size.height)
    return (
      <div className="tour-layer">
        <Mask box={anchored ? box : null} />
        <div
          className="tour-card"
          ref={card}
          style={{ left: position.left, top: position.top, width: CARD_WIDTH }}
        >
          <div className="tour-card-title">
            <GraduationCap size={17} />
            {t('tour.hint.title')}
          </div>
          <p className="tour-card-body">{t('tour.hint.body')}</p>
          <div className="tour-card-actions">
            <div className="grow" />
            <button className="primary sm" onClick={dismissHint}>
              {t('tour.hint.ok')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!running || !section || !step) return null

  // A control that never appeared leaves the step as something to read: the
  // window may be too narrow for it, or the panel it lives in may be gone.
  const anchored = box !== null && !missing
  const position = cardPosition(anchored ? box : null, size.width, size.height)
  // Whether the step is something to do is decided by its control having gone
  // missing, not by it having been found yet: a control still loading in would
  // otherwise draw the card plain first and redraw it a moment later.
  const blocked = waiting && !missing
  const last = tour.index === section.steps.length - 1

  return (
    <div className="tour-layer">
      <Mask box={anchored ? box : null} />
      <div
        className="tour-card"
        ref={card}
        style={{ left: position.left, top: position.top, width: CARD_WIDTH }}
      >
        <div className="tour-card-head">
          <span className="tour-card-section">{t(`tour.section.${section.id}`)}</span>
          <span className="tour-card-count">
            {t('tour.progress', { index: tour.index + 1, total: section.steps.length })}
          </span>
          <button className="icon-btn" title={t('tour.skipSection')} onClick={skipSection}>
            <X size={15} />
          </button>
        </div>
        <div className="tour-card-title">{t(`tour.steps.${section.id}.${step.id}.title`)}</div>
        <p className="tour-card-body">{t(`tour.steps.${section.id}.${step.id}.body`)}</p>
        {blocked && <p className="tour-card-wait">{t('tour.autoAdvance')}</p>}
        {satisfied && step.done && !missing && (
          <p className="tour-card-ok">{t('tour.stepDone')}</p>
        )}
        <div className="tour-card-actions">
          <button className="ghost sm" onClick={skipEverything}>
            {t('tour.skipAll')}
          </button>
          <div className="grow" />
          {tour.index > 0 && (
            <button className="ghost sm" onClick={previousStep}>
              {t('tour.back')}
            </button>
          )}
          <button className={blocked ? 'ghost sm' : 'primary sm'} onClick={nextStep}>
            {blocked ? t('tour.skipStep') : last ? t('tour.finish') : t('tour.next')}
          </button>
        </div>
      </div>
    </div>
  )
}
