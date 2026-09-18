/**
 * The VR panel's page size, in CSS pixels. The width is fixed, four covers
 * across; the height is the viewer's to choose (the panel settings), and a
 * taller panel shows more rows. The development preview window opens at the
 * default height.
 */
export const VR_PANEL_WIDTH = 1280
export const VR_PANEL_HEIGHT = 960
export const VR_PANEL_MIN_HEIGHT = 880
export const VR_PANEL_MAX_HEIGHT = 1920

/** The main panel's width in the world, in metres, and on the left wrist. */
export const VR_PANEL_METRES = 0.9
export const VR_WRIST_METRES = 0.32

/**
 * The script player's panel, in CSS pixels, and its width in the world. The
 * desktop player's layout is made for a mouse; hung half as large again per
 * pixel as the main panel, and drawn at twice the pixel density to stay
 * sharp, its text and buttons come out large enough for a laser.
 */
export const VR_SCRIPT_PLAYER_WIDTH = 560
export const VR_SCRIPT_PLAYER_HEIGHT = 720
export const VR_SCRIPT_PLAYER_METRES = (1.5 * VR_SCRIPT_PLAYER_WIDTH * VR_PANEL_METRES) / VR_PANEL_WIDTH

/**
 * What a VR page's own buttons ask of the panel showing it: put it away, hang
 * it on the wrist, bring it in front of the viewer. `front` always means in
 * the world — pressed while the panel is on the wrist, it takes it off.
 * `scriptPlayer` opens the script player's panel beside the main one, or
 * brings it back there when it is already open. Put away, the script player's
 * panel closes.
 */
export const VR_PANEL_ACTIONS = ['hide', 'wrist', 'front', 'scriptPlayer'] as const
export type VrPanelAction = (typeof VR_PANEL_ACTIONS)[number]
