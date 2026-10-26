import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const outDir = await mkdtemp(join(tmpdir(), 'fsmgr-script-match-build-'))
const settings = resolve('src/shared/schemas/app-config.ts').replaceAll('\\', '/')
const sqliteModule = pathToFileURL(require.resolve('better-sqlite3')).href
const mocks = new Map([
  ['electron', `import { unlink } from 'node:fs/promises'; export const shell = { trashItem: unlink }`],
  ['chokidar', `export const watched = []; export default { watch(paths, options) {
    const handlers = {}; watched.push({ paths, options, handlers }); return { on(event, fn) { handlers[event] = fn; return this }, async close() {} }
  } }`],
  ['node:fs/promises', `export * from 'node:fs/promises'; import * as fs from 'node:fs/promises';
    export const ioFaults = new Map(); export const ioCalls = []; export const ioGates = new Map();
    function check(operation, path) { const key = String(path); ioCalls.push({ operation, path: key });
      const fault = ioFaults.get(operation + ':' + key); if (fault) throw Object.assign(new Error('Injected ' + fault), { code: fault }); }
    export async function readdir(path, ...args) { check('readdir', path); return fs.readdir(path, ...args) }
    export async function stat(path, ...args) { check('stat', path); return fs.stat(path, ...args) }
    export async function opendir(path, ...args) { check('opendir', path); await ioGates.get('opendir:' + String(path))?.(); return fs.opendir(path, ...args) }
    export async function readFile(path, ...args) { check('readFile', path); return fs.readFile(path, ...args) }
  `],
  ['better-sqlite3', `import Database from ${JSON.stringify(sqliteModule)};
    export const sqliteFaults = new Map(); export const pragmas = [];
    export default class extends Database {
      constructor(path, options) { const code = sqliteFaults.get(String(path));
        if (code) { sqliteFaults.delete(String(path)); throw Object.assign(new Error('Injected ' + code), { code }) }
        super(path, options);
      }
      pragma(sql, options) { pragmas.push(sql); return super.pragma(sql, options) }
    }
  `],
  ['src/main/services/config/config-service', `import { SettingsSchema } from ${JSON.stringify(settings)};
    export const settings = SettingsSchema.parse({}); export const getSettings = async () => settings;
    export const libraries = []; export const listLibraries = async () => libraries;`],
  ['src/main/services/downloaders/queue', `export let busy = false; export function setBusy(value) { busy = value }
    export const isBusyFor = () => busy; export const awaitingPairKeys = () => new Set();`],
  ['src/main/services/heatmap/heatmap-service', `export const disposeHeatmapPool = async () => {};
    export const getHeatmapDataUrl = async () => null;`],
  ['src/main/services/thumbnails/thumbnail-service', `export const getThumbnailDataUrl = async () => null;`],
  ['src/main/services/taxonomy/taxonomy-service', `export const normaliseNames = async (_, names) => [...new Set(names)];
    export const canonicalNames = normaliseNames;`],
  ['src/main/services/library/probe', `export const probeCalls = []; export const probeMedia = async (path) => {
    probeCalls.push(path); return path.endsWith('Unprobeable.mp4') ? null : { durationMs: 1000 };
  };`],
  ['src/main/services/library/fingerprint', `import { readFile } from 'node:fs/promises'; import { createHash } from 'node:crypto';
    export const disposeFingerprintPool = async () => {};
    export async function computeFingerprint(path) { const data = await readFile(path);
      return { size: data.length, blake3Head: createHash('sha256').update(data).digest('hex') } }`]
])
const byPath = new Map([...mocks].filter(([name]) => name.startsWith('src/'))
  .map(([name, code]) => [resolve(name).replaceAll('\\', '/').toLowerCase(), code]))
try {
  await build({
    configFile: false, logLevel: 'silent', ssr: { noExternal: true },
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [{
      name: 'script-matching-check-boundaries',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source.startsWith('file:')) return { id: source, external: true }
        if (importer?.startsWith('\0') && source === 'node:fs/promises') return { id: source, external: true }
        if (mocks.has(source)) return `\0script-match-check:${source}`
        if (!importer || importer.startsWith('\0')) return
        const path = (isAbsolute(source) ? source : source.startsWith('.')
          ? resolve(dirname(importer), source) : '').replaceAll('\\', '/').replace(/\.ts$/, '').toLowerCase()
        if (byPath.has(path)) return `\0script-match-check:${path}`
      },
      load(id) {
        if (!id.startsWith('\0script-match-check:')) return
        const key = id.slice('\0script-match-check:'.length)
        return mocks.get(key) ?? byPath.get(key)
      }
    }],
    build: { ssr: resolve(process.argv[2] ?? 'scripts/script-matching-check.ts'), outDir, emptyOutDir: false,
      rollupOptions: { output: { entryFileNames: 'check.mjs' } } }
  })
  await import(pathToFileURL(join(outDir, 'check.mjs')).href)
} finally {
  const rel = relative(tmpdir(), outDir)
  if (rel.startsWith('fsmgr-script-match-build-') && !isAbsolute(rel)) {
    await rm(outDir, { recursive: true, force: true })
  }
}
