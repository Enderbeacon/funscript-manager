import type { VrFormat, VrLayout, VrProjection } from './schemas/vr-video'

/**
 * Reading a VR file's format from its file name and picture size.
 *
 * Used only to suggest marking an unmarked file as VR. How a file plays is
 * decided by the mark alone (the sidecar's `vr`).
 */

const FLAT: VrFormat = { projection: 'flat', layout: 'mono' }

/** Everything that separates one word of a file path from the next. */
const SEPARATORS = /[\\/._\-+ ()[\]{}]+/

/** File name words that name a projection. */
const PROJECTION_WORDS: Record<string, VrProjection> = {
  mkx200: 'fisheye200',
  mkx220: 'fisheye220',
  vrca220: 'fisheye220',
  rf52: 'rf52',
  fisheye190: 'fisheye190',
  fisheye200: 'fisheye200',
  fisheye220: 'fisheye220',
  '180x180': 'eq180',
  '360x180': 'eq360',
  vr180: 'eq180',
  vr360: 'eq360'
}

/** File name words that name where the second eye is. */
const LAYOUT_WORDS: Record<string, VrLayout> = {
  sbs: 'sbs',
  hsbs: 'sbs',
  lr: 'sbs',
  '3dh': 'sbs',
  tb: 'tb',
  htb: 'tb',
  ou: 'tb',
  overunder: 'tb',
  '3dv': 'tb',
  mono: 'mono'
}

/** The fisheye projection a bare 190/200/220 names, beside `fisheye`. */
const FISHEYE_BY_ANGLE: Record<string, VrProjection> = {
  '190': 'fisheye190',
  '200': 'fisheye200',
  '220': 'fisheye220'
}

/** Angles that count towards VR only together with `mono`. */
const ANGLE_WORDS = new Set(['180', '360', '190', '200', '220'])

/**
 * Words that mark a file as VR on their own. A bare angle is not one of them:
 * `Scene 180` is an ordinary title.
 */
const VR_WORDS = new Set([
  'vr',
  'vr180',
  'vr360',
  'sbs',
  'hsbs',
  'lr',
  'tb',
  'htb',
  'ou',
  'overunder',
  '3dh',
  '3dv',
  'fisheye',
  'fisheye190',
  'fisheye200',
  'fisheye220',
  'mkx200',
  'mkx220',
  'vrca220',
  'rf52',
  '180x180',
  '360x180'
])

/** Split a name into the words it is made of. */
function words(path: string): string[] {
  return path
    .toLowerCase()
    .split(SEPARATORS)
    .filter((word) => word !== '')
}

/** The last segment of a path. Folder names are not read. */
function fileName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1)
}

/** A scene code whose series letters end in VR: `SIVR-033`, `PPVR-031`. */
const VR_CODE = /^[a-z]{2,5}vr$/

/** At least 3840 wide and 2:1, the shape of a stored half-sphere pair. */
function sphereShaped(width?: number | null, height?: number | null): boolean {
  if (!width || !height || width < 3840) return false
  const ratio = width / height
  return ratio >= 1.95 && ratio <= 2.05
}

/** Marks a flat cut of a VR scene; such a file is always read as flat. */
const FLATTENED = '2d'

/** What a format is read from. Only the file name and the picture size. */
export interface VrGuessInput {
  /** The file's path, or just its name; only the name itself is read. */
  path: string
  /** The stored picture's size, when it is known. */
  width?: number | null
  height?: number | null
}

/** The format the file name and picture size point to; `flat` otherwise. */
export function guessVrFormat(input: VrGuessInput): VrFormat {
  const found = words(fileName(input.path))
  const seen = new Set(found)
  if (seen.has(FLATTENED)) return FLAT
  // `360` with `mono` names a single-eyed panorama, which has no layout word.
  const nameSaysVr =
    found.some((word) => VR_WORDS.has(word)) ||
    found.some((word) => VR_CODE.test(word)) ||
    (found.some((word) => ANGLE_WORDS.has(word)) && seen.has('mono'))
  if (!nameSaysVr && !sphereShaped(input.width, input.height)) return FLAT

  let projection: VrProjection | null = null
  let layout: VrLayout | null = null
  for (const word of found) {
    projection ??= PROJECTION_WORDS[word] ?? null
    layout ??= LAYOUT_WORDS[word] ?? null
  }
  /** The name said which projection, rather than it being worked out below. */
  const named = projection !== null

  if (projection === null) {
    // `fisheye` with a bare angle beside it: `..._FISHEYE_190_...`.
    const angle = found.find((word) => FISHEYE_BY_ANGLE[word] !== undefined)
    if (seen.has('fisheye')) projection = (angle && FISHEYE_BY_ANGLE[angle]) || 'fisheye190'
    else if (seen.has('360') || seen.has('360x180')) projection = 'eq360'
    else projection = 'eq180'
  }

  layout ??= guessLayout(projection, input.width, input.height)
  // Flat 3D is also stored side by side. An eye that is not the shape the
  // projection stores an eye in means the file is flat 3D, not a sphere.
  if (!named && layout !== 'mono' && !eyeFitsProjection(projection, layout, input)) {
    return FLAT
  }
  return { projection, layout }
}

