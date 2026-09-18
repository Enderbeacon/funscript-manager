import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, type NativeImage, type WebContents } from 'electron'
import type { Settings } from '@shared/schemas/app-config'
import {
  VR_PANEL_HEIGHT,
  VR_PANEL_METRES,
  VR_PANEL_WIDTH,
  VR_SCRIPT_PLAYER_HEIGHT,
  VR_SCRIPT_PLAYER_METRES,
  VR_SCRIPT_PLAYER_WIDTH,
  VR_WRIST_METRES,
  type VrPanelAction
} from '@shared/vr'
import { getSettings } from '../config/config-service'
import { onPanelRequests } from './panel'
import { loadVrPage, type VrPage } from './page'

/**
 * The VR panels inside SteamVR.
 *
 * A native helper owns the SteamVR side; this module renders each panel's page
 * off screen, pipes its pixels to the helper, and turns what the controllers
 * do on a panel back into mouse and keyboard input for its page.
 *
 * The helper starts with the app and waits for SteamVR on its own, so the main
 * panel appears whenever SteamVR is running. The script player's panel opens
 * from a button on the main one. A page only exists while its panel is open
 * and SteamVR runs: nobody without a headset pays for rendering it.
 *
 * Helper protocol — stdin: u32 type (panel number in the high 16 bits), u32
 * length, payload; stdout: one JSON event per line, `p` naming the panel;
 * stderr: log lines.
 */

const MSG = {
  frame: 1, // u32 fullW, fullH, x, y, w, h; then BGRA pixels
  show: 2,
  hide: 3,
  mode: 4, // u32: 0 = in the world, 1 = on the left wrist
  recenter: 5,
  keyboard: 6, // u32 open; then UTF-8 text already in the field
  size: 9, // float world width, float wrist width, in metres
  button: 10, // u32 w, h; then BGRA pixels: the wrist button
  alpha: 11 // float: how opaque the whole panel is
} as const

interface HelperEvent {
  t: string
  p?: number
  up?: boolean
  x?: number
  y?: number
  button?: number
  dx?: number
  dy?: number
  s?: string
  done?: boolean
}

/** The helper's own left mouse button; the grip arrives as the middle one. */
const LASER_TRIGGER = 1
const BUTTON_SIZE = 256
/** A helper that dies this soon after starting counts as failing to start. */
const QUICK_EXIT_MS = 30_000
const MAX_QUICK_EXITS = 3
/** Two trigger presses this close in time and place are a double click. */
const DOUBLE_CLICK_MS = 450
const DOUBLE_CLICK_PX = 12

interface Panel {
  readonly index: number
  readonly page: VrPage
  readonly width: number
  /** The main panel's is the viewer's to choose; the others are fixed. */
  height: number
  /** Its width in the world. */
  readonly metres: number
  /** Bitmap pixels per CSS pixel the page is drawn at. */
  readonly density: number
  window: BrowserWindow | null
  /** Shown once its first picture has gone to the helper, not before. */
  showOnPaint: boolean
  /** Resized: the next paint goes whole, or the helper's larger copy is black where it was not painted. */
  paintWhole: boolean
  latest: NativeImage | null
  /** A paint skipped while the pipe was full; the latest goes whole on drain. */
  missed: boolean
  /** Bitmap pixels per page pixel, as the page actually paints. */
  scale: number
  pointer: { x: number; y: number }
  triggerDown: boolean
  lastClick: { at: number; x: number; y: number; count: number }
}

function makePanel(
  index: number,
  page: VrPage,
  size: { width: number; height: number; metres: number },
  density: number
): Panel {
  return {
    index,
    page,
    ...size,
    density,
    window: null,
    showOnPaint: false,
    paintWhole: false,
    latest: null,
    missed: false,
    scale: density,
    pointer: { x: 0, y: 0 },
    triggerDown: false,
    lastClick: { at: 0, x: 0, y: 0, count: 0 }
  }
}

const mainPanel = makePanel(
  0,
  'panel',
  { width: VR_PANEL_WIDTH, height: VR_PANEL_HEIGHT, metres: VR_PANEL_METRES },
  1
)
const scriptPlayerPanel = makePanel(
  1,
  'scriptPlayer',
  { width: VR_SCRIPT_PLAYER_WIDTH, height: VR_SCRIPT_PLAYER_HEIGHT, metres: VR_SCRIPT_PLAYER_METRES },
  2
)
const panels = [mainPanel, scriptPlayerPanel]

/** Sizes and opacity from the settings; read at start, then kept current. */
let look: Settings['vr'] | null = null

