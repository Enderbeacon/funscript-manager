import type { WebContents } from 'electron'
import type { VrPanelAction } from '@shared/vr'

/**
 * What the VR pages ask of the panels showing them: placement, the script
 * player's panel, and the headset keyboard for a text field.
 *
 * The headset side registers here once it is running. Until then — and in the
 * development preview, which has no headset — the requests go nowhere.
 */

export interface PanelRequests {
  action: (action: VrPanelAction, sender: WebContents) => void
  keyboard: (open: boolean, text: string, sender: WebContents) => void
}

let handler: PanelRequests | null = null

export function onPanelRequests(next: PanelRequests | null): void {
  handler = next
}

export function panelAction(action: VrPanelAction, sender: WebContents): void {
  handler?.action(action, sender)
}

export function panelKeyboard(open: boolean, text: string, sender: WebContents): void {
  handler?.keyboard(open, text, sender)
}
