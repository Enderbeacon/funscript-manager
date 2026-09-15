import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import zhCN from './locales/zh-CN.json'
import ja from './locales/ja.json'
import fr from './locales/fr.json'
import de from './locales/de.json'

/**
 * Renderer i18n. The main process never produces user-facing text:
 * it sends error codes (see shared/errors.ts) which are translated here.
 */

export type LanguageSetting = 'system' | 'en' | 'zh-CN' | 'ja' | 'fr' | 'de'

function systemLanguage(): string {
  const lang = navigator.language.toLowerCase()
  if (lang.startsWith('zh')) return 'zh-CN'
  if (lang.startsWith('ja')) return 'ja'
  if (lang.startsWith('fr')) return 'fr'
  if (lang.startsWith('de')) return 'de'
  return 'en'
}

export function resolveLanguage(setting: LanguageSetting): string {
  return setting === 'system' ? systemLanguage() : setting
}

/** Apply the persisted settings.ui.language value. */
export function applyLanguageSetting(setting: LanguageSetting): void {
  const lang = resolveLanguage(setting)
  if (i18n.language !== lang) void i18n.changeLanguage(lang)
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-CN': { translation: zhCN },
    ja: { translation: ja },
    fr: { translation: fr },
    de: { translation: de }
  },
  lng: systemLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }
})

export default i18n
