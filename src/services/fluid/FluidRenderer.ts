import { FRAGMENT_SOURCE, VERTEX_SOURCE } from './shader'

// WebGL2 fluid renderer, React-agnostic: create, feed uniforms per frame,
// dispose. `create` returns null if WebGL2 is unavailable (caller uses CSS).

const MAX_RIPPLES = 3

// Positions are 0..1, y-up.
export interface FluidUniforms {
  time: number
  settle: number
  settleVel: number
  pulse: number
  /** Composer rect: [centerX, centerY, halfWidth, halfHeight] */
  anchor: readonly [number, number, number, number]
  /** Corner radius, expressed in screen-heights. */
  radius: number
  /** Bloom spill past the composer edge, in screen-heights. */
  reach: number
  /** MAX_RIPPLES × vec4(x, y, birthTime, strength) */
  ripples: Float32Array
}

// Low-frequency field: shade fewer pixels than the display and let the browser
// upscale — the blur hides it and it saves ~2/3 of the fill rate.
const RES_SCALE = 0.6
const MAX_DPR = 1.5

const UNIFORM_NAMES = [
  'uRes',
  'uAspect',
  'uTime',
  'uSettle',
  'uSettleVel',
  'uPulse',
  'uAnchor',
  'uRadius',
  'uReach',
  'uRipples',
] as const

type UniformName = (typeof UNIFORM_NAMES)[number]

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // Number the source so the driver's reported line number is usable.
    const numbered = source
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(3)} | ${line}`)
      .join('\n')
    console.error(
      `[fluid] ${label} shader failed to compile:\n${gl.getShaderInfoLog(shader)}\n${numbered}`,
    )
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export class FluidRenderer {
  private readonly gl: WebGL2RenderingContext
  private readonly canvas: HTMLCanvasElement
  private readonly program: WebGLProgram
  private readonly loc: Record<UniformName, WebGLUniformLocation | null>

  // Last configured backing-store size, so resize() no-ops on most frames.
  private width = 0
  private height = 0

  private constructor(
    gl: WebGL2RenderingContext,
    canvas: HTMLCanvasElement,
    program: WebGLProgram,
  ) {
    this.gl = gl
    this.canvas = canvas
    this.program = program
    this.loc = Object.fromEntries(
      UNIFORM_NAMES.map((name) => [name, gl.getUniformLocation(program, name)]),
    ) as Record<UniformName, WebGLUniformLocation | null>

    gl.useProgram(program)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    // Premultiplied alpha: shader outputs col*a, so glow adds without the dark
    // fringe straight alpha blending gives on a near-black page.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  /** Returns null when WebGL2 is unavailable or the program won't build. */
  static create(canvas: HTMLCanvasElement): FluidRenderer | null {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
    })
    if (!gl) return null

    const vert = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE, 'vertex')
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE, 'fragment')
    if (!vert || !frag) return null

    const program = gl.createProgram()
    if (!program) return null
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    // Program owns the shaders once linked; drop our references.
    gl.deleteShader(vert)
    gl.deleteShader(frag)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[fluid] program link failed:', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      return null
    }

    return new FluidRenderer(gl, canvas, program)
  }

  /** Sizes the backing store to the element. Cheap to call every frame. */
  private resize(cssWidth: number, cssHeight: number): void {
    const scale = Math.min(window.devicePixelRatio || 1, MAX_DPR) * RES_SCALE
    const width = Math.max(1, Math.round(cssWidth * scale))
    const height = Math.max(1, Math.round(cssHeight * scale))
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height
    this.gl.viewport(0, 0, width, height)
  }

  render(u: FluidUniforms, cssWidth: number, cssHeight: number): void {
    if (cssWidth <= 0 || cssHeight <= 0) return
    this.resize(cssWidth, cssHeight)

    const { gl, loc } = this
    gl.useProgram(this.program)

    gl.uniform2f(loc.uRes, this.width, this.height)
    gl.uniform1f(loc.uAspect, cssWidth / cssHeight)
    gl.uniform1f(loc.uTime, u.time)
    gl.uniform1f(loc.uSettle, u.settle)
    gl.uniform1f(loc.uSettleVel, u.settleVel)
    gl.uniform1f(loc.uPulse, u.pulse)
    gl.uniform4f(loc.uAnchor, u.anchor[0], u.anchor[1], u.anchor[2], u.anchor[3])
    gl.uniform1f(loc.uRadius, u.radius)
    gl.uniform1f(loc.uReach, u.reach)
    gl.uniform4fv(loc.uRipples, u.ripples.subarray(0, MAX_RIPPLES * 4))

    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose(): void {
    this.gl.deleteProgram(this.program)
    // Do NOT call loseContext(): it kills the context permanently and getContext
    // hands back the dead one, so StrictMode remount then fails every compile.
  }
}

export { MAX_RIPPLES }
