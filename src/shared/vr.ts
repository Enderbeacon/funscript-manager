/**
 * The VR panel's page size, in CSS pixels. The headset shows it on a panel of
 * this aspect; the development preview window opens at exactly this size so
 * what is laid out there is what the headset gets.
 */
export const VR_PANEL_WIDTH = 1280
export const VR_PANEL_HEIGHT = 800

/**
 * The panel's own placement buttons. `front` always means in the world, in
 * front of the viewer — pressed while the panel is on the wrist, it takes it
 * off.
 */
export const VR_PANEL_ACTIONS = ['hide', 'wrist', 'front'] as const
export type VrPanelAction = (typeof VR_PANEL_ACTIONS)[number]
