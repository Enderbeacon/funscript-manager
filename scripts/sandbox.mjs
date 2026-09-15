/**
 * Start the app as a first run, beside the copy in daily use.
 *
 * Settings, libraries, downloads and the tour's progress all live in the user
 * data directory, so pointing that at an empty folder is a fresh install as far
 * as the app can tell — the welcome card, the empty library page, every tutorial
 * section unseen. The real data in %APPDATA% is not read or touched, and because
 * the single-instance lock belongs to the data directory, this window opens even
 * while the normal one is running.
 *
 *   npm run sandbox               build, empty the sandbox, start
 *   npm run sandbox -- --keep     start where the last sandbox run left off
 *   npm run sandbox -- --no-build start the last build as it is
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const keep = args.has('--keep')
const build = !args.has('--no-build')
const userData = join(tmpdir(), 'funscript-manager-sandbox')

if (build) {
  const result = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!keep) rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })
console.log(`[sandbox] user data: ${userData}${keep ? ' (kept)' : ' (empty)'}`)

const env = { ...process.env, FSMGR_USER_DATA: userData }
// Set in some shells that launch Node tools; it would start Electron as plain Node.
delete env.ELECTRON_RUN_AS_NODE

const electron = createRequire(join(root, 'package.json'))('electron')
const child = spawn(electron, ['.'], { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
