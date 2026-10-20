import { expect, test } from 'claude-code/testing'

import { DEFAULT, GLINT_UP, HALF_TOP, INK_DARK, LIVE, PLAIN, lighten, mixColor } from '../hooks/cells'
import type { Cell } from '../hooks/cells'
import {
  BADGE_FRAMES,
  GLOW_FRAMES,
  GLOW_GAIN,
  PULSE_COUNT,
  PULSE_PROFILE,
  WIPE_FRAMES,
  advance,
  composeCaption,
  composeImage,
  createPaneMotion,
  dotCell,
  glowAmount,
  isActive,
  observeError,
  observeFrame,
} from '../hooks/motion'
import type { PaneMotion } from '../hooks/motion'
import { layoutCaption } from '../hooks/caption'
import type { Segment } from '../hooks/caption'
import { dimCells, glowCells } from '../hooks/pixels'
import type { Motion } from '../types'

/** The caption of `pieces` in `cols` columns, laid out and composed. */
const caption = (m: PaneMotion, pieces: Segment[], dot: 'idle' | 'stale' | 'rendering' | 'error' | 'empty', cols: number, level: Motion): Cell[] =>
  composeCaption(m, layoutCaption(pieces, cols), dot, cols, level)

const cellText = (cells: Cell[]): string => cells.map(c => String.fromCodePoint(c.cp)).join('')
const solid = (n: number, c: number): Cell[] => Array.from({ length: n }, () => ({ cp: HALF_TOP, fg: c, bg: c }))
const NEW = 0x00ff00
const OLD = 0xff0000
const frame = (seq: number, objects = 3, ms = 120, hasBy = true) => ({ seq, objects, ms, hasBy })

/** A pane that has taken a first frame silently, then sees a second over `old`. */
function second(level: Motion = 'lively', old: Cell[] | null = null, objects = 3): PaneMotion {
  const m = createPaneMotion()
  observeFrame(m, frame(1), null, level)
  observeFrame(m, frame(2, objects), old, level)

  return m
}

/** A pane that has taken a first frame silently, then sees a second and a third over `old`: the third wipes right. */
function third(level: Motion = 'lively', old: Cell[] | null = null): PaneMotion {
  const m = createPaneMotion()
  observeFrame(m, frame(1), null, level)
  observeFrame(m, frame(2), old, level)
  observeFrame(m, frame(3), old, level)

  return m
}

const ticks = (m: PaneMotion, n: number, isRendering = false): void => {
  for (let i = 0; i < n; i++) advance(m, isRendering)
}

const STATE = { isStale: false, isRendering: false }

test('the first frame is taken silently', () => {
  const m = createPaneMotion()
  observeFrame(m, frame(1, 7, 99), null, 'lively')
  expect(m.primed).toBe(true)
  expect([m.wipe, m.pulse, m.badge]).toEqual([null, null, null])
  expect([m.objects.shown, m.objects.target, m.ms.shown]).toEqual([7, 7, 99])
  expect(isActive(m, false, 'lively')).toBe(false)
})

test('the next frame starts the wipe, the agent pulse and the fresh badge', () => {
  const m = second()
  expect(m.wipe).toEqual({ start: 0, old: null, dir: 'down' })
  expect(m.pulse).toEqual({ start: 0 })
  expect(m.badge).toEqual({ start: 0 })
  expect(isActive(m, false, 'lively')).toBe(true)
  expect(WIPE_FRAMES).toBe(6)
  expect(PULSE_PROFILE.length * PULSE_COUNT).toBe(18)
  expect(BADGE_FRAMES).toBe(40)
  ticks(m, 40)
  expect(isActive(m, false, 'lively')).toBe(false)
})

test('a frame with no one to credit starts no pulse', () => {
  const m = createPaneMotion()
  observeFrame(m, frame(1), null, 'lively')
  observeFrame(m, frame(2, 3, 120, false), null, 'lively')
  expect(m.pulse).toBeNull()
})

test('Off starts nothing', () => {
  const m = createPaneMotion()
  observeFrame(m, frame(1), null, 'off')
  observeFrame(m, frame(2, 9), null, 'off')
  observeError(m, 'off')
  expect([m.wipe, m.pulse, m.badge, m.errorPulse]).toEqual([null, null, null, null])
  expect(m.objects.shown).toBe(9)
  expect(isActive(m, true, 'off')).toBe(false)
})

