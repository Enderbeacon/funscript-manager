import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PALETTE_SEEDS, type PaletteOverride, type PaletteSeed } from '@shared/schemas/app-config'
import { applyPaletteSetting, currentTheme, onThemeChange, type ResolvedTheme } from '../theme'

/**
 * Colour editor for the palette seeds (themes.css). Edits whatever theme is
 * on screen — re-tinting dark while looking at light is how people end up
 * with two palettes that do not match.
 *
 * Every change repaints immediately and saves; the swatch is a native colour
 * input, so the browser owns the picker and we own only the value.
 */

export interface PaletteValue {
  light: PaletteOverride
  dark: PaletteOverride
}

/** Grouped for the UI only; the schema keeps them flat. */
const GROUPS: { key: string; seeds: PaletteSeed[] }[] = [
  { key: 'brand', seeds: ['accent', 'gradA', 'gradB'] },
  { key: 'glow', seeds: ['blob1', 'blob2', 'blob3'] },
  { key: 'base', seeds: ['bgPage', 'surface', 'textPrimary'] },
  { key: 'state', seeds: ['danger', 'success', 'warn'] }
]

/**
 * Presets set every seed for BOTH themes: a preset that only touched the
 * visible one would look right until the user flipped the theme.
 */
const PRESETS: { key: string; value: PaletteValue }[] = [
  {
    key: 'indigo',
    value: {
      dark: {
        bgPage: '#0b0d12', surface: '#ffffff', textPrimary: '#f2f4f8',
        accent: '#7aa7ff', gradA: '#5b8cff', gradB: '#a06bff',
        blob1: '#5865f2', blob2: '#06b6d4', blob3: '#db2777',
        danger: '#ff7b6b', success: '#57d68b', warn: '#ffc861'
      },
      light: {
        bgPage: '#eef0f7', surface: '#ffffff', textPrimary: '#161a24',
        accent: '#3b5bdb', gradA: '#4c6fff', gradB: '#9333ea',
        blob1: '#6366f1', blob2: '#0ea5e9', blob3: '#ec4899',
        danger: '#d64545', success: '#2f9e5f', warn: '#b57d15'
      }
    }
  },
  {
    key: 'teal',
    value: {
      dark: {
        bgPage: '#08110f', surface: '#ffffff', textPrimary: '#eaf5f1',
        accent: '#5fd4c0', gradA: '#2dd4bf', gradB: '#3b82f6',
        blob1: '#14b8a6', blob2: '#0ea5e9', blob3: '#84cc16',
        danger: '#ff7b6b', success: '#57d68b', warn: '#ffc861'
      },
      light: {
        bgPage: '#eaf3f1', surface: '#ffffff', textPrimary: '#0f1f1b',
        accent: '#0f766e', gradA: '#0d9488', gradB: '#2563eb',
        blob1: '#2dd4bf', blob2: '#38bdf8', blob3: '#a3e635',
        danger: '#d64545', success: '#2f9e5f', warn: '#b57d15'
      }
    }
  },
  {
    key: 'ember',
    value: {
      dark: {
        bgPage: '#120b0b', surface: '#ffffff', textPrimary: '#f8efe9',
        accent: '#ff9d6b', gradA: '#f97316', gradB: '#e11d48',
        blob1: '#f97316', blob2: '#e11d48', blob3: '#a855f7',
        danger: '#ff7b6b', success: '#57d68b', warn: '#ffc861'
      },
      light: {
        bgPage: '#f7efe9', surface: '#ffffff', textPrimary: '#26140e',
        accent: '#c2410c', gradA: '#ea580c', gradB: '#be123c',
        blob1: '#fb923c', blob2: '#fb7185', blob3: '#c084fc',
        danger: '#d64545', success: '#2f9e5f', warn: '#b57d15'
      }
    }
  },
  {
    key: 'graphite',
    value: {
      dark: {
        bgPage: '#0e0e10', surface: '#ffffff', textPrimary: '#ededf0',
        accent: '#9aa4b2', gradA: '#8b95a5', gradB: '#5b6472',
        blob1: '#64748b', blob2: '#475569', blob3: '#334155',
        danger: '#ff7b6b', success: '#57d68b', warn: '#ffc861'
      },
      light: {
        bgPage: '#f1f2f4', surface: '#ffffff', textPrimary: '#17191d',
        accent: '#475569', gradA: '#64748b', gradB: '#334155',
        blob1: '#94a3b8', blob2: '#cbd5e1', blob3: '#a8b3c2',
        danger: '#d64545', success: '#2f9e5f', warn: '#b57d15'
      }
    }
  }
]

/** What themes.css falls back to; shown when a seed has no override. */
function builtIn(seed: PaletteSeed, theme: ResolvedTheme): string {
  return PRESETS[0]!.value[theme][seed] ?? '#000000'
}

export default function PaletteEditor({
  value,
  onChange
}: {
  value: PaletteValue
  onChange: (next: PaletteValue) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [theme, setTheme] = useState<ResolvedTheme>(currentTheme())

  useEffect(() => onThemeChange(setTheme), [])

  const active = useMemo(() => value[theme] ?? {}, [value, theme])

  const setSeed = (seed: PaletteSeed, color: string): void => {
    const next: PaletteValue = { ...value, [theme]: { ...active, [seed]: color } }
    // Repaint before the round trip so dragging the picker feels live.
    applyPaletteSetting(next)
    onChange(next)
  }

  const usePreset = (preset: PaletteValue): void => {
    applyPaletteSetting(preset)
    onChange(preset)
  }

  const reset = (): void => {
    const next: PaletteValue = { light: {}, dark: {} }
    applyPaletteSetting(next)
    onChange(next)
  }

  return (
    <div className="palette">
      <p className="settings-hint">
        {t(theme === 'dark' ? 'settings.palette.editingDark' : 'settings.palette.editingLight')}
      </p>

      <div className="palette-presets">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className="palette-preset"
            onClick={() => usePreset(p.value)}
            title={t(`settings.palette.preset.${p.key}`)}
          >
            <span
              className="palette-preset-swatch"
              style={{
                background: `linear-gradient(135deg, ${p.value[theme].gradA}, ${p.value[theme].gradB})`
              }}
            />
            {t(`settings.palette.preset.${p.key}`)}
          </button>
        ))}
        <button type="button" className="ghost palette-reset" onClick={reset}>
          {t('settings.palette.reset')}
        </button>
      </div>

      {GROUPS.map((group) => (
        <div key={group.key} className="palette-group">
          <div className="palette-group-name">{t(`settings.palette.group.${group.key}`)}</div>
          <div className="palette-rows">
            {group.seeds.map((seed) => (
              <label key={seed} className="palette-row">
                <input
                  type="color"
                  className="palette-swatch"
                  value={active[seed] ?? builtIn(seed, theme)}
                  onChange={(e) => setSeed(seed, e.target.value)}
                />
                <span className="palette-name">{t(`settings.palette.seed.${seed}`)}</span>
                <span className="palette-hex">{active[seed] ?? builtIn(seed, theme)}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export { PALETTE_SEEDS }
