import type { Page } from '../App'
import type { TourDriver } from './tour'

/**
 * What the tour walks through, in order.
 *
 * Copy is not here — every step's title and body come from the i18n bundle
 * under `tour.steps.<section>.<step>`. What is here is where each step points
 * and, for the ones the user has to actually carry out, how the app can tell
 * it happened.
 */

export type SectionId = 'setup' | 'playback' | 'media' | 'tags' | 'posts' | 'match'

export interface TourStep {
  /** Also the last part of its i18n key. */
  id: string
  /** Put the app where the step can be seen, before anything is measured. */
  place?: (drive: TourDriver) => void
  /**
   * The control the step is about, as a selector. Without one the step is a
   * card in the middle of the window with nothing cut out behind it.
   *
   * Several selectors light one area covering all of them, for a step that is
   * about a group of controls rather than one — the first match of each counts.
   */
  anchor?: string | string[]
  /** Widen the cut-out, for a control whose box is tighter than its meaning. */
  pad?: number
  /**
   * A step the user has to finish rather than read.
   *
   * True once it is done, at which point the tour moves on by itself. These
   * are all read off the screen — a dependency row's green dot, a library
   * card, an output tab that says it is connected — so that watching for them
   * costs a `querySelector` and never a round trip to a program or a website.
   */
  done?: () => boolean
}

export interface TourSection {
  id: SectionId
  steps: TourStep[]
  /** Runs straight into this section when it ends, while that one is unseen. */
  next?: SectionId
  /** The tab whose first visit starts this section. */
  visiting?: Page
}

const has = (selector: string): boolean => document.querySelector(selector) !== null

/** The top bar entry that reopens the tour; pointed at from inside it and after leaving it. */
export const TOUR_BUTTON = '[data-tour="topbar-tour"]'

export const SECTIONS: TourSection[] = [
  {
    id: 'setup',
    next: 'playback',
    steps: [
      // First, so that leaving at any later step still leaves the user knowing
      // where the way back is.
      {
        id: 'tourButton',
        place: (drive) => {
          drive.sources(false)
          drive.scriptPlayer(false)
        },
        anchor: TOUR_BUTTON,
        pad: 4
      },
      {
        id: 'settings',
        place: (drive) => drive.goto('settings'),
        anchor: '[data-tour="nav-settings"]'
      },
      {
        id: 'ytdlp',
        place: (drive) => drive.settingsTab('general'),
        anchor: '[data-tour="dep-ytdlp"]',
        done: () => has('[data-tour="dep-ytdlp"] .dep-dot.ok')
      },
      {
        id: 'ffmpeg',
        anchor: '[data-tour="dep-ffmpeg"]',
        done: () => has('[data-tour="dep-ffmpeg"] .dep-dot.ok')
      },
      { id: 'session', anchor: '[data-tour="topbar-session"]', pad: 4 },
      {
        id: 'libraries',
        place: (drive) => drive.goto('tagLibraries'),
        anchor: '[data-tour="nav-tagLibraries"]'
      },
      {
        id: 'addLibrary',
        anchor: '[data-tour="library-add"]',
        pad: 6,
        done: () => has('[data-tour="library-row"]')
      },
      { id: 'scan', anchor: '[data-tour="library-row"]' }
    ]
  },
  {
    id: 'playback',
    steps: [
      {
        id: 'sources',
        place: (drive) => {
          drive.scriptPlayer(false)
          drive.goto('media')
          drive.sources(true)
        },
        anchor: '[data-tour="topbar-sources"]',
        pad: 4
      },
      { id: 'sourceList', anchor: '[data-tour="sources-list"]' },
      { id: 'addSource', anchor: '[data-tour="sources-add"]' },
      {
        id: 'scriptPlayer',
        place: (drive) => {
          drive.sources(false)
          drive.scriptPlayer(true)
        },
        anchor: '[data-tour="topbar-script-player"]',
        pad: 4
      },
      { id: 'route', anchor: '[data-tour="sp-route"]' },
      {
        id: 'addOutput',
        anchor: '[data-tour="sp-add"]',
        done: () => has('[data-tour="sp-outputs"] button')
      },
      {
        id: 'connect',
        // The port, protocol and the rest are what has to be right before the
        // button does anything, so they are lit along with it.
        anchor: ['[data-tour="sp-connection"]', '[data-tour="sp-connect"]'],
        pad: 6,
        done: () => has('[data-tour="sp-outputs"] .sp-tab-dot.connected')
      },
      {
        id: 'play',
        place: (drive) => {
          drive.scriptPlayer(false)
          drive.goto('media')
        },
        anchor: '[data-tour="media-stage"]'
      }
    ]
  },
  {
    id: 'media',
    visiting: 'media',
    steps: [
      { id: 'sidebar', anchor: '[data-tour="media-sidebar"]' },
      { id: 'search', anchor: '[data-tour="media-search"]', pad: 4 },
      { id: 'shelves', anchor: '[data-tour="media-shelves"]' },
      { id: 'view', anchor: '[data-tour="media-view"]', pad: 4 },
      { id: 'playlists', anchor: '[data-tour="media-playlists"]', pad: 4 },
      { id: 'sync', anchor: '[data-tour="media-sync"]', pad: 4 },
      { id: 'detail', anchor: '[data-tour="media-stage"]' }
    ]
  },
  {
    id: 'tags',
    visiting: 'tagLibraries',
    steps: [
      { id: 'kinds', anchor: '[data-tour="organise-kinds"]' },
      { id: 'new', anchor: '[data-tour="organise-new"]', pad: 6 },
      { id: 'list', anchor: '[data-tour="organise-list"]' },
      { id: 'clean', anchor: '[data-tour="organise-clean"]', pad: 6 },
      { id: 'libraries', anchor: '[data-tour="library-add"]', pad: 6 }
    ]
  },
  {
    id: 'posts',
    visiting: 'posts',
    steps: [
      { id: 'paste', anchor: '[data-tour="posts-input"]' },
      { id: 'library', anchor: '[data-tour="posts-library"]', pad: 4 },
      { id: 'parse', anchor: '[data-tour="posts-parse"]', pad: 6 },
      { id: 'pick', anchor: '[data-tour="post-card"]' },
      { id: 'queue', anchor: '[data-tour="posts-queue"]' }
    ]
  },
  {
    id: 'match',
    visiting: 'match',
    steps: [
      { id: 'start', anchor: '[data-tour="match-start"]', pad: 6 },
      { id: 'review', anchor: '[data-tour="match-review"]' }
    ]
  }
]
