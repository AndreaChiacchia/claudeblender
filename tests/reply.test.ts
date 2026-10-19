import { expect, test } from 'claude-code/testing'

import { decodeBase64, parseReply } from '../hooks/reply'
import { MARK_BEGIN, MARK_END } from '../hooks/script'

const bytesToB64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes))

/** One marked line, as the script prints it. */
const line = (d: Record<string, unknown>): string => MARK_BEGIN + JSON.stringify({ v: 1, ...d }) + MARK_END

const FRAME = { ok: true, w: 2, h: 1, rgb: bytesToB64([1, 2, 3, 4, 5, 6]), scene: 'Scene', objects: 3, ms: 120, blender: '5.2.2 LTS', view: 'viewport' }

const text = (t: string, over: { isError?: boolean; structuredContent?: unknown } = {}) => ({
  content: [{ type: 'text', text: t }],
  isError: false,
  ...over,
})

test('a frame inside the {"result": ...} text the MCP returns', () => {
  const reply = parseReply(text(JSON.stringify({ result: 'Code executed successfully: ' + line(FRAME) + '\n' })))
  expect(reply.kind).toBe('frame')
  if (reply.kind !== 'frame') return
  expect([reply.w, reply.h, reply.scene, reply.objects, reply.ms, reply.blender, reply.view]).toEqual([
    2,
    1,
    'Scene',
    3,
    120,
    '5.2.2 LTS',
    'viewport',
  ])
  expect(Array.from(reply.rgb)).toEqual([1, 2, 3, 4, 5, 6])
})

test('the same as a bare text block', () => {
  const reply = parseReply(text('Code executed successfully: ' + line(FRAME) + '\n'))
  expect(reply.kind).toBe('frame')
})

test('a frame through structuredContent.result', () => {
  const reply = parseReply({
    content: [],
    isError: false,
    structuredContent: { result: 'Code executed successfully: ' + line({ ...FRAME, view: 'camera' }) },
  })
  expect(reply.kind === 'frame' && reply.view).toBe('camera')
})

test('Blender not running is offline', () => {
  const reply = parseReply(
    text(
      JSON.stringify({
        result: 'Error getting scene info: Could not connect to Blender. Make sure the Blender addon is running.',
      }),
    ),
  )
  expect(reply).toEqual({ kind: 'fail', code: 'offline', message: '' })
})

test('an answer with no marker is an error carrying its first line', () => {
  const reply = parseReply(text(JSON.stringify({ result: '\n  Traceback (most recent call last):\n  boom' })))
  expect(reply).toEqual({ kind: 'fail', code: 'error', message: 'Traceback (most recent call last):' })
  expect(parseReply({ content: [], isError: true })).toEqual({ kind: 'fail', code: 'error', message: '' })
  expect(parseReply({ content: [], isError: false })).toEqual({ kind: 'fail', code: 'bad-reply', message: '' })
})

test('no end marker is truncated', () => {
  const reply = parseReply(text(MARK_BEGIN + '{"ok":true,"w":2,"rgb":"AAAA'))
  expect(reply).toEqual({ kind: 'fail', code: 'truncated', message: '' })
})

test('bad JSON is bad-reply', () => {
  expect(parseReply(text(MARK_BEGIN + '{nope' + MARK_END))).toEqual({ kind: 'fail', code: 'bad-reply', message: '' })
})

test('an rgb of the wrong length is bad-reply', () => {
  expect(parseReply(text(line({ ...FRAME, w: 3 }))).kind).toBe('fail')
  expect(parseReply(text(line({ ...FRAME, w: 3 })))).toEqual({ kind: 'fail', code: 'bad-reply', message: '' })
  expect(parseReply(text(line({ ...FRAME, rgb: '***' })))).toEqual({ kind: 'fail', code: 'bad-reply', message: '' })
  expect(parseReply(text(line({ ...FRAME, w: 0 })))).toEqual({ kind: 'fail', code: 'bad-reply', message: '' })
})

test('the cameras and the active one are read, capped at 24, with non-strings dropped', () => {
  const many = Array.from({ length: 30 }, (_, i) => `Cam${i}`)
  const reply = parseReply(text(line({ ...FRAME, view: 'object', cam: 'Cam3', cams: [...many, 5, null], active: 'Cam0' })))
  expect(reply.kind).toBe('frame')
  if (reply.kind !== 'frame') return
  expect(reply.cams).toEqual(many.slice(0, 24))
  expect([reply.view, reply.cam, reply.active]).toEqual(['object', 'Cam3', 'Cam0'])
  const mixed = parseReply(text(line({ ...FRAME, cams: ['A', 7, 'B', {}] })))
  expect(mixed.kind === 'frame' && mixed.cams).toEqual(['A', 'B'])
})

test('a frame with no camera fields has empty ones, and a view it does not know is the viewport', () => {
  const reply = parseReply(text(line({ ...FRAME, view: 'sideways' })))
  expect(reply.kind === 'frame' && [reply.view, reply.cam, reply.cams, reply.active]).toEqual(['viewport', '', [], ''])
  expect(parseReply(text(line({ ...FRAME, view: 'iso' }))).kind === 'frame').toBe(true)
  const iso = parseReply(text(line({ ...FRAME, view: 'iso' })))
  expect(iso.kind === 'frame' && iso.view).toBe('iso')
})

test('a missing camera keeps its whole name and the cameras that were listed', () => {
  const name = 'N'.repeat(350)
  const reply = parseReply(text(line({ ok: false, code: 'no-such-camera', message: name, cams: ['A', 'B'], active: 'A' })))
  expect(reply).toEqual({ kind: 'fail', code: 'no-such-camera', message: name, cams: ['A', 'B'], active: 'A' })
})

test('each ok:false code of the script, and an unknown one as error', () => {
  for (const code of ['no-view3d', 'no-camera', 'too-old', 'error']) {
    expect(parseReply(text(line({ ok: false, code, message: 'm' })))).toEqual({ kind: 'fail', code, message: 'm' })
  }
  expect(parseReply(text(line({ ok: false, code: 'weird', message: 'x'.repeat(400) })))).toEqual({
    kind: 'fail',
    code: 'error',
    message: 'x'.repeat(300),
  })
})

test('decodeBase64 round-trips the bytes 0..255', () => {
  const all = Array.from({ length: 256 }, (_, i) => i)
  expect(Array.from(decodeBase64(bytesToB64(all)))).toEqual(all)
})
