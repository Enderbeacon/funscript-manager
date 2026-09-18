import type { VrPanelAction } from '@shared/vr'

/**
 * What the VR panel's own buttons ask of the panel: put it away, hang it on
 * the wrist, bring it in front of the viewer.
 *
 * The headset side registers here once it is running. Until then — and in the
 * development preview, which has no headset — the requests go nowhere.
 */

type Handler = (action: VrPanelAction) => void

let handler: Handler | null = null

export function onPanelAction(next: Handler | null): void {
  handler = next
}

export function panelAction(action: VrPanelAction): void {
  handler?.(action)
}
