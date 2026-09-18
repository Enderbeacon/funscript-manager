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
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
// The app's own ordering, so a release and the app never disagree about which
// version is newer. Run through `npm run release`, which strips the types.
import { compareVersions } from '../src/shared/semver.ts'

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
const packId = 'FunscriptManager'
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
  // The SteamVR helper is not committed; every release compiles it fresh.
  run('node', ['scripts/build-vr-overlay.mjs'])
  run('npx', ['electron-builder', '--win', '--dir'])
}

if (!existsSync(join(packDir, 'Funscript Manager.exe'))) {
  console.error(`no build to pack in ${packDir}`)
  process.exit(1)
}

dropPackagesNotOlderThan(version)

/**
 * Packages in the output directory are there to build deltas against, and the
 * tool refuses to pack a version that is not the newest among them. Releasing a
 * fix on an older line downloads a newer release as "previous", so anything not
 * older than what is being packed is put out of the way first.
 */
function dropPackagesNotOlderThan(target) {
  if (!existsSync(outputDir)) return
  for (const name of readdirSync(outputDir)) {
    const found = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(?:full|delta)\.nupkg$/.exec(name)
    if (!found || compareVersions(found[1], target) < 0) continue
    console.log(`ignoring ${name}: not older than ${target}`)
    rmSync(join(outputDir, name))
  }
}

const packArgs = [
  'pack',
  '--packId', packId,
  '--packTitle', 'Funscript Manager',
  '--packAuthors', 'Funscript Manager',
  '--packVersion', version,
  '--packDir', packDir,
  '--mainExe', 'Funscript Manager.exe',
  '--icon', join(root, 'build', 'icon.ico'),
  '--channel', channel,
  '--outputDir', outputDir
]
if (existsSync(notes)) packArgs.push('--releaseNotes', notes)
else console.warn(`no release notes at ${notes} — packing without them`)

run('vpk', packArgs)
versionPortableArtifact()
console.log(`\npacked ${version} (${channel}) into ${outputDir}`)

/**
 * Explorer caches executable icons by path. Velopack normally gives every
 * portable release the same zip name, so "Extract to <archive name>" reuses
 * the path from an older release and can leave its cached Electron icon in
 * place. A versioned archive gives every release a fresh extraction path.
 *
 * The deployment command uploads only the files named in assets.<channel>.json,
 * so keep that manifest in step with the renamed archive.
 */
function versionPortableArtifact() {
  const generatedName = `${packId}-${channel}-Portable.zip`
  const versionedName = `${packId}-${version}-${channel}-Portable.zip`
  const generatedPath = join(outputDir, generatedName)
  const versionedPath = join(outputDir, versionedName)
  const assetsPath = join(outputDir, `assets.${channel}.json`)

  if (!existsSync(generatedPath) || !existsSync(assetsPath)) {
    console.error('Velopack did not produce the expected portable archive and asset manifest')
    process.exit(1)
  }

  const assets = JSON.parse(readFileSync(assetsPath, 'utf8'))
  const portable = Array.isArray(assets)
    ? assets.find((asset) => asset?.Type === 'Portable' && asset.RelativeFileName === generatedName)
    : undefined
  if (!portable) {
    console.error(`${assetsPath} does not list ${generatedName}`)
    process.exit(1)
  }

  rmSync(versionedPath, { force: true })
  renameSync(generatedPath, versionedPath)
  portable.RelativeFileName = versionedName
  writeFileSync(assetsPath, JSON.stringify(assets))
  console.log(`named portable archive ${versionedName}`)
}