test('the wipe: new rows above the head, a glint row at the head, old rows below', () => {
  const cols = 3
  const rows = 6
  const old = solid(cols * rows, OLD)
  const base = solid(cols * rows, NEW)
  const m = second('lively', old)
  ticks(m, 2)
  // Frame 2: the head is row floor(3 * 6 / 6) - 1 = 2.
  const cells = composeImage(m, base, cols, rows, STATE, 'lively')
  const row = (y: number) => cells.slice(y * cols, (y + 1) * cols)
  expect(row(0).every(c => c.fg === NEW)).toBe(true)
  expect(row(1).every(c => c.fg === NEW)).toBe(true)
  expect(row(2).every(c => c.fg === mixColor(NEW, GLINT_UP, 0.35) && c.bg === mixColor(NEW, GLINT_UP, 0.35))).toBe(true)
  for (const y of [3, 4, 5]) expect(row(y).every(c => c.fg === OLD)).toBe(true)
  // Over at frame 6.
  ticks(m, 4)
  expect(composeImage(m, base, cols, rows, STATE, 'lively')).toEqual(base)
})

test('Subtle: the wipe has no glint row; with no old picture there is no wipe', () => {
  const cols = 3
  const rows = 6
  const base = solid(cols * rows, NEW)
  const m = second('subtle', solid(cols * rows, OLD))
  ticks(m, 2)
  const cells = composeImage(m, base, cols, rows, STATE, 'subtle')
  expect(cells.slice(2 * cols, 3 * cols).every(c => c.fg === NEW)).toBe(true)
  expect(cells.slice(3 * cols).every(c => c.fg === OLD)).toBe(true)
  const none = second('lively', null)
  expect(composeImage(none, base, cols, rows, STATE, 'lively')).toEqual(base)
})

test('the wipe alternates down and right, and a wipe with no old picture takes no turn', () => {
  const old = solid(12, OLD)
  const m = second('lively', old)
  expect(m.wipe?.dir).toBe('down')
  expect(m.nextWipe).toBe('right')
  observeFrame(m, frame(3), old, 'lively')
  expect(m.wipe?.dir).toBe('right')
  observeFrame(m, frame(4), old, 'lively')
  expect(m.wipe?.dir).toBe('down')
  const fresh = createPaneMotion()
  observeFrame(fresh, frame(1), null, 'lively')
  observeFrame(fresh, frame(2), null, 'lively')
  expect(fresh.nextWipe).toBe('down')
  observeFrame(fresh, frame(3), old, 'lively')
  expect(fresh.wipe?.dir).toBe('down')
})

test('the left-to-right wipe: new columns left of the head, a glint column at the head, old columns right of it', () => {
  const cols = 6
  const rows = 2
  const old = solid(cols * rows, OLD)
  const base = solid(cols * rows, NEW)
  const m = third('lively', old)
  ticks(m, 2)
  // Frame 2: the head is column 0 + floor(3 * 6 / 6) - 1 = 2.
  const cells = composeImage(m, base, cols, rows, STATE, 'lively')
  const glint = mixColor(NEW, GLINT_UP, 0.35)
  for (let y = 0; y < rows; y++) {
    const row = cells.slice(y * cols, (y + 1) * cols)
    expect(row.slice(0, 2).every(c => c.fg === NEW)).toBe(true)
    expect(row[2]?.fg).toBe(glint)
    expect(row[2]?.bg).toBe(glint)
    expect(row.slice(3).every(c => c.fg === OLD)).toBe(true)
  }
  ticks(m, 4)
  expect(composeImage(m, base, cols, rows, STATE, 'lively')).toEqual(base)
})

test("the left-to-right wipe runs over the picture's columns, not the blanks around it", () => {
  const cols = 8
  const rows = 1
  const blank: Cell = { cp: 0x20, fg: DEFAULT, bg: DEFAULT }
  const picture = (c: number): Cell[] =>
    Array.from({ length: cols }, (_, x) => (x >= 2 && x <= 5 ? { cp: HALF_TOP, fg: c, bg: c } : blank))
  const old = picture(OLD)
  const base = picture(NEW)
  const m = third('lively', old)
  ticks(m, 2)
  // The picture spans columns 2-5: the head is 2 + floor(3 * 4 / 6) - 1 = 3.
  const cells = composeImage(m, base, cols, rows, STATE, 'lively')
  expect(cells[2]?.fg).toBe(NEW)
  expect(cells[3]?.fg).toBe(mixColor(NEW, GLINT_UP, 0.35))
  expect(cells[4]?.fg).toBe(OLD)
  expect(cells[5]?.fg).toBe(OLD)
  for (const x of [0, 1, 6, 7]) expect(cells[x]).toEqual(base[x])
})

