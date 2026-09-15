import { useSurface } from '../surfaces'

/**
 * The right-hand layer stack.
 *
 * This replaces the old arrangement, where the detail panel and the batch panel
 * were the same piece of screen and whichever the user reached for evicted the
 * other. That was fine while there were two of them and one was always a dead
 * end; it stopped being fine once a playlist could be open, because opening a
 * video to look at it threw away the list you were halfway through ordering.
 *
 * So they stack instead. Each layer is a floating rounded panel over the grid —
 * the grid keeps its full width, which is what makes dragging a card into a
 * playlist a short movement rather than a trip across the window. Deeper layers
 * are inset a little further on every side, so the one underneath shows around
 * the edges and the stacking is something you can see rather than infer.
 *
 * The inset is fixed per layer; which one is *in front* is not. That belongs to
 * `surfaces`, and follows what the user touched last — including the playback
 * drawer, which is the app's rather than this page's. Dismissing (Escape, or a
 * click on empty page) closes the front one, never the whole pile: closing the
 * lot on a single click is the version that loses work.
 */

export interface StackLayer {
  id: string
  node: React.ReactNode
  /** How this layer goes away when it is the one in front. */
  onClose: () => void
}

/** How far each successive layer pulls in from the one below, in pixels. */
const INSET_STEP = 12

export default function LayerStack({
  layers
}: {
  /** Bottom to top. Falsy entries are simply not open. */
  layers: (StackLayer | false | null | undefined)[]
}): React.JSX.Element | null {
  const open = layers.filter((l): l is StackLayer => Boolean(l))
  if (open.length === 0) return null

  return (
    <div className="layer-stack">
      {open.map((layer, depth) => (
        <Layer key={layer.id} layer={layer} depth={depth} />
      ))}
    </div>
  )
}

function Layer({ layer, depth }: { layer: StackLayer; depth: number }): React.JSX.Element {
  const { z, front, raise } = useSurface(layer.id, layer.onClose)
  return (
    <aside
      className={`layer${front ? '' : ' behind'}`}
      // Pointer-down rather than click: a drag that starts in a panel behind
      // should bring it forward as it begins, not once it is over.
      onPointerDown={raise}
      style={{
        zIndex: z,
        top: INSET_STEP * depth,
        bottom: INSET_STEP * depth,
        right: INSET_STEP * depth
      }}
    >
      {layer.node}
    </aside>
  )
}

/**
 * A click on the page behind the stack pops one layer — but only when it lands
 * on nothing in particular.
 *
 * Clicking a card opens that card, clicking a tag picks it; those are the
 * gestures the page is for, and treating them as "dismiss" would make the stack
 * flicker every time someone used the grid. So the rule is the familiar one:
 * empty space dismisses, anything you can act on does not.
 */
export function dismissesLayer(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('.layer-stack, .playback-drawer')) return false
  return !target.closest('button, a, input, textarea, select, [role="button"], .media-card, .chip-menu')
}
