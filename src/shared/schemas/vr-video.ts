import { z } from 'zod'

/**
 * How a VR video is stored inside the ordinary rectangular picture a file
 * holds, so that a flat screen can undo it.
 *
 * `projection` is how the sphere was flattened. `eq180` and `eq360` are
 * equirectangular — longitude across, latitude down — over half a sphere and
 * a whole one. The `fisheye*` ones are circular images covering the field of
 * view in their name. `rf52` is the same circular shape from a lens whose
 * angles fall differently across the circle. `flat` is an ordinary video, and
 * is what everything that is not VR stays.
 *
 * `layout` is where the second eye sits: to the right of the first, below it,
 * or nowhere because there is only one.
 */
export const VR_PROJECTIONS = [
  'flat',
  'eq180',
  'eq360',
  'fisheye190',
  'fisheye200',
  'fisheye220',
  'rf52'
] as const
export const VrProjectionSchema = z.enum(VR_PROJECTIONS)
export type VrProjection = z.infer<typeof VrProjectionSchema>

export const VR_LAYOUTS = ['mono', 'sbs', 'tb'] as const
export const VrLayoutSchema = z.enum(VR_LAYOUTS)
export type VrLayout = z.infer<typeof VrLayoutSchema>

export const VrFormatSchema = z.object({
  projection: VrProjectionSchema,
  layout: VrLayoutSchema
})
export type VrFormat = z.infer<typeof VrFormatSchema>