test('Subtle: the left-to-right wipe has no glint column', () => {
  const cols = 6
  const rows = 2
  const m = third('subtle', solid(cols * rows, OLD))
  ticks(m, 2)
  const cells = composeImage(m, solid(cols * rows, NEW), cols, rows, STATE, 'subtle')
  for (let y = 0; y < rows; y++) {
    const row = cells.slice(y * cols, (y + 1) * cols)
    expect(row.slice(0, 3).every(c => c.fg === NEW)).toBe(true)
    expect(row.slice(3).every(c => c.fg === OLD)).toBe(true)
  }
})

test('the stale dim is 0.2 toward the ink, in every level', () => {
  const base = solid(4, 0x808080)
  const m = createPaneMotion()
  const dimmed = composeImage(m, base, 2, 2, { isStale: true, isRendering: false }, 'off')
  expect(dimmed.every(c => c.fg === mixColor(0x808080, INK_DARK, 0.2))).toBe(true)
  expect(composeImage(m, base, 2, 2, STATE, 'off')).toEqual(base)
})

test('the glow brightens the whole dimmed frame and darkens it back while Blender draws, fainter in Subtle, not in Off', () => {
  const cols = 4
  const rows = 2
  const base = solid(cols * rows, 0x808080)
  const state = { isStale: false, isRendering: true }
  const dimmed = dimCells(base, 0.2)
  const near = (x: number, v: number): boolean => Math.abs(x - v) < 1e-9
  expect(GLOW_FRAMES).toBe(32)
  expect(GLOW_GAIN).toEqual({ lively: 0.12, subtle: 0.06 })
  const m = createPaneMotion()
  expect(m.glowStart).toBeNull()
  expect(glowAmount(m, 'lively')).toBe(0)
  expect(composeImage(m, base, cols, rows, state, 'lively')).toEqual(dimmed)
  ticks(m, 1, true)
  expect(m.glowStart).toBe(m.tick)
  expect(glowAmount(m, 'lively')).toBe(0)
  ticks(m, GLOW_FRAMES / 2, true)
  expect(near(glowAmount(m, 'lively'), 0.12)).toBe(true)
  expect(near(glowAmount(m, 'subtle'), 0.06)).toBe(true)
  expect(glowAmount(m, 'off')).toBe(0)
  const lively = composeImage(m, base, cols, rows, state, 'lively')
  const subtle = composeImage(m, base, cols, rows, state, 'subtle')
  expect(lively).toEqual(glowCells(dimmed, glowAmount(m, 'lively')))
  expect(subtle).toEqual(glowCells(dimmed, glowAmount(m, 'subtle')))
  expect(new Set(lively.map(c => c.fg)).size).toBe(1)
  expect((lively[0]?.fg ?? 0) > (dimmed[0]?.fg ?? 0)).toBe(true)
  expect((subtle[0]?.fg ?? 0) <= (lively[0]?.fg ?? 0)).toBe(true)
  expect(composeImage(m, base, cols, rows, state, 'off')).toEqual(dimmed)
  ticks(m, GLOW_FRAMES / 2, true)
  expect(near(glowAmount(m, 'lively'), 0)).toBe(true)
  ticks(m, 1, false)
  expect(m.glowStart).toBeNull()
})

