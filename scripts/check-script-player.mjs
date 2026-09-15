import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const outDir = await mkdtemp(join(tmpdir(), 'fsmgr-script-player-'))
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      ssr: resolve('scripts/script-player-protocol-check.ts'),
      outDir,
      emptyOutDir: true,
      rollupOptions: { output: { entryFileNames: 'check.mjs' } }
    }
  })
  await import(`${pathToFileURL(join(outDir, 'check.mjs')).href}?v=${Date.now()}`)
} finally {
  await rm(outDir, { recursive: true, force: true })
}
