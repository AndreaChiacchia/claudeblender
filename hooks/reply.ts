import type { ClipReply, FailCode, Reply, ViewKind } from '../types'
import { MARK_BEGIN, MARK_END } from './script'
import { PRESET_IDS } from './views'

/** What `parseReply` reads of an MCP tool result (`McpToolResult` fits it). */
export type RawResult = {
  content?: ReadonlyArray<{ type: string; text?: unknown }>
  isError?: boolean
  structuredContent?: unknown
}

const SCRIPT_CODES: readonly FailCode[] = ['no-view3d', 'no-camera', 'no-such-camera', 'too-old', 'error']
const VIEW_KINDS: readonly ViewKind[] = [...PRESET_IDS, 'object']
/** The most camera names a reply is taken to carry. */
const MAX_CAMS = 24

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/** The camera names of a reply: its strings, at most 24; empty when it is not an array. */
function namesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string').slice(0, MAX_CAMS) : []
}

/** Standard base64 to bytes; `atob` throws on bad input. */
export function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  return bytes
}

/** The text of the answer: `structuredContent.result` when a string, else the text blocks; a `{"result": "..."}` wrapper is opened. */
function bodyOf(result: RawResult): string {
  const structured = result.structuredContent
  let body: string
  if (
    structured !== null &&
    typeof structured === 'object' &&
    typeof (structured as { result?: unknown }).result === 'string'
  ) {
    body = (structured as { result: string }).result
  } else {
    body = (result.content ?? [])
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => String(block.text))
      .join('\n')
  }
  if (body.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(body)
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { result?: unknown }).result === 'string') {
        body = (parsed as { result: string }).result
      }
    } catch {
      // Not the wrapper: the body stays as it is.
    }
  }

  return body
}

const firstLine = (body: string): string =>
  (
    body
      .split('\n')
      .map(line => line.trim())
      .find(line => line !== '') ?? ''
  ).slice(0, 200)

type Fail = Extract<Reply, { kind: 'fail' }>

const badReply = (): Fail => ({ kind: 'fail', code: 'bad-reply', message: '' })

/** The marked line's JSON of a successful script run, or why there is none (the script's own failures included). */
function dataOf(result: RawResult): { kind: 'data'; data: Record<string, unknown> } | Fail {
  const body = bodyOf(result)
  if (body.includes('Could not connect to Blender')) return { kind: 'fail', code: 'offline', message: '' }
  const i = body.indexOf(MARK_BEGIN)
  if (i < 0) {
    if (result.isError === true || body.trim() !== '') return { kind: 'fail', code: 'error', message: firstLine(body) }

    return badReply()
  }
  const j = body.indexOf(MARK_END, i)
  if (j < 0) return { kind: 'fail', code: 'truncated', message: '' }
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(body.slice(i + MARK_BEGIN.length, j))
    if (parsed === null || typeof parsed !== 'object') return badReply()
    data = parsed as Record<string, unknown>
  } catch {
    return badReply()
  }
  if (data.ok === false) {
    const code = SCRIPT_CODES.find(c => c === data.code) ?? 'error'
    // A missing camera's name is kept whole: it is the point of the answer.
    const message = String(data.message ?? '')
    const fail: Fail = { kind: 'fail', code, message: code === 'no-such-camera' ? message : message.slice(0, 300) }
    if (Array.isArray(data.cams)) fail.cams = namesOf(data.cams)
    if (typeof data.active === 'string') fail.active = data.active

    return fail
  }
  if (data.ok !== true) return badReply()

  return { kind: 'data', data }
}

const isSize = (n: unknown): n is number => isCount(n) && n >= 1 && n <= 2048

/** A `w x h` picture's base64 RGB as bytes; null when it does not decode to exactly that many. */
function rgbOf(value: unknown, w: number, h: number): Uint8Array | null {
  if (typeof value !== 'string') return null
  try {
    const bytes = decodeBase64(value)

    return bytes.length === w * h * 3 ? bytes : null
  } catch {
    return null
  }
}

/** What every successful answer says of the scene and the view. */
function metaOf(data: Record<string, unknown>) {
  return {
    scene: typeof data.scene === 'string' ? data.scene : '',
    objects: isCount(data.objects) ? data.objects : 0,
    ms: isCount(data.ms) ? data.ms : 0,
    view: VIEW_KINDS.find(v => v === data.view) ?? 'viewport',
    cam: typeof data.cam === 'string' ? data.cam : '',
    cams: namesOf(data.cams),
    active: typeof data.active === 'string' ? data.active : '',
  }
}

/** Blender's answer to the draw script as a frame, or why there is none. */
export function parseReply(result: RawResult): Reply {
  const got = dataOf(result)
  if (got.kind === 'fail') return got
  const { data } = got
  const { w, h } = data
  if (!isSize(w) || !isSize(h)) return badReply()
  const rgb = rgbOf(data.rgb, w, h)
  if (rgb === null) return badReply()

  return {
    kind: 'frame',
    w,
    h,
    rgb,
    blender: typeof data.blender === 'string' ? data.blender : '',
    ...metaOf(data),
  }
}

/** Blender's answer to a batch of an animation capture: its frames, all of one size, or why there are none. */
export function parseClip(result: RawResult): ClipReply {
  const got = dataOf(result)
  if (got.kind === 'fail') return got
  const { data } = got
  const { w, h, frames, total, from, step, start, end, fps } = data
  if (data.clip !== true || !isSize(w) || !isSize(h) || !Array.isArray(frames)) return badReply()
  if (!isCount(total) || !isCount(from) || !isSize(step) || !Number.isInteger(start) || !Number.isInteger(end)) return badReply()
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return badReply()
  const out: Array<{ n: number; rgb: Uint8Array }> = []
  for (const f of frames as unknown[]) {
    if (f === null || typeof f !== 'object') return badReply()
    const { n, rgb } = f as { n?: unknown; rgb?: unknown }
    if (typeof n !== 'number' || !Number.isInteger(n)) return badReply()
    const bytes = rgbOf(rgb, w, h)
    if (bytes === null) return badReply()
    out.push({ n, rgb: bytes })
  }

  return {
    kind: 'clip',
    w,
    h,
    frames: out,
    total,
    from,
    step,
    start: start as number,
    end: end as number,
    fps,
    ...metaOf(data),
  }
}
