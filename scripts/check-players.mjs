import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

/**
 * Player checks: the two protocols we cannot see from here (MPC-HC's web
 * interface, HereSphere's sync socket) and the player list on top of them.
 *
 * The list pulls in mpv, which reaches for Electron's `app` at import time, so
 * a stub stands in for it — nothing here creates an mpv player, and starting
 * one would put a window on the user's screen for no reason.
 */

const outDir = await mkdtemp(join(tmpdir(), 'fsmgr-players-'))
const electronStub = join(outDir, 'electron-stub.mjs')
await writeFile(
  electronStub,
  'export const app = { isPackaged: false, getPath: () => process.cwd() }\nexport default { app }\n'
)

const checks = [
  'scripts/players-protocol-check.ts',
  'scripts/players-registry-check.ts',
  'scripts/internal-player-check.ts'
]

try {
  for (const check of checks) {
    const name = `${check.split('/').pop().replace('.ts', '')}.mjs`
    await build({
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      resolve: { alias: { '@shared': resolve('src/shared'), electron: electronStub } },
      build: {
        ssr: resolve(check),
        outDir,
        emptyOutDir: false,
        rollupOptions: { output: { entryFileNames: name } }
      }
    })
    await import(`${pathToFileURL(join(outDir, name)).href}?v=${Date.now()}`)
  }
} finally {
  await rm(outDir, { recursive: true, force: true })
}
