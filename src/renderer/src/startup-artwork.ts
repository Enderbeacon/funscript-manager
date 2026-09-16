/** Swap only fully loaded images, keeping the default artwork underneath. */
export function startArtworkSlideshow(
  container: HTMLElement,
  sources: string[],
  rotate: boolean,
  intervalMs = 6000,
  presentation: 'cover' | 'framed' = 'cover'
): () => void {
  const remaining = [...new Set(sources)]
  let index = 0
  let pending: HTMLImageElement | null = null
  let stopped = false
  let timer = 0

  const advance = (): void => {
    if (stopped || pending || remaining.length === 0) return
    const source = remaining[index % remaining.length]!
    const image = new Image()
    pending = image
    image.alt = ''
    image.className = 'splash-photo'
    image.onload = () => {
      if (stopped) return
      pending = null
      container.replaceChildren(presentation === 'framed' ? framedPreview(image) : image)
      if (remaining.length < 2) window.clearInterval(timer)
      index = (index + 1) % remaining.length
    }
    image.onerror = () => {
      if (stopped) return
      pending = null
      remaining.splice(remaining.indexOf(source), 1)
      if (remaining.length === 0) window.clearInterval(timer)
      else advance()
    }
    image.src = source
  }

  advance()
  if (rotate && remaining.length > 1) timer = window.setInterval(advance, intervalMs)
  return () => {
    stopped = true
    window.clearInterval(timer)
    if (pending) {
      pending.onload = null
      pending.onerror = null
      pending.src = ''
    }
  }
}

/**
 * Library artwork uses a focused portrait crop over a soft, dimmed copy of
 * the same frame. Low-resolution fallbacks and prepared artwork therefore
 * share one stable composition while the latter supplies the missing detail.
 */
function framedPreview(image: HTMLImageElement): HTMLElement {
  const backdrop = image.cloneNode() as HTMLImageElement
  backdrop.className = 'splash-preview-backdrop'
  backdrop.alt = ''

  image.className = 'splash-preview-image'
  const composition = document.createElement('div')
  composition.className = 'splash-framed-preview'
  composition.append(backdrop, image)
  return composition
}
