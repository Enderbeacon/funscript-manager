/** Number and date formatting shared by the posts page, the queue and the rail. */

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`
  // A job that never got a byte must read 0, not round up to 1 KB.
  if (bytes === 0) return '0 KB'
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** A cooldown can be hours away; the wall-clock time is what a user can act on. */
export function formatClock(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return ''
  const total = Math.round(seconds)
  if (total >= 3600) return `${Math.floor(total / 3600)}h${Math.floor((total % 3600) / 60)}m`
  if (total >= 60) return `${Math.floor(total / 60)}m${(total % 60).toString().padStart(2, '0')}s`
  return `${total}s`
}

export function formatDate(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString()
}