let helper: ChildProcessWithoutNullStreams | null = null
let buttonWindow: BrowserWindow | null = null
let steamVrUp = false
let disposed = false
let quickExits = 0
/** More than two whole frames are waiting in the pipe; paints are held back. */
let blocked = false

function helperPath(): string | null {
  const exe = app.isPackaged
    ? join(process.resourcesPath ?? '', 'vr-overlay', 'vr-overlay.exe')
    : join(app.getAppPath(), 'resources', 'vr-overlay', 'vr-overlay.exe')
  return existsSync(exe) ? exe : null
}

/** Starts the helper; the main panel then shows whenever SteamVR runs. */
export function startVrOverlay(): void {
  if (process.platform !== 'win32' || helper || disposed) return
  const exe = helperPath()
  if (!exe) return
  onPanelRequests({ action: onAction, keyboard: onKeyboard })
  void getSettings()
    .then((settings) => {
      if (!look) applyVrSettings(settings.vr)
    })
    .catch(() => {})
  spawnHelper(exe)
}

/** The panels' sizes and opacity changed; open panels take them at once. */
export function applyVrSettings(next: Settings['vr']): void {
  look = next
  setMainHeight(next.main.height)
  for (const panel of panels) {
    if (panel.window) sendLook(panel)
  }
}

/** The width stays; the page grows or shrinks at the bottom, and so does the panel. */
function setMainHeight(height: number): void {
  if (height === mainPanel.height) return
  mainPanel.height = height
  const win = mainPanel.window
  if (!win || win.isDestroyed()) return
  mainPanel.paintWhole = true
  win.setContentSize(mainPanel.width, height)
  win.webContents.invalidate()
}

function sendLook(panel: Panel): void {
  if (!look) return
  if (panel === mainPanel) {
    send(panel, MSG.size, f32(panel.metres * look.main.size, VR_WRIST_METRES * look.main.wristSize))
    send(panel, MSG.alpha, f32(look.main.opacity))
  } else {
    // A wrist width of 0 leaves the helper's own; this panel never goes there.
    send(panel, MSG.size, f32(panel.metres * look.scriptPlayer.size, 0))
    send(panel, MSG.alpha, f32(look.scriptPlayer.opacity))
  }
}

export function disposeVrOverlay(): void {
  disposed = true
  onPanelRequests(null)
  for (const panel of panels) closeWindow(panel)
  buttonWindow?.destroy()
  buttonWindow = null
  const proc = helper
  helper = null
  if (!proc) return
  // Closing stdin is the helper's cue to take the panels down and exit.
  proc.stdin.end()
  const kill = setTimeout(() => proc.kill(), 2000)
  proc.once('exit', () => clearTimeout(kill))
}

/** The off-screen windows behind the panels, which no one can see or close. */
export function isVrOverlayWindow(win: BrowserWindow): boolean {
  return win === buttonWindow || panels.some((panel) => panel.window === win)
}

function send(panel: Panel | null, type: number, payload: Buffer = Buffer.alloc(0)): void {
  if (!helper || !helper.stdin.writable) return
  const head = Buffer.alloc(8)
  head.writeUInt32LE((((panel?.index ?? 0) << 16) | type) >>> 0, 0)
  head.writeUInt32LE(payload.length, 4)
  helper.stdin.write(Buffer.concat([head, payload]))
}

function u32(...values: number[]): Buffer {
  const b = Buffer.alloc(4 * values.length)
  values.forEach((v, i) => b.writeUInt32LE(v, 4 * i))
  return b
}

function f32(...values: number[]): Buffer {
  const b = Buffer.alloc(4 * values.length)
  values.forEach((v, i) => b.writeFloatLE(v, 4 * i))
  return b
}

function panelFor(sender: WebContents): Panel | undefined {
  return panels.find((panel) => panel.window?.webContents === sender)
}

function onAction(action: VrPanelAction, sender: WebContents): void {
  const panel = panelFor(sender)
  if (!panel) return
  switch (action) {
    case 'hide':
      if (panel === mainPanel) send(panel, MSG.hide)
      else closePanel(panel)
      break
    case 'wrist':
      send(panel, MSG.mode, u32(1))
      break
    case 'front':
      send(panel, MSG.recenter)
      break
    case 'scriptPlayer':
      // Already open: back beside the main panel, where it can be found.
      if (scriptPlayerPanel.window) send(scriptPlayerPanel, MSG.recenter)
      else openPanel(scriptPlayerPanel)
      break
  }
}

