import { useSyncExternalStore } from 'react'
import type { Page } from '../App'
import { ipcInvoke } from '../ipc'
import { SECTIONS, type SectionId, type TourSection } from './steps'

/**
 * The guided tour: what it is showing, and what the user has already been
 * shown.
 *
 * A store rather than React state because the tour outlives every page it
 * walks through — it drives the app from section to section, and the pages it
 * highlights mount and unmount underneath it. The top bar entry, the overlay
 * and the nav rail all read the same one.
 */

/** What settings.json remembers between runs. */
export interface TourProgress {
  welcomed: boolean
  skipAll: boolean
  seen: string[]
}

/**
 * How a step puts the app where it can be seen. The tour is allowed to switch
 * pages and open panels, and nothing else — it never presses the button it is
 * pointing at, because the point is that the user does.
 */
export interface TourDriver {
  goto: (page: Page) => void
  settingsTab: (tab: 'general' | 'appearance' | 'playback') => void
  sources: (open: boolean) => void
  scriptPlayer: (open: boolean) => void
  /** The page on screen now, so a section ending can ask about the one it left the user on. */
  page: () => Page
}

interface TourState {
  /** Settings have been read; nothing starts before that. */
  ready: boolean
  progress: TourProgress
  /** The card asking whether to take the tour at all. */
  welcome: boolean
  /** The section list, for picking one to replay. */
  menu: boolean
  section: SectionId | null
  index: number
  /**
   * The card pointing at the tour's own button, shown once the tour is turned
   * down or left: someone who says no now has to be able to find it later.
   */
  hint: boolean
  /**
   * The section running was picked from the tour's own menu, so the user has
   * just used the button and needs no pointing at it when they leave.
   */
  replaying: boolean
  /**
   * The card asking whether to take this page's section, on the page's first
   * visit. Asked rather than started: arriving on a page is not agreeing to be
   * walked through it.
   */
  offer: SectionId | null
}

const EMPTY_PROGRESS: TourProgress = { welcomed: false, skipAll: false, seen: [] }

let state: TourState = {
  ready: false,
  progress: EMPTY_PROGRESS,
  welcome: false,
  menu: false,
  section: null,
  index: 0,
  hint: false,
  replaying: false,
  offer: null
}

const listeners = new Set<() => void>()

function set(patch: Partial<TourState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): TourState {
  return state
}

export function useTour(): TourState {
  return useSyncExternalStore(subscribe, snapshot)
}

/**
 * The app's own navigation, handed over for as long as the window lives.
 *
 * Re-registered on every render rather than once: the callbacks close over the
 * app's current state, and a driver captured at mount would be steering a
 * window that no longer exists.
 */
let driver: TourDriver | null = null

export function registerTourDriver(next: TourDriver): void {
  driver = next
}

function persist(patch: Partial<TourProgress>): void {
  const progress = { ...state.progress, ...patch }
  set({ progress })
  void ipcInvoke('settings:update', { ui: { tour: progress } }).catch(() => {})
}

function section(id: SectionId | null): TourSection | null {
  return SECTIONS.find((entry) => entry.id === id) ?? null
}

/** The section being walked, if any. */
export function currentSection(): TourSection | null {
  return section(state.section)
}

export async function loadTour(): Promise<void> {
  const settings = await ipcInvoke('settings:get')
  const progress = settings.ui.tour
  set({ ready: true, progress, welcome: !progress.welcomed && !progress.skipAll })
}

function enter(id: SectionId, index: number): void {
  const target = section(id)
  const step = target?.steps[index]
  set({ welcome: false, menu: false, hint: false, offer: null, section: id, index })
  if (driver && step?.place) step.place(driver)
}

function markSeen(id: SectionId): string[] {
  const seen = state.progress.seen.includes(id) ? state.progress.seen : [...state.progress.seen, id]
  if (seen !== state.progress.seen) persist({ seen })
  return seen
}

/** `fromMenu`: the user opened this section with the tour button themselves. */
export function startSection(id: SectionId, fromMenu = false): void {
  if (!state.progress.welcomed) persist({ welcomed: true })
  set({ replaying: fromMenu })
  // A page's own section has no step that goes there — it is normally started
  // on that page. Picked from the menu anywhere else, it has to go first.
  const page = section(id)?.visiting
  if (page && driver && driver.page() !== page) driver.goto(page)
  enter(id, 0)
}

