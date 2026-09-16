/**
 * Copy for the startup card, in the five languages the app ships.
 *
 * Kept here rather than in the translation bundle: the card is a window of its
 * own that has to be on screen before anything heavy loads, and loading the
 * bundle would make it wait for exactly what it exists to cover. Nothing else
 * uses these strings, so they are still written in one place.
 */

export type SplashKey =
  | 'starting'
  | 'updated'
  | 'updates'
  | 'library'
  | 'window'
  | 'installing'
  | 'quit'
  | 'artwork'

const COPY: Record<string, Record<SplashKey, string>> = {
  en: {
    starting: 'Starting…',
    updated: 'Updated to {{version}}',
    updates: 'Checking for updates…',
    library: 'Scanning {{name}}…',
    window: 'Preparing the window…',
    installing: 'Installing the update…',
    quit: 'Quit',
    artwork: 'From {{name}}'
  },
  'zh-CN': {
    starting: '正在启动…',
    updated: '已更新到 {{version}}',
    updates: '正在检查更新…',
    library: '正在扫描 {{name}}…',
    window: '正在准备界面…',
    installing: '正在安装更新…',
    quit: '退出',
    artwork: '来自 {{name}}'
  },
  ja: {
    starting: '起動しています…',
    updated: '{{version}} に更新しました',
    updates: '更新を確認しています…',
    library: '{{name}} をスキャンしています…',
    window: '画面を準備しています…',
    installing: '更新をインストールしています…',
    quit: '終了',
    artwork: '{{name}} より'
  },
  fr: {
    starting: 'Démarrage…',
    updated: 'Mis à jour vers {{version}}',
    updates: 'Recherche de mises à jour…',
    library: 'Analyse de {{name}}…',
    window: 'Préparation de la fenêtre…',
    installing: 'Installation de la mise à jour…',
    quit: 'Quitter',
    artwork: 'Tiré de {{name}}'
  },
  de: {
    starting: 'Wird gestartet…',
    updated: 'Auf {{version}} aktualisiert',
    updates: 'Suche nach Updates…',
    library: '{{name}} wird durchsucht…',
    window: 'Fenster wird vorbereitet…',
    installing: 'Update wird installiert…',
    quit: 'Beenden',
    artwork: 'Aus {{name}}'
  }
}

/** The app's language setting, with `system` resolved against the browser's. */
export function splashLanguage(setting: string): string {
  if (setting in COPY && setting !== 'system') return setting
  const lang = navigator.language.toLowerCase()
  if (lang.startsWith('zh')) return 'zh-CN'
  if (lang.startsWith('ja')) return 'ja'
  if (lang.startsWith('fr')) return 'fr'
  if (lang.startsWith('de')) return 'de'
  return 'en'
}

export function splashText(
  lang: string,
  key: SplashKey,
  vars: Record<string, string> = {}
): string {
  const table = COPY[lang] ?? COPY['en']!
  return table[key].replace(/\{\{(\w+)\}\}/g, (whole, name: string) => vars[name] ?? whole)
}
