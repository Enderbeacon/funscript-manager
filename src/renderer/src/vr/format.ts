/** A running time the way a player shows it: 1:02:05, 12:40. */
export function clockDuration(ms: number | null): string | null {
  if (ms === null || ms <= 0) return null
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = s.toString().padStart(2, '0')
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** What a card is called: its title, else its file name without the extension. */
export function displayTitle(item: { title: string | null; fileName: string }): string {
  return item.title || item.fileName.replace(/\.[^.]+$/, '')
}
