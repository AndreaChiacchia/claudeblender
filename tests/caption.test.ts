import { expect, test } from 'claude-code/testing'

import {
  agentLabel,
  assignColor,
  captionSegments,
  clockText,
  colorOf,
  labelOf,
  layoutCaption,
  messageOf,
  playText,
  shortOf,
} from '../hooks/caption'
import type { CaptionLayout, Segment } from '../hooks/caption'
import { HOT, LIVE, PEER_COLORS, PLAIN } from '../hooks/cells'
import type { FailCode } from '../types'

const by = (agentId: string | null, isRefresh = false) => ({ agentId, isRefresh, others: 0 })

test('labelOf: the main loop, a refresh, a captured label, and an agent never captured', () => {
  const labels = new Map([
    ['a1', 'scout'],
    ['a2', 'general-purpose'],
  ])
  expect(labelOf(by(null), labels)).toBe('Claude')
  expect(labelOf(by(null, true), labels)).toBe('you')
  expect(labelOf(by('a1'), labels)).toBe('scout')
  expect(labelOf(by('a2'), labels)).toBe('general-purpose')
  expect(labelOf(by('zz'), labels)).toBe('subagent')
})

test('agentLabel: the name, else the type, cut to 20 characters', () => {
  expect(agentLabel({ type: 'Explore', name: 'scout' })).toBe('scout')
  expect(agentLabel({ type: 'general-purpose' })).toBe('general-purpose')
  expect(agentLabel({ type: 'Plan', name: 'x'.repeat(25) })).toBe('x'.repeat(19) + '…')
})

test('colorOf: lavender for the main loop, gray for a refresh, subagent colors in first-seen order wrapping after four', () => {
  const palette = new Map<string, number>()
  expect(colorOf(by(null), palette)).toBe(LIVE)
  expect(colorOf(by(null, true), palette)).toBe(PLAIN)
  expect(palette.size).toBe(0)
  const ids = ['a', 'b', 'c', 'd', 'e']
  const colors = ids.map(id => colorOf(by(id), palette))
  expect(colors).toEqual([...PEER_COLORS, PEER_COLORS[0]])
  expect(colorOf(by('b'), palette)).toBe(PEER_COLORS[1])
  expect(assignColor(palette, 'a')).toBe(PEER_COLORS[0])
})

test('clockText is HH:MM:SS at an offset in minutes', () => {
  const at = Date.parse('2026-10-14T10:05:09Z')
  expect(clockText(at, 0)).toBe('10:05:09')
  expect(clockText(at, 120)).toBe('12:05:09')
  expect(clockText(at, -600)).toBe('00:05:09')
})

test('messageOf: the text of every failure', () => {
  const codes: FailCode[] = ['offline', 'no-server', 'no-view3d', 'no-camera', 'too-old', 'timeout', 'truncated', 'bad-reply', 'error']
  expect(codes.map(c => messageOf(c, 'blender', 'D'))).toEqual([
    "Blender isn't reachable. Start Blender with its MCP add-on connected, then /blender refresh.",
    'The MCP server "blender" isn\'t connected. Check /mcp, or the Blender MCP server setting in /config.',
    'Blender has no 3D Viewport open to draw from.',
    'The scene has no camera. Add one, or set View to viewport in /config.',
    'This needs Blender 3.0 or later (found D).',
    'Blender took longer than 20 s to answer.',
    "Blender's answer could not be read.",
    "Blender's answer could not be read.",
    'The draw failed: D',
  ])
  expect(messageOf('error', 'blender', '')).toBe('The draw failed.')
  expect(messageOf('no-such-camera', 'blender', 'Cockpit')).toBe('The camera "Cockpit" is gone; showing the viewport.')
})

test('shortOf cuts at 120 characters', () => {
  expect(shortOf('a'.repeat(120))).toBe('a'.repeat(120))
  expect(shortOf('a'.repeat(121))).toBe('a'.repeat(119) + '…')
})

