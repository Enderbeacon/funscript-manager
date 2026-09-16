import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

/**
 * `THIRD_PARTY_LICENSES.txt`: the license of every npm package that ends up in
 * the packaged app, written next to the main bundle on every build.
 *
 * Main-process dependencies are copied into the app with their own files, but
 * everything the renderer imports is bundled and minified, and that drops
 * every license text on the way. Generating the list from the lockfile keeps
 * it in step with the dependencies without anyone maintaining it by hand.
 *
 * "Ends up in the app" is the lockfile's production tree: entries marked
 * neither `dev` nor `devOptional`, which is exactly what electron-builder
 * copies. Vite is the one exception — its module preload helper is written
 * into the renderer bundle although Vite is a build tool.
 */

interface LockEntry {
  version?: string
  dev?: boolean
  devOptional?: boolean
  license?: string
}

interface PackageJson {
  name?: string
  version?: string
  license?: string | { type?: string }
  author?: string | { name?: string }
  homepage?: string
  repository?: string | { url?: string }
}

/** LICENSE, LICENCE.md, LICENSE-MIT, COPYING, NOTICE (Apache-2.0 requires passing it on)… */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._][\w.-]*)?$/i
const NOT_TEXT = /\.(js|cjs|mjs|ts|json|map)$/i

/** Vite's own section; the rest of its file covers what Vite bundles into itself. */
const VITE_OWN_LICENSE_END = '# Licenses of bundled dependencies'

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

function readPackage(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson
}

function licenseName(pkg: PackageJson): string {
  return typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'UNKNOWN')
}

function sourceUrl(pkg: PackageJson): string | null {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const url = repo?.replace(/^git\+/, '').replace(/\.git$/, '') ?? pkg.homepage
  return url ?? null
}

function licenseText(dir: string, pkg: PackageJson): string {
  const files = readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && !NOT_TEXT.test(name))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
  if (files.length > 0) {
    return files.map((name) => readFileSync(join(dir, name), 'utf8').trim()).join('\n\n')
  }
  // A few MIT packages publish no license file and only name the license. The
  // license itself is standard; the copyright line is the author they list.
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  if (licenseName(pkg) === 'MIT' && author) {
    return `MIT License\n\nCopyright (c) ${author}\n\n${MIT_TEXT}`
  }
  throw new Error(
    `${pkg.name}@${pkg.version}: no license file and no MIT author to write one from — ` +
      'add its license text by hand before shipping it'
  )
}

function section(dir: string, text?: string): string {
  const pkg = readPackage(dir)
  const url = sourceUrl(pkg)
  return [
    '='.repeat(78),
    `${pkg.name} ${pkg.version}`,
    `License: ${licenseName(pkg)}`,
    ...(url ? [url] : []),
    '-'.repeat(78),
    text ?? licenseText(dir, pkg)
  ].join('\n')
}

export function thirdPartyLicenses(root: string): string {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, LockEntry>
  }

  const seen = new Set<string>()
  const dirs: { id: string; dir: string }[] = []
  for (const [path, entry] of Object.entries(lock.packages)) {
    // The empty key is this project itself.
    if (!path || entry.dev || entry.devOptional) continue
    const dir = join(root, path)
    // An optional dependency for another platform is in the lockfile but was
    // never installed, so it is not in the app either.
    if (!existsSync(join(dir, 'package.json'))) continue
    const pkg = readPackage(dir)
    const id = `${pkg.name}@${pkg.version}`
    if (seen.has(id)) continue
    seen.add(id)
    dirs.push({ id, dir })
  }
  dirs.sort((a, b) => a.id.localeCompare(b.id))

  const viteDir = join(root, 'node_modules', 'vite')
  const viteFile = readFileSync(join(viteDir, 'LICENSE.md'), 'utf8')
  const viteEnd = viteFile.indexOf(VITE_OWN_LICENSE_END)
  const vite = section(viteDir, (viteEnd === -1 ? viteFile : viteFile.slice(0, viteEnd)).trim())

  const header = [
    'Third-party software in Funscript Manager',
    '',
    'Electron and Chromium: see LICENSE.electron.txt and LICENSES.chromium.html',
    'in the application folder.'
  ].join('\n')
  const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').trim()
  const packages = [...dirs.map(({ dir }) => section(dir)), vite]
  return `${[header, notices, ...packages].join('\n\n\n')}\n`
}

/**
 * Emits the file beside the main bundle, in `dev` as well as `build`.
 *
 * Worker threads are bundled by builds of their own that inherit this plugin,
 * so only the bundle holding the main entry writes the file.
 */
export function thirdPartyLicensesPlugin(root: string): Plugin {
  return {
    name: 'third-party-licenses',
    generateBundle(_options, bundle) {
      if (!('index.js' in bundle)) return
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_LICENSES.txt',
        source: thirdPartyLicenses(root)
      })
    }
  }
}
