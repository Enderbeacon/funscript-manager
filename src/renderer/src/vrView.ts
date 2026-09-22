import type { VrFormat } from '@shared/schemas/vr-video'
import { vrEyeRect, vrProjectionShape } from '@shared/vr-video'

/**
 * Drawing a VR video on a flat screen.
 *
 * The file holds a sphere squashed into a rectangle — and usually two of
 * them, one per eye. Undoing that is per-pixel work, so it happens on the
 * graphics card: every pixel of the canvas is a direction the viewer is
 * looking in, and the shader works out where that direction landed in the
 * stored picture.
 *
 * The video element is still the one playing, and still the one holding the
 * sound and the clock. It keeps its place in the layout, out of sight behind
 * this canvas, and every frame it produces is copied across as a texture.
 */

/** Which way the shader undoes the picture. Mirrors the projection shapes. */
const MODE = { equirectHalf: 0, equirectFull: 1, fisheyeEven: 2, fisheyeSolid: 3 }

const VERTEX = `#version 300 es
out vec2 vNdc;
void main() {
  // One triangle covering the whole canvas; no buffers needed for three
  // corners that can be worked out from the vertex number.
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vNdc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}
`

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vNdc;
out vec4 fragColor;

uniform sampler2D uTex;
/** Where the viewer is facing: camera space to world. */
uniform mat3 uRot;
uniform float uTanHalfFov;
uniform float uAspect;
uniform int uMode;
/** Half the angle the stored circle covers, for the fisheye modes. */
uniform float uFovHalf;
/** The one eye to read: offset, then size, as fractions of the picture. */
uniform vec4 uEye;

const float PI = 3.141592653589793;

