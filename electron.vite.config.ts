import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { thirdPartyLicensesPlugin } from './scripts/third-party-licenses'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), thirdPartyLicensesPlugin(resolve('.'))],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@script-player': resolve('src/script-player')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        // The startup card is a page of its own: sharing the app's entry would
        // make it wait for the bundle it is there to cover.
        input: {
          index: resolve('src/renderer/index.html'),
          splash: resolve('src/renderer/splash.html')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@script-player': resolve('src/script-player'),
        '@': resolve('src/renderer/src')
      }
    }
  }
})
