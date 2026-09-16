import type { StartupStatus } from '@shared/schemas/startup'
import { ipcInvoke, ipcOn } from './ipc'
import { splashLanguage, splashText } from './i18n/splash'
import brandMark from './assets/brand/mark.svg?raw'
import brandWordmark from './assets/brand/wordmark.svg?raw'
import defaultArtwork from './assets/brand/startup-artwork.svg'
import { startArtworkSlideshow } from './startup-artwork'
import './styles/themes.css'
import './styles/splash.css'

/**
 * The startup card: what the user looks at until the main window has something
 * to show. Plain DOM, no framework, so the card can paint its branding and
 * progress before the app's own bundle is ready.
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
  <section class="splash-info">
    <header class="splash-brand">
      <div class="splash-logo" aria-hidden="true">${brandMark}</div>
      <h1 class="splash-name" aria-label="Funscript Manager">
        <span aria-hidden="true">${brandWordmark}</span>
      </h1>
      <div class="splash-version" id="version"></div>
    </header>
    <div class="splash-status">
      <div class="splash-step" id="step" role="status"></div>
      <div class="splash-bar" id="progress" role="progressbar"
        aria-labelledby="step" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <span id="bar"></span>
      </div>
      <div class="splash-count" id="count"></div>
    </div>
  </section>
  <div class="splash-artwork" aria-hidden="true">
    <img class="splash-photo" src="${defaultArtwork}" alt="">
    <div class="splash-photos" id="photos"></div>
  </div>
  <button class="splash-quit" type="button" id="quit">✕</button>
`

document.getElementById('version')!.textContent = query.get('version') ?? ''
const stepEl = document.getElementById('step')!
const countEl = document.getElementById('count')!
const barEl = document.getElementById('bar')!
const progressEl = document.getElementById('progress')!
stepEl.textContent = splashText(lang, 'starting')

let disposed = false
let stopArtwork = (): void => {}
window.addEventListener('pagehide', () => {
  disposed = true
  stopArtwork()
}, { once: true })
// The bundled artwork paints immediately; optional images never delay startup.
void ipcInvoke('app:startupArtwork', { purpose: 'startup' }).then(({ images, rotate, intervalSeconds, presentation }) => {
  if (!disposed) {
    stopArtwork = startArtworkSlideshow(
      document.getElementById('photos')!, images, rotate, intervalSeconds * 1000, presentation
    )
  }
}).catch(() => {})

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
  stepEl.title = stepEl.textContent
  countEl.textContent = status.total > 0 ? `${status.processed}/${status.total}` : ''
  barEl.style.width = `${status.progress}%`
  progressEl.setAttribute('aria-valuenow', String(status.progress))
}

ipcOn('event:startup', render)
// The sequence runs whether or not this window has finished loading, so the
// card asks where it got to rather than waiting for the next step.
void ipcInvoke('app:startupStatus').then(render).catch(() => {})
