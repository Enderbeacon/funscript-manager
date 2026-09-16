import type { StartupStatus } from '@shared/schemas/startup'
import { ipcInvoke, ipcOn } from './ipc'
import { splashLanguage, splashText } from './i18n/splash'
import './styles/themes.css'
import './styles/splash.css'

/**
 * The startup card: what the user looks at until the main window has something
 * to show. Plain DOM, no framework — everything it needs is a line of text and
 * a bar, and the point of the card is to be up before the app's own bundle is.
 *
 * Theme, language and version arrive in the URL so the first paint needs no
 * round trip; everything after that comes as startup status.
 */

const query = new URLSearchParams(window.location.search)
const lang = splashLanguage(query.get('lang') ?? 'system')
document.documentElement.lang = lang
document.documentElement.dataset['theme'] = query.get('theme') === 'dark' ? 'dark' : 'light'

const root = document.getElementById('splash')!
root.className = 'splash'
root.innerHTML = `
  <button class="splash-quit" type="button" id="quit">✕</button>
  <div class="splash-name">Funscript Manager</div>
  <div class="splash-version">${query.get('version') ?? ''}</div>
  <div class="splash-foot">
    <span class="splash-step" id="step"></span>
    <span class="splash-count" id="count"></span>
  </div>
  <div class="splash-bar"><span id="bar"></span></div>
`

const stepEl = document.getElementById('step')!
const countEl = document.getElementById('count')!
const barEl = document.getElementById('bar')!

const quit = document.getElementById('quit') as HTMLButtonElement
quit.title = splashText(lang, 'quit')
quit.setAttribute('aria-label', quit.title)
quit.addEventListener('click', () => {
  void ipcInvoke('app:startupCancel').catch(() => {})
})

function render(status: StartupStatus): void {
  const vars: Record<string, string> = {
    name: status.library ?? '',
    version: status.version ?? ''
  }
  stepEl.textContent = splashText(lang, status.step, vars)
  countEl.textContent = status.total > 0 ? `${status.processed}/${status.total}` : ''
  barEl.style.width = `${status.progress}%`
}

ipcOn('event:startup', render)
// The sequence runs whether or not this window has finished loading, so the
// card asks where it got to rather than waiting for the next step.
void ipcInvoke('app:startupStatus').then(render).catch(() => {})