/**
 * Is one eye the shape this projection stores an eye in: square for a
 * half-sphere or a fisheye circle, 2:1 for a whole sphere, within 30%.
 */
function eyeFitsProjection(
  projection: VrProjection,
  layout: VrLayout,
  size: { width?: number | null; height?: number | null }
): boolean {
  if (!size.width || !size.height) return true
  const eye = vrEyeRect(layout)
  const ratio = (size.width * eye.w) / (size.height * eye.h)
  const want = projection === 'eq360' ? 2 : 1
  return ratio >= want * 0.7 && ratio <= want * 1.4
}

/**
 * The eye layout the picture's shape points to. One eye of a half-sphere or
 * fisheye is square: 2:1 is side by side, 1:2 is stacked, square is one eye.
 * One eye of a whole sphere is 2:1, so its three shapes are doubled.
 */
function guessLayout(
  projection: VrProjection,
  width?: number | null,
  height?: number | null
): VrLayout {
  const ratio = width && height ? width / height : null
  if (ratio === null) return projection === 'eq360' ? 'mono' : 'sbs'
  const eye = projection === 'eq360' ? ratio / 2 : ratio
  if (eye >= 1.5) return 'sbs'
  if (eye <= 0.75) return 'tb'
  return 'mono'
}

/** Is there anything to undo, or is this a picture to show as it is? */
export function isVrFormat(format: VrFormat): boolean {
  return format.projection !== 'flat'
}

export const FLAT_VR_FORMAT: VrFormat = FLAT

/** What a VR toggle switched on starts from when nothing suggests otherwise. */
export const DEFAULT_VR_FORMAT: VrFormat = { projection: 'eq180', layout: 'sbs' }

/**
 * How a projection maps an angle away from straight ahead to a distance from
 * the middle of the stored picture. `equidistant` is linear in the angle;
 * `equisolid` follows the lens the RF52 files are shot with.
 */
export type VrProjectionShape =
  /** Longitude across, latitude down, over `fovDeg` of longitude. */
  | { kind: 'equirect'; fovDeg: number }
  | { kind: 'fisheye'; fovDeg: number; mapping: 'equidistant' | 'equisolid' }

/** The shape to undo, or null for a picture that needs no undoing. */
export function vrProjectionShape(projection: VrProjection): VrProjectionShape | null {
  switch (projection) {
    case 'flat':
      return null
    case 'eq180':
      return { kind: 'equirect', fovDeg: 180 }
    case 'eq360':
      return { kind: 'equirect', fovDeg: 360 }
    case 'fisheye190':
      return { kind: 'fisheye', fovDeg: 190, mapping: 'equidistant' }
    case 'fisheye200':
      return { kind: 'fisheye', fovDeg: 200, mapping: 'equidistant' }
    case 'fisheye220':
      return { kind: 'fisheye', fovDeg: 220, mapping: 'equidistant' }
    case 'rf52':
      return { kind: 'fisheye', fovDeg: 190, mapping: 'equisolid' }
  }
}

/**
 * Which part of the picture one eye occupies, as a fraction: where it starts
 * and how big it is. The first eye is the left one, and the top one.
 */
export function vrEyeRect(layout: VrLayout): { x: number; y: number; w: number; h: number } {
  if (layout === 'sbs') return { x: 0, y: 0, w: 0.5, h: 1 }
  if (layout === 'tb') return { x: 0, y: 0, w: 1, h: 0.5 }
  return { x: 0, y: 0, w: 1, h: 1 }
}