/** The section that belongs to a page, when it has not been shown yet. */
function unseenSectionFor(page: Page): SectionId | null {
  const target = SECTIONS.find((entry) => entry.visiting === page)
  return target && !state.progress.seen.includes(target.id) ? target.id : null
}

/** How long a page gets to draw what its section points at before the question is dropped. */
const OFFER_WAIT_MS = 1500
let offerPoll = 0

/**
 * Ask about a page's section once the page can actually be walked through.
 *
 * A page that is not ready — the media page before any library exists has no
 * sidebar, no search, no shelves — would turn every step into a card pointing
 * at nothing. So the question waits for the section's first control to be on
 * screen, and if it never comes, nothing is asked and nothing is marked seen:
 * the next visit, with a library added, asks then.
 */
function offerWhenReady(page: Page): void {
  window.clearInterval(offerPoll)
  const id = unseenSectionFor(page)
  if (!id) return
  const anchor = section(id)?.steps[0]?.anchor
  const selectors = anchor === undefined ? [] : Array.isArray(anchor) ? anchor : [anchor]
  const started = performance.now()
  offerPoll = window.setInterval(() => {
    const idle = !state.welcome && !state.hint && !state.offer && state.section === null
    if (!idle || driver?.page() !== page || performance.now() - started > OFFER_WAIT_MS) {
      window.clearInterval(offerPoll)
      return
    }
    if (!selectors.some((selector) => document.querySelector(selector))) return
    window.clearInterval(offerPoll)
    set({ offer: id })
  }, 100)
}

/**
 * Leave the section, and carry on into the one it runs into.
 *
 * Only when that next section is still unseen: the first run walks setup
 * straight into playback, but replaying setup from the menu years later should
 * end where the user asked it to end.
 */
function leaveSection(): void {
  const leaving = currentSection()
  if (!leaving) return
  const seen = markSeen(leaving.id)
  const next = leaving.next
  if (next && !seen.includes(next)) {
    enter(next, 0)
    return
  }
  // The section may have left the user on a page they have never been walked
  // through — the first run ends on the media page. That page's first visit
  // is now, so ask about it now rather than the next time they come back.
  set({ section: null, index: 0 })
  const page = driver?.page()
  if (page) offerWhenReady(page)
}

export function nextStep(): void {
  const target = currentSection()
  if (!target) return
  const index = state.index + 1
  if (index >= target.steps.length) leaveSection()
  else enter(target.id, index)
}

export function previousStep(): void {
  const target = currentSection()
  if (!target || state.index === 0) return
  enter(target.id, state.index - 1)
}

/** The X, and the "skip this section" button: the same thing. */
export function skipSection(): void {
  leaveSection()
}

/**
 * Leave the tour altogether. The section being left counts as seen, so its
 * page does not ask again; nothing else is asked straight after being told no.
 */
export function skipEverything(): void {
  if (state.section) markSeen(state.section)
  persist({ welcomed: true, skipAll: true })
  set({ welcome: false, menu: false, section: null, index: 0, offer: null, hint: !state.replaying })
}

/** Yes to a page's section. */
export function acceptOffer(): void {
  if (state.offer) startSection(state.offer)
}

/** No to a page's section: that page does not ask again. */
export function declineOffer(): void {
  if (!state.offer) return
  markSeen(state.offer)
  set({ offer: null })
}

export function dismissHint(): void {
  set({ hint: false })
}

/** The welcome card's other button. Pages still ask on their first visit. */
export function declineTour(): void {
  skipEverything()
}

/**
 * Forget what has been shown. The sections that appear on a tab's first visit
 * become due again, which is the only way back to them once they have run.
 */
export function resetTour(): void {
  persist({ welcomed: true, skipAll: false, seen: [] })
  set({ menu: false, section: null, index: 0, offer: null })
}

export function openTourMenu(): void {
  set({ menu: true, welcome: false, hint: false, offer: null })
}

export function closeTourMenu(): void {
  set({ menu: false })
}

/**
 * The user opened a tab: ask about its section if it has never been shown.
 *
 * Called from the nav rail rather than from the page state, so that the tour
 * driving itself onto a page is not mistaken for the user going there — the
 * setup section passes through the libraries page, and that must not ask about
 * the tags section in the middle of it.
 *
 * Asked even after the welcome card was turned down: that was a no to the
 * setup walk-through, not to ever hearing about the other pages.
 */
export function visitPage(page: Page): void {
  if (!state.ready || state.welcome || state.hint || state.offer || state.section !== null) return
  offerWhenReady(page)
}
