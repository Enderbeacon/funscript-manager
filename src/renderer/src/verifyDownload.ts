import type { TFunction } from 'i18next'
import { ipcInvoke } from './ipc'

/**
 * Open the check a failed download is stuck behind. The window shows one line
 * saying what to do there, which the main process cannot word itself; both
 * kinds are sent and it picks the one that fits the site.
 */
export function verifyDownload(id: string, t: TFunction): void {
  void ipcInvoke('download:verify', {
    id,
    hints: { access: t('downloads.verifyHint.access'), file: t('downloads.verifyHint.file') }
  }).catch(() => {})
}
