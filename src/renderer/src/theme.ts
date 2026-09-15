/**
 * Theme application (settings.ui.theme + settings.ui.palette). The renderer
 * always sets an explicit `data-theme` on <html>; themes.css has no media
 * queries, so 'system' is resolved here via matchMedia and tracked live.
 *
 * User colours are written as inline custom properties on the same element,
 * which outrank the `:root[data-theme=…]` blocks. Only the seeds listed in
 * PALETTE_SEEDS are written — everything else in themes.css mixes from them,
 * so a re-tint stays internally consistent without us recomputing anything.
 */

import { PALETTE_SEEDS, type PaletteOverride } from '@shared/schemas/app-config'

export type ThemeSetting = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export interface PaletteSetting {
  light: PaletteOverride
  dark: PaletteOverride
}

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

let followSystem: ((e: MediaQueryListEvent) => void) | null = null
let palette: PaletteSetting = { light: {}, dark: {} }
let resolved: ResolvedTheme = systemDark.matches ? 'dark' : 'light'

const listeners = new Set<(theme: ResolvedTheme) => void>()

/** Which theme is actually painted right now ('system' already resolved). */
export function currentTheme(): ResolvedTheme {
  return resolved
}

/** Notify on resolved-theme changes, so the settings editor edits what is on screen. */
export function onThemeChange(fn: (theme: ResolvedTheme) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function paint(): void {
  const root = document.documentElement
  root.dataset['theme'] = resolved
  const overrides = palette[resolved] ?? {}
  for (const [seed, cssVar] of Object.entries(PALETTE_SEEDS)) {
    const value = overrides[seed as keyof typeof PALETTE_SEEDS]
    // Clearing rather than skipping: removing a colour in settings has to put
    // the built-in one back, and an inline property lingers until removed.
    if (value) root.style.setProperty(cssVar, value)
    else root.style.removeProperty(cssVar)
  }
}

function setResolved(theme: ResolvedTheme): void {
  resolved = theme
  paint()
  for (const fn of listeners) fn(theme)
}

/** Apply the persisted settings.ui.theme value (call again on change). */
export function applyThemeSetting(setting: ThemeSetting): void {
  if (followSystem) {
    systemDark.removeEventListener('change', followSystem)
    followSystem = null
  }
  if (setting === 'system') {
    setResolved(systemDark.matches ? 'dark' : 'light')
    followSystem = (e): void => setResolved(e.matches ? 'dark' : 'light')
    systemDark.addEventListener('change', followSystem)
  } else {
    setResolved(setting)
  }
}

/** Apply persisted settings.ui.palette (call again on change, including live edits). */
export function applyPaletteSetting(next: PaletteSetting): void {
  palette = next
  paint()
}
