// Build the app and pack it into an installer, a portable zip and update
// packages. Run by the release workflow, and usable by hand for a test build.
//
//   node scripts/release.mjs                    stable channel, version from package.json
//   node scripts/release.mjs --channel beta     prerelease channel
//   node scripts/release.mjs --skip-build       pack what is already in release/win-unpacked
//
// Delta packages are made against whatever release packages are already in the
// output directory, so the workflow downloads the previous release into it
// first. Without them the release still works; users just download more.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const channel = flag('channel', 'win')
if (channel !== 'win' && channel !== 'beta') {
  console.error(`unknown channel: ${channel} (expected "win" or "beta")`)
  process.exit(1)
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const outputDir = join(root, 'release', process.env.FSMGR_PACK_OUT || 'velopack')
const packDir = join(root, 'release', 'win-unpacked')
const notes = flag('notes', join(root, 'release-notes', `${version}.md`))

// Through a shell, so `vpk` and `npx` resolve as commands on Windows; that
// makes quoting ours to do, and half these arguments are paths with spaces.
const quote = (arg) => (/[\s"]/.test(arg) ? '"' + arg.replace(/(["\\])/g, '\\$1') + '"' : arg)

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs.map(quote), { cwd: root, stdio: 'inherit', shell: true })
  if (result.status !== 0) {
    console.error(`\nfailed: ${command} ${commandArgs.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

if (!args.includes('--skip-build')) {
  run('npm', ['run', 'build'])
  run('npx', ['electron-builder', '--win', '--dir'])
}

if (!existsSync(join(packDir, 'Funscript Manager.exe'))) {
  console.error(`no build to pack in ${packDir}`)
  process.exit(1)
}

const packArgs = [
  'pack',
  '--packId', 'FunscriptManager',
  '--packTitle', 'Funscript Manager',
  '--packAuthors', 'Funscript Manager',
  '--packVersion', version,
  '--packDir', packDir,
  '--mainExe', 'Funscript Manager.exe',
  '--channel', channel,
  '--outputDir', outputDir
]
if (existsSync(notes)) packArgs.push('--releaseNotes', notes)
else console.warn(`no release notes at ${notes} — packing without them`)

run('vpk', packArgs)
console.log(`\npacked ${version} (${channel}) into ${outputDir}`)