function onKeyboard(open: boolean, text: string, sender: WebContents): void {
  const panel = panelFor(sender)
  if (panel) send(panel, MSG.keyboard, Buffer.concat([u32(open ? 1 : 0), Buffer.from(text, 'utf8')]))
}

function spawnHelper(exe: string): void {
  const startedAt = Date.now()
  const proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  helper = proc
  blocked = false

  proc.on('error', (e) => console.error('[vr] helper failed to start:', e))
  proc.stdin.on('error', () => {
    /* the helper went away; its exit handler decides what next */
  })
  proc.stdin.on('drain', () => {
    if (!blocked) return
    blocked = false
    for (const panel of panels) {
      if (panel.missed && panel.latest) {
        panel.missed = false
        sendFrame(panel, panel.latest, null)
      }
    }
  })

  forEachLine(proc.stdout, (line) => {
    try {
      onHelperEvent(JSON.parse(line) as HelperEvent)
    } catch (e) {
      console.error('[vr] unreadable helper event:', line, e)
    }
  })
  forEachLine(proc.stderr, (line) => {
    // The hand-facing reading repeats every second while SteamVR runs.
    if (!line.startsWith('right hand towards the eyes')) console.log('[vr-overlay]', line)
  })

  proc.on('exit', (code) => {
    if (helper !== proc) return
    helper = null
    steamVrUp = false
    for (const panel of panels) closeWindow(panel)
    if (disposed) return
    quickExits = Date.now() - startedAt < QUICK_EXIT_MS ? quickExits + 1 : 0
    if (quickExits >= MAX_QUICK_EXITS) {
      console.error(`[vr] helper keeps exiting (code ${code}); VR panel disabled until restart`)
      return
    }
    console.error(`[vr] helper exited (code ${code}); restarting`)
    setTimeout(() => {
      if (!disposed && !helper) spawnHelper(exe)
    }, 3000)
  })

  renderWristButton()
}

function forEachLine(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let pending = ''
  stream.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim()
      pending = pending.slice(nl + 1)
      if (line) onLine(line)
    }
  })
}

function onHelperEvent(ev: HelperEvent): void {
  if (ev.t === 'steamvr') {
    steamVrUp = Boolean(ev.up)
    if (steamVrUp) {
      openPanel(mainPanel)
    } else {
      for (const panel of panels) closeWindow(panel)
    }
    return
  }
  const panel = panels[ev.p ?? 0]
  const wc = panel?.window?.webContents
  if (!panel || !wc) return
  switch (ev.t) {
    case 'move':
    case 'down':
    case 'up':
      onPointer(panel, wc, ev)
      return
    case 'scroll':
      wc.sendInputEvent({
        type: 'mouseWheel',
        ...panel.pointer,
        deltaX: (ev.dx ?? 0) * 120,
        deltaY: (ev.dy ?? 0) * 120,
        canScroll: true
      })
      return
    case 'leave':
      if (panel.triggerDown) {
        panel.triggerDown = false
        wc.sendInputEvent({ type: 'mouseUp', ...panel.pointer, button: 'left', clickCount: 1 })
      }
      wc.sendInputEvent({ type: 'mouseLeave', ...panel.pointer })
      return
    case 'key':
      typeInto(wc, ev.s ?? '')
      return
    case 'keyboard':
      // Done or dismissed, the field is finished with.
      void wc.executeJavaScript('document.activeElement?.blur?.()').catch(() => {})
      return
  }
}

function onPointer(panel: Panel, wc: WebContents, ev: HelperEvent): void {
  panel.pointer = { x: Math.round((ev.x ?? 0) / panel.scale), y: Math.round((ev.y ?? 0) / panel.scale) }
  const { x, y } = panel.pointer
  if (ev.t === 'move') {
    // Held down, the move is a drag: sliders and curve points follow it.
    wc.sendInputEvent({ type: 'mouseMove', x, y, ...(panel.triggerDown ? { modifiers: ['leftbuttondown'] } : {}) })
    return
  }
  if (ev.button !== LASER_TRIGGER) return
  if (ev.t === 'down') {
    // The page counts clicks from what it is told, and every synthetic press
    // says one; double clicks are worked out here.
    const now = Date.now()
    const last = panel.lastClick
    const near = Math.hypot(x - last.x, y - last.y) <= DOUBLE_CLICK_PX
    const count = now - last.at <= DOUBLE_CLICK_MS && near ? last.count + 1 : 1
    panel.lastClick = { at: now, x, y, count }
    panel.triggerDown = true
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: count })
  } else {
    panel.triggerDown = false
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: panel.lastClick.count })
  }
}