test('the caption of a frame is its pieces, with no separators', () => {
  const at = Date.parse('2026-10-14T10:00:00Z')
  const segments = captionSegments({
    scene: 'Scene',
    objects: 3,
    ms: 120,
    at,
    by: { label: 'Explore', color: PEER_COLORS[0] ?? 0, others: 2 },
    errorMessage: null,
    offsetMin: 120,
  })
  expect(segments.map(s => s.text)).toEqual(['Scene', '3 obj', '120 ms', '12:00:00', 'by Explore +2'])
  expect(segments.map(s => s.role)).toEqual([undefined, 'objects', 'ms', undefined, 'by'])
  expect(segments[0]?.fg).toBe(LIVE)
  expect(segments.at(-1)?.fg).toBe(PEER_COLORS[0])
  const noBy = captionSegments({ scene: 'S'.repeat(30), objects: 1, ms: 5, at, by: null, errorMessage: null, offsetMin: 0 })
  expect(noBy.map(s => s.text)).toEqual(['S'.repeat(23) + '…', '1 obj', '5 ms', '10:00:00'])
})

test('the caption of a failed draw keeps the last frame time', () => {
  const at = Date.parse('2026-10-14T10:00:00Z')
  const message = "Blender isn't reachable. Start Blender with its MCP add-on connected, then /blender refresh."
  const segments = captionSegments({ scene: 'Scene', objects: 3, ms: 120, at, by: null, errorMessage: message, offsetMin: 0 })
  expect(segments.map(s => s.text)).toEqual([message, 'last frame 10:00:00'])
  expect(segments[0]?.fg).toBe(HOT)
})

const LIVE_PIECES: Segment[] = [
  { text: 'Scene', fg: LIVE },
  { text: '13 obj', fg: PLAIN, role: 'objects' },
  { text: '9 ms', fg: PLAIN, role: 'ms' },
  { text: '12:22:04', fg: PLAIN },
  { text: 'by general-purpose', fg: PEER_COLORS[0] ?? 0, role: 'by' },
]

/** The text of one line of a layout, from column 3 on, with the gaps between items as spaces. */
function lineText(layout: CaptionLayout, line: number): string {
  let out = ''
  let col = 3
  for (const item of layout.items.filter(i => i.line === line)) {
    out += ' '.repeat(Math.max(0, item.col - col)) + item.text
    col = item.col + Array.from(item.text).length
  }

  return out
}

test('layoutCaption: 72 columns hold the live caption on one line', () => {
  const layout = layoutCaption(LIVE_PIECES, 72)
  expect(layout.lines).toBe(1)
  expect(lineText(layout, 0)).toBe('Scene · 13 obj · 9 ms · 12:22:04 · by general-purpose')
  expect(layout.lastEnd).toBe(3 + 'Scene · 13 obj · 9 ms · 12:22:04 · by general-purpose'.length)
  expect(layout.items.find(i => i.text === 'by general-purpose')?.role).toBe('by')
})

test('layoutCaption: 40 columns break between pieces, with no separator at the break', () => {
  const layout = layoutCaption(LIVE_PIECES, 40)
  expect(layout.lines).toBe(2)
  expect(lineText(layout, 0)).toBe('Scene · 13 obj · 9 ms · 12:22:04')
  expect(lineText(layout, 1)).toBe('by general-purpose')
  const second = layout.items.filter(i => i.line === 1)
  expect(second.map(i => [i.col, i.text])).toEqual([[3, 'by general-purpose']])
  expect(layout.lastEnd).toBe(3 + 18)
})

test('layoutCaption: 20 columns use three lines and cut the last piece with an ellipsis', () => {
  const layout = layoutCaption(LIVE_PIECES, 20)
  expect(layout.lines).toBe(3)
  expect(lineText(layout, 0)).toBe('Scene · 13 obj')
  expect(lineText(layout, 1)).toBe('9 ms · 12:22:04')
  const last = lineText(layout, 2)
  expect(last.endsWith('…')).toBe(true)
  expect(last.startsWith('by general-purp')).toBe(true)
  expect(Array.from(last).length).toBeLessThanOrEqual(17)
  expect(layout.lastEnd).toBeLessThanOrEqual(20)
})