test('the dot spins every 4 frames in Lively and every 20 in Subtle, and is still in Off', () => {
  const cp = (m: PaneMotion, level: Motion) => dotCell(m, 'rendering', level).cp
  const m = createPaneMotion()
  const lively: number[] = []
  const subtle: number[] = []
  for (let i = 0; i < 40; i++) {
    lively.push(cp(m, 'lively'))
    subtle.push(cp(m, 'subtle'))
    advance(m, false)
  }
  expect(lively.slice(0, 4)).toEqual([0x25d0, 0x25d0, 0x25d0, 0x25d0])
  expect(lively[4]).toBe(0x25d3)
  expect(lively[8]).toBe(0x25d1)
  expect(lively[12]).toBe(0x25d2)
  expect(lively[16]).toBe(0x25d0)
  expect(new Set(subtle.slice(0, 20))).toEqual(new Set([0x25d0]))
  expect(subtle[20]).toBe(0x25d3)
  expect(cp(m, 'off')).toBe(0x25d0)
  expect(dotCell(m, 'idle', 'lively')).toEqual({ cp: 0x25cf, fg: LIVE, bg: DEFAULT })
  expect(dotCell(m, 'stale', 'lively').cp).toBe(0x25cc)
  expect(dotCell(m, 'empty', 'lively').cp).toBe(0x25cb)
})

test('a failed draw pulses the cross red', () => {
  const m = createPaneMotion()
  observeFrame(m, frame(1), null, 'lively')
  observeError(m, 'lively')
  expect(dotCell(m, 'error', 'lively')).toEqual({ cp: 0x2717, fg: lighten(0xff0000, 0.2 * 0.55), bg: DEFAULT })
  ticks(m, 2)
  expect(dotCell(m, 'error', 'lively').fg).toBe(lighten(0xff0000, 1 * 0.55))
  expect(dotCell(m, 'error', 'subtle').fg).toBe(lighten(0xff0000, 1 * 0.3))
  ticks(m, 20)
  expect(dotCell(m, 'error', 'lively').fg).toBe(0xff0000)
})

const SEGMENTS: Segment[] = [
  { text: 'Scene', fg: LIVE },
  { text: '12 obj', fg: PLAIN, role: 'objects' },
  { text: 'by Claude', fg: LIVE, role: 'by' },
]

test('the object count rolls toward its target with the changed digit flashing', () => {
  const m = createPaneMotion()
  observeFrame(m, frame(1, 3), null, 'lively')
  observeFrame(m, frame(2, 12), null, 'lively')
  expect(m.objects.shown).toBe(3)
  ticks(m, 2)
  // Gap 9: a step of ceil(9 / 4) = 3, to 6, right-aligned to the target's two digits.
  expect(m.objects.shown).toBe(6)
  const cells = caption(m, SEGMENTS, 'idle', 60, 'lively')
  const text = cellText(cells)
  expect(text).toContain('Scene ·  6 obj · by Claude')
  const at = text.indexOf(' 6 obj') + 1
  expect(cells[at]?.fg).toBe(GLINT_UP)
  expect(cells[at - 1]?.fg).toBe(PLAIN)
  ticks(m, 30)
  expect(m.objects.shown).toBe(12)
  expect(cellText(caption(m, SEGMENTS, 'idle', 60, 'lively'))).toContain('Scene · 12 obj · by Claude')
  const settled = caption(m, SEGMENTS, 'idle', 60, 'lively')
  expect(settled[cellText(settled).indexOf('12 obj')]?.fg).toBe(PLAIN)
  expect(settled[cellText(settled).indexOf('12 obj') + 1]?.fg).toBe(PLAIN)
})

test('Subtle flashes half way, and Off never flashes', () => {
  const m = createPaneMotion()
  observeFrame(m, frame(1, 3), null, 'subtle')
  observeFrame(m, frame(2, 12), null, 'subtle')
  ticks(m, 2)
  const cells = caption(m, SEGMENTS, 'idle', 60, 'subtle')
  const at = cellText(cells).indexOf(' 6 obj') + 1
  expect(cells[at]?.fg).toBe(mixColor(PLAIN, GLINT_UP, 0.5))
  const off = caption(m, SEGMENTS, 'idle', 60, 'off')
  expect(off[at]?.fg).toBe(PLAIN)
})

test('the agent label pulses in its color: three pulses, then still', () => {
  const m = second()
  const labelCell = (): Cell | undefined => {
    const cells = caption(m, SEGMENTS, 'idle', 60, 'lively')

    return cells[cellText(cells).indexOf('by Claude')]
  }
  expect(labelCell()?.fg).toBe(lighten(LIVE, 0.2 * 0.55))
  ticks(m, 2)
  expect(labelCell()?.fg).toBe(lighten(LIVE, 0.55))
  ticks(m, 16)
  expect(labelCell()?.fg).toBe(LIVE)
})