/** What the headset keyboard typed, into the page's focused field. */
function typeInto(wc: WebContents, text: string): void {
  for (const ch of text) {
    if (ch === '\b') {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    } else if (ch === '\n' || ch === '\r') {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    } else {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
    }
  }
}

function openPanel(panel: Panel): void {
  if (!helper || !steamVrUp) return
  if (panel.window && !panel.window.isDestroyed()) {
    if (panel.latest) sendFrame(panel, panel.latest, null)
    send(panel, MSG.show)
    return
  }
  sendLook(panel)
  const win = new BrowserWindow({
    width: panel.width,
    height: panel.height,
    show: false,
    frame: false,
    // The page's background can be made see-through, down to the video.
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: { deviceScaleFactor: panel.density },
      preload: join(__dirname, '../preload/index.js')
    }
  })
  panel.window = win
  panel.showOnPaint = true
  panel.latest = null
  panel.missed = false
  panel.triggerDown = false
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.setFrameRate(60)
  win.webContents.on('paint', (_e, dirty, image) => {
    if (panel.window !== win) return
    panel.scale = image.getSize().width / panel.width
    panel.latest = image
    if (panel.showOnPaint) {
      panel.showOnPaint = false
      panel.paintWhole = false
      sendFrame(panel, image, null)
      send(panel, MSG.show)
      return
    }
    if (panel.paintWhole && image.getSize().height === Math.round(panel.height * panel.density)) {
      panel.paintWhole = false
      if (blocked) panel.missed = true
      else sendFrame(panel, image, null)
      return
    }
    if (blocked) panel.missed = true
    else sendFrame(panel, image, dirty)
  })
  win.once('closed', () => {
    if (panel.window === win) panel.window = null
  })
  loadVrPage(win, panel.page)
}

/** Takes a panel down and drops its page. */
function closePanel(panel: Panel): void {
  send(panel, MSG.keyboard, u32(0))
  send(panel, MSG.hide)
  closeWindow(panel)
}

function closeWindow(panel: Panel): void {
  const win = panel.window
  panel.window = null
  panel.latest = null
  panel.missed = false
  panel.triggerDown = false
  if (win && !win.isDestroyed()) win.destroy()
}

/**
 * Sends `rect` of the picture, or all of it.
 *
 * The paint event's rectangle is in the bitmap's own pixels, not the page's:
 * on a panel drawn at twice the density, scaling it again sent a region
 * elsewhere, and a change only reached the headset when some later, larger
 * repaint happened to cover it.
 */
function sendFrame(panel: Panel, image: NativeImage, rect: Electron.Rectangle | null): void {
  if (!helper) return
  const size = image.getSize()
  const r = rect
    ? {
        x: Math.max(0, Math.floor(rect.x)),
        y: Math.max(0, Math.floor(rect.y)),
        width: Math.min(size.width, Math.ceil(rect.x + rect.width)) - Math.max(0, Math.floor(rect.x)),
        height: Math.min(size.height, Math.ceil(rect.y + rect.height)) - Math.max(0, Math.floor(rect.y))
      }
    : { x: 0, y: 0, width: size.width, height: size.height }
  if (r.width <= 0 || r.height <= 0) return
  const pixels = (rect ? image.crop(r) : image).toBitmap()
  send(panel, MSG.frame, Buffer.concat([u32(size.width, size.height, r.x, r.y, r.width, r.height), pixels]))
  if (helper.stdin.writableLength > 2 * size.width * size.height * 4) blocked = true
}

/** Draws the right-wrist summon button once and hands it to the helper. */
function renderWristButton(): void {
  buttonWindow?.destroy()
  const win = new BrowserWindow({
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  })
  buttonWindow = win
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">
    <div style="width:${BUTTON_SIZE}px;height:${BUTTON_SIZE}px;border-radius:50%;background:#4f6bd8;display:flex;align-items:center;justify-content:center;box-sizing:border-box;border:10px solid #fff">
      <svg width="130" height="130" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 20V9"/></svg>
    </div></body></html>`
  const done = (): void => {
    if (buttonWindow === win) buttonWindow = null
    if (!win.isDestroyed()) win.destroy()
  }
  let sent = false
  win.webContents.on('paint', (_e, _dirty, image) => {
    const size = image.getSize()
    if (sent || size.width < BUTTON_SIZE) return
    sent = true
    send(null, MSG.button, Buffer.concat([u32(size.width, size.height), image.toBitmap()]))
    setTimeout(done, 100)
  })
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}