void main() {
  vec3 dir = normalize(uRot * vec3(vNdc.x * uTanHalfFov * uAspect, vNdc.y * uTanHalfFov, -1.0));
  vec2 uv;
  if (uMode == 0 || uMode == 1) {
    float lon = atan(dir.x, -dir.z);
    float lat = asin(clamp(dir.y, -1.0, 1.0));
    // Half a sphere has nothing behind the viewer.
    if (uMode == 0 && abs(lon) > PI * 0.5) {
      fragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    float span = uMode == 0 ? PI : 2.0 * PI;
    uv = vec2(0.5 + lon / span, 0.5 - lat / PI);
  } else {
    float theta = acos(clamp(-dir.z, -1.0, 1.0));
    float r = uMode == 2 ? theta / uFovHalf : sin(theta * 0.5) / sin(uFovHalf * 0.5);
    // Outside the circle the lens never saw anything.
    if (r > 1.0) {
      fragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    float phi = atan(dir.y, dir.x);
    uv = vec2(0.5 + 0.5 * r * cos(phi), 0.5 - 0.5 * r * sin(phi));
  }
  fragColor = texture(uTex, uEye.xy + uv * uEye.zw);
}
`

/** Where the viewer is looking, and how wide. Degrees throughout. */
export interface VrLook {
  yaw: number
  pitch: number
  /** Vertical field of view. Smaller is closer in. */
  fov: number
}

export const DEFAULT_VR_LOOK: VrLook = { yaw: 0, pitch: 0, fov: 90 }

/** How far up or down the viewer may turn, before the picture is all pole. */
export const VR_PITCH_LIMIT = 85
export const VR_FOV_MIN = 40
export const VR_FOV_MAX = 130

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[vr] shader:', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

/** Camera space to world: yaw about the vertical, then pitch. Column major. */
function rotation(yawDeg: number, pitchDeg: number): Float32Array {
  const yaw = (yawDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  return new Float32Array([cy, 0, -sy, sy * sp, cp, cy * sp, sy * cp, -sp, cy * cp])
}

export class VrView {
  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly texture: WebGLTexture
  private readonly uniforms: Record<string, WebGLUniformLocation | null>
  /** The frame size the texture was allocated for; a change reallocates it. */
  private textureSize: { width: number; height: number } | null = null
  private format: VrFormat
  private look: VrLook = DEFAULT_VR_LOOK
  private frameHandle: number | null = null
  private disposed = false
  /** A draw threw; nothing more is drawn and the caller has been told. */
  private failed = false

  /**
   * Throws when WebGL2 is unavailable; the caller then shows the video
   * element as stored.
   */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly video: HTMLVideoElement,
    format: VrFormat,
    /** A draw failed; the caller shows the video element instead. */
    private readonly onFail: () => void
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // The canvas is redrawn every frame anyway, and not preserving it lets
      // the driver hand back whichever buffer is free.
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    })
    if (!gl) throw new Error('no webgl2')
    this.gl = gl
    this.format = format

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
    const program = vs && fs ? gl.createProgram() : null
    if (!vs || !fs || !program) throw new Error('no shader')
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[vr] link:', gl.getProgramInfoLog(program))
      throw new Error('no program')
    }
    this.program = program

    const texture = gl.createTexture()
    if (!texture) throw new Error('no texture')
    this.texture = texture
    gl.bindTexture(gl.TEXTURE_2D, texture)
    // A sphere stretched over a screen samples well outside its own pixels;
    // linear filtering is what keeps the edges of the picture from crawling.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    gl.useProgram(program)
    this.uniforms = Object.fromEntries(
      ['uTex', 'uRot', 'uTanHalfFov', 'uAspect', 'uMode', 'uFovHalf', 'uEye'].map((name) => [
        name,
        gl.getUniformLocation(program, name)
      ])
    )
    gl.uniform1i(this.uniforms.uTex ?? null, 0)
  }

  setFormat(format: VrFormat): void {
    this.format = format
  }

  setLook(look: VrLook): void {
    this.look = look
  }

  /** Match the canvas to the space it has been given, in device pixels. */
  resize(cssWidth: number, cssHeight: number): void {
    const ratio = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(cssWidth * ratio))
    const height = Math.max(1, Math.round(cssHeight * ratio))
    if (this.canvas.width === width && this.canvas.height === height) return
    this.canvas.width = width
    this.canvas.height = height
  }

  /**
   * Copy the frame that is on the video now, and draw the view of it.
   *
   * Safe to call when nothing has changed — a paused video turned with the
   * mouse needs exactly that — and cheap enough to, since the copy is skipped
   * unless the element has a frame to give.
   *
   * Never throws. A frame WebGL refuses (a cross-origin video, a lost
   * context) stops the drawing and calls `onFail`: this is called from React
   * effects, where an exception would take the whole page down.
   */
  draw(): void {
    if (this.disposed || this.failed) return
    try {
      this.render()
    } catch (error) {
      this.failed = true
      this.stopFollowing()
      console.error('[vr] draw:', error)
      this.onFail()
    }
  }

  private render(): void {
    const gl = this.gl
    const { videoWidth: width, videoHeight: height } = this.video
    if (width === 0 || height === 0) return

    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    if (this.textureSize?.width !== width || this.textureSize.height !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, width, height, 0, gl.RGB, gl.UNSIGNED_BYTE, null)
      this.textureSize = { width, height }
    }
    // Into the storage already made: reallocating for every frame of an 8K
    // file is the difference between smooth and not.
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGB, gl.UNSIGNED_BYTE, this.video)

    const shape = vrProjectionShape(this.format.projection)
    if (!shape) return
    const eye = vrEyeRect(this.format.layout)
    const mode =
      shape.kind === 'equirect'
        ? shape.fovDeg >= 360
          ? MODE.equirectFull
          : MODE.equirectHalf
        : shape.mapping === 'equisolid'
          ? MODE.fisheyeSolid
          : MODE.fisheyeEven

    gl.useProgram(this.program)
    gl.uniformMatrix3fv(this.uniforms.uRot ?? null, false, rotation(this.look.yaw, this.look.pitch))
    gl.uniform1f(this.uniforms.uTanHalfFov ?? null, Math.tan((this.look.fov * Math.PI) / 360))
    gl.uniform1f(this.uniforms.uAspect ?? null, this.canvas.width / this.canvas.height)
    gl.uniform1i(this.uniforms.uMode ?? null, mode)
    gl.uniform1f(this.uniforms.uFovHalf ?? null, (shape.fovDeg * Math.PI) / 360)
    gl.uniform4f(this.uniforms.uEye ?? null, eye.x, eye.y, eye.w, eye.h)

    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /**
   * Draw every frame the video produces, for as long as it produces them.
   *
   * `requestVideoFrameCallback` fires once per decoded frame rather than once
   * per screen refresh, so a 30fps file is drawn thirty times a second and
   * nothing is redrawn while it is paused.
   */
  follow(): void {
    const tick = (): void => {
      if (this.disposed || this.failed) return
      this.draw()
      this.frameHandle = this.video.requestVideoFrameCallback(tick)
    }
    this.stopFollowing()
    this.frameHandle = this.video.requestVideoFrameCallback(tick)
  }

  private stopFollowing(): void {
    if (this.frameHandle === null) return
    this.video.cancelVideoFrameCallback(this.frameHandle)
    this.frameHandle = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopFollowing()
    const gl = this.gl
    gl.deleteTexture(this.texture)
    gl.deleteProgram(this.program)
    // The context itself is left alone. Losing it deliberately would free
    // its memory a little sooner and make this canvas useless for good —
    // and the same canvas is asked for a second context whenever the picture
    // is rebuilt without being taken off the page.
  }
}
