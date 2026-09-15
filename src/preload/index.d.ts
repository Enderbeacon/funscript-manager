import type { PreloadApi } from './index'

declare global {
  interface Window {
    fsmgr: PreloadApi
  }
}

export {}