test('the fresh badge twinkles in Lively, is a plain word in Subtle and is absent in Off', () => {
  const segments: Segment[] = [{ text: 'by Claude', fg: LIVE, role: 'by' }]
  const lively = second('lively')
  expect(cellText(caption(lively, segments, 'idle', 30, 'lively'))).toContain('✦ fresh')
  ticks(lively, 4)
  expect(cellText(caption(lively, segments, 'idle', 30, 'lively'))).toContain('✧ fresh')
  const cells = caption(lively, segments, 'idle', 30, 'lively')
  expect(cells[cellText(cells).indexOf('✧')]?.fg).toBe(0x5fff00)
  ticks(lively, 40)
  expect(cellText(caption(lively, segments, 'idle', 30, 'lively'))).not.toContain('fresh')

  const subtle = second('subtle')
  const text = cellText(caption(subtle, segments, 'idle', 30, 'subtle'))
  expect(text).toContain('fresh')
  expect(text).not.toContain('✦')
  expect(cellText(caption(subtle, segments, 'idle', 30, 'off'))).not.toContain('fresh')
})

const LONG: Segment[] = [
  { text: 'Scene', fg: LIVE },
  { text: '3 obj', fg: PLAIN, role: 'objects' },
  { text: '120 ms', fg: PLAIN, role: 'ms' },
  { text: '12:00:00', fg: PLAIN },
  { text: 'by Claude', fg: LIVE, role: 'by' },
]

test('the caption is cols x lines cells; the badge shows only where it fits after the last piece and never adds a line', () => {
  const m = second()
  // On one line the caption ends at column 48; the badge needs 2 + 7 more.
  const wide = caption(m, LONG, 'idle', 60, 'lively')
  expect(wide.length).toBe(60)
  expect(cellText(wide)).toContain('✦ fresh')
  const mid = caption(m, LONG, 'idle', 50, 'lively')
  expect(mid.length).toBe(50)
  expect(cellText(mid)).not.toContain('fresh')
  expect(cellText(mid)).not.toContain('…')
  // At 40 columns the caption wraps to two lines, with nothing cut; the badge sits after `by Claude` on line 1.
  const two = caption(m, LONG, 'idle', 40, 'lively')
  expect(two.length).toBe(80)
  expect(cellText(two)).not.toContain('…')
  expect(cellText(two.slice(40))).toContain('by Claude')
  expect(cellText(two.slice(40))).toContain('✦ fresh')
  // At 20 columns it takes three lines, and the badge no longer fits: it is dropped, not a fourth line.
  const three = caption(m, LONG, 'idle', 20, 'lively')
  expect(three.length).toBe(60)
  expect(cellText(three)).not.toContain('fresh')
})

test('a rolling figure never spills past its placed digits', () => {
  const m = createPaneMotion()
  observeFrame(m, frame(1, 3), null, 'lively')
  observeFrame(m, frame(2, 120), null, 'lively')
  ticks(m, 2)
  // The figure rolls toward 120 (three digits), but the placed text has two: the placed text is shown.
  const pieces: Segment[] = [
    { text: 'Scene', fg: LIVE },
    { text: '12 obj', fg: PLAIN, role: 'objects' },
  ]
  const cells = caption(m, pieces, 'idle', 40, 'lively')
  expect(cells.length).toBe(40)
  expect(cellText(cells)).toContain('Scene · 12 obj')
})

test('a playing clip piece shows the frame given, at its placed width, under every level', () => {
  const pieces: Segment[] = [
    { text: 'Scene', fg: LIVE },
    { text: '▶  1/60', fg: LIVE, role: 'play' },
    { text: '3 obj', fg: PLAIN, role: 'objects' },
  ]
  for (const level of ['lively', 'subtle', 'off'] as const) {
    const m = createPaneMotion()
    const layout = layoutCaption(pieces, 40)
    expect(cellText(composeCaption(m, layout, 'idle', 40, level, 37))).toContain('Scene · ▶ 37/60 · 3 obj')
    expect(cellText(composeCaption(m, layout, 'idle', 40, level, 5))).toContain('Scene · ▶  5/60 · 3 obj')
    // No frame given: the piece as laid out.
    expect(cellText(composeCaption(m, layout, 'idle', 40, level))).toContain('▶  1/60')
  }
})
