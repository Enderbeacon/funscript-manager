import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

/**
 * Data compatibility: what an older build does to files a newer one wrote.
 *
 * Going back a version is offered in the app, so this is a promise to keep —
 * run it whenever a persisted shape changes.
 */

const outDir = await mkdtemp(join(tmpdir(), 'fsmgr-data-compat-'))

try {
  await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      ssr: resolve('scripts/data-compat-check.ts'),
      outDir,
      emptyOutDir: false,
      rollupOptions: { output: { entryFileNames: 'data-compat-check.mjs' } }
    }
  })
  await import(`${pathToFileURL(join(outDir, 'data-compat-check.mjs')).href}?v=${Date.now()}`)
} finally {
  await rm(outDir, { recursive: true, force: true })
}