test('layoutCaption: a long message wraps at spaces over the lines, and never splits a word that fits', () => {
  const message = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')
  const pieces: Segment[] = [
    { text: message, fg: HOT },
    { text: 'last frame 10:00:00', fg: PLAIN },
  ]
  const layout = layoutCaption(pieces, 40)
  expect(layout.lines).toBeGreaterThanOrEqual(3)
  expect(layout.lines).toBeLessThanOrEqual(3)
  const words = new Set(message.split(' '))
  for (const item of layout.items.filter(i => i.fg === HOT && !i.text.endsWith('…'))) {
    for (const word of item.text.split(' ')) expect(words.has(word)).toBe(true)
    expect(item.col + Array.from(item.text).length).toBeLessThanOrEqual(40)
    expect(item.role).toBeUndefined()
  }
  expect(layout.items.every(i => i.line < 3)).toBe(true)
  // Lines 0 and 1 hold fragments of the message; the lines run out, so line 2 ends in an ellipsis.
  expect(lineText(layout, 0).length).toBeGreaterThan(0)
  expect(lineText(layout, 1).length).toBeGreaterThan(0)
  expect(lineText(layout, 2).endsWith('…')).toBe(true)
})

test('layoutCaption: a single word wider than the line is cut with an ellipsis', () => {
  const layout = layoutCaption([{ text: 'x'.repeat(60), fg: HOT }], 20)
  expect(layout.lines).toBe(1)
  expect(lineText(layout, 0)).toBe('x'.repeat(16) + '…')
})

test('layoutCaption: a piece that no longer fits on the last line ends it with an ellipsis, and later pieces are dropped', () => {
  const pieces: Segment[] = [
    { text: 'a'.repeat(14), fg: LIVE },
    { text: 'b'.repeat(14), fg: LIVE },
    { text: 'c'.repeat(14), fg: LIVE },
    { text: 'd'.repeat(14), fg: LIVE },
    { text: 'dropped', fg: LIVE },
  ]
  const layout = layoutCaption(pieces, 20)
  expect(layout.lines).toBe(3)
  expect(layout.items.some(i => i.text.includes('dropped'))).toBe(false)
  expect(layout.items.some(i => i.text.includes('d'))).toBe(false)
})

const BASE = { scene: 'Scene', objects: 3, ms: 120, at: Date.parse('2026-10-14T12:02:31Z'), by: null, errorMessage: null, offsetMin: 0 }

test('playText pads the frame to the width of the last one', () => {
  expect(playText(1, 60)).toBe('▶  1/60')
  expect(playText(60, 60)).toBe('▶ 60/60')
  expect(playText(7, 250)).toBe('▶   7/250')
})

test('a playing clip and a capture each add one piece after the scene name', () => {
  const playing = captionSegments({ ...BASE, play: { kind: 'playing', frame: 1, end: 60 } })
  expect(playing.map(s => s.text)).toEqual(['Scene', '▶  1/60', '3 obj', '120 ms', '12:02:31'])
  expect(playing[1]?.role).toBe('play')
  const capturing = captionSegments({ ...BASE, play: { kind: 'capturing', got: 14, total: 30 } })
  expect(capturing.map(s => s.text)).toEqual(['Scene', 'capturing 14/30', '3 obj', '120 ms', '12:02:31'])
  expect(captionSegments({ ...BASE, play: { kind: 'capturing', got: 0, total: null } })[1]?.text).toBe('capturing 0/…')
  expect(captionSegments({ ...BASE, play: null }).map(s => s.text)).toEqual(['Scene', '3 obj', '120 ms', '12:02:31'])
})
