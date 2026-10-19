// The pane's motion: what a new frame or a failed draw started, and each frame of the picture and the caption as cells.

import type { Motion } from '../types'
import {
  CROSS,
  DEFAULT,
  DOT_EMPTY,
  DOT_FULL,
  DOT_PENDING,
  DOT_SPIN,
  GLINT_DOWN,
  GLINT_UP,
  HOT,
  HALF_TOP,
  LIVE,
  OK_GREEN,
  PLAIN,
  SPARK_FULL,
  SPARK_HOLLOW,
  TRACK,
  lighten,
  mixColor,
  textCells,
} from './cells'
import type { Cell } from './cells'
import type { CaptionLayout, Placed } from './caption'
import { SHIMMER_GAIN, STALE_DIM, dimCells, shimmerCells } from './pixels'

export { SHIMMER_GAIN, SHIMMER_RADIUS, SHIMMER_SPEED, STALE_DIM } from './pixels'

/** One frame, in milliseconds: 20 frames a second. */
export const FRAME_MS = 50
/** The scanline wipe (0.3 s). */
export const WIPE_FRAMES = 6
/** How far the wipe's head row goes toward the warm glint (Lively). */
export const WIPE_GLINT = 0.35
/** The Lively spinner steps every this many frames (0.2 s). */
export const SPIN_FRAMES = 4
/** The Subtle spinner steps every this many frames (1 s). */
export const SPIN_SUBTLE_FRAMES = 20
/** One pulse, frame by frame. */
export const PULSE_PROFILE: readonly number[] = [0.2, 0.6, 1, 1, 0.6, 0.2]
/** Pulses per effect. */
export const PULSE_COUNT = 3
/** How far a pulse lightens, by level. */
export const PULSE_GAIN: Record<'lively' | 'subtle', number> = { lively: 0.55, subtle: 0.3 }
/** A figure rolls one step every this many frames. */
export const ROLL_EVERY = 2
/** Changed digits stay flashed this long after each roll step. */
export const FLASH_FRAMES = 6
/** How far flashed digits go to the flash color, by level. */
export const FLASH_MIX: Record<'lively' | 'subtle', number> = { lively: 1, subtle: 0.5 }
/** The fresh badge stays this long (2 s). */
export const BADGE_FRAMES = 40
/** The fresh badge's spark changes every this many frames. */
export const TWINKLE_FRAMES = 4

const PULSE_LENGTH = PULSE_PROFILE.length

/** What the state dot shows. */
export type DotState = 'idle' | 'stale' | 'rendering' | 'error' | 'empty'

type Dir = 'up' | 'down'

/** A figure that rolls like an odometer toward its target. */
export type Odo = {
  /** The value it rolls toward; null before the first frame. */
  target: number | null
  /** The value shown now. */
  shown: number
  /** Digit index from which the figure flashes, until which tick. */
  flash: { from: number; until: number; dir: Dir } | null
}

export type PaneMotion = {
  tick: number
  /** False until a frame was seen: the first frame is taken silently. */
  primed: boolean
  seq: number
  /** The wipe: `old` is the image on screen before the new frame, null when there was none of the same size. */
  wipe: { start: number; old: Cell[] | null } | null
  pulse: { start: number } | null
  badge: { start: number } | null
  errorPulse: { start: number } | null
  objects: Odo
  ms: Odo
}

const freshOdo = (): Odo => ({ target: null, shown: 0, flash: null })

export function createPaneMotion(): PaneMotion {
  return {
    tick: 0,
    primed: false,
    seq: 0,
    wipe: null,
    pulse: null,
    badge: null,
    errorPulse: null,
    objects: freshOdo(),
    ms: freshOdo(),
  }
}

function settleOdo(o: Odo, value: number): void {
  o.target = value
  o.shown = value
  o.flash = null
}

/**
 * A new frame was drawn. The first one after a load (and every one under Off) is taken silently; later ones start the
 * wipe, the agent pulse, the fresh badge and the figures' roll. `prevImage` is what was on screen, for the wipe.
 */
export function observeFrame(
  m: PaneMotion,
  frame: { seq: number; objects: number; ms: number; hasBy: boolean },
  prevImage: Cell[] | null,
  level: Motion,
): void {
  if (level === 'off' || !m.primed) {
    settleOdo(m.objects, frame.objects)
    settleOdo(m.ms, frame.ms)
    m.wipe = null
    m.pulse = null
    m.badge = null
    m.primed = true
    m.seq = frame.seq

    return
  }
  m.wipe = { start: m.tick, old: prevImage }
  m.pulse = frame.hasBy ? { start: m.tick } : null
  m.badge = { start: m.tick }
  for (const [o, value] of [
    [m.objects, frame.objects],
    [m.ms, frame.ms],
  ] as const) {
    if (o.target === null) settleOdo(o, value)
    else o.target = value
  }
  m.seq = frame.seq
}

/** A draw failed: the dot pulses red, unless Off. */
export function observeError(m: PaneMotion, level: Motion): void {
  if (level !== 'off') m.errorPulse = { start: m.tick }
}

/** The figure as drawn: right-aligned to the width its target takes, so it does not jump while it rolls. */
function odoText(o: Odo): string {
  return String(o.shown).padStart(String(o.target ?? o.shown).length)
}

/** The digit index where two figure texts first differ. */
function firstDiff(before: string, after: string): number {
  let from = 0
  const shorter = Math.min(before.length, after.length)
  while (from < shorter && before[from] === after[from]) from++

  return from
}

function stepOdo(o: Odo, tick: number): void {
  if (o.target === null || o.shown === o.target) return
  const gap = o.target - o.shown
  const step = Math.min(Math.abs(gap), Math.max(1, Math.ceil(Math.abs(gap) / 4)))
  const before = odoText(o)
  o.shown += gap > 0 ? step : -step
  const after = odoText(o)
  o.flash = { from: firstDiff(before, after), until: tick + FLASH_FRAMES, dir: gap > 0 ? 'up' : 'down' }
}

/** One frame on: the tick moves, and on roll ticks every figure steps toward its target, flashing the digits that changed. */
export function advance(m: PaneMotion): void {
  m.tick += 1
  if (m.tick % ROLL_EVERY !== 0) return
  stepOdo(m.objects, m.tick)
  stepOdo(m.ms, m.tick)
}

/** True while the wipe is running. */
export function isWipeActive(m: PaneMotion): boolean {
  return m.wipe !== null && m.tick - m.wipe.start < WIPE_FRAMES
}

const isPulseActive = (p: { start: number } | null, tick: number): boolean =>
  p !== null && tick < p.start + PULSE_LENGTH * PULSE_COUNT

/** True while anything moves: an effect before its end, a figure rolling or flashing, or a draw in flight. */
export function isActive(m: PaneMotion, isRendering: boolean, level: Motion): boolean {
  if (level === 'off') return false
  const t = m.tick
  if (isRendering) return true
  if (isWipeActive(m)) return true
  if (isPulseActive(m.pulse, t) || isPulseActive(m.errorPulse, t)) return true
  if (m.badge !== null && t < m.badge.start + BADGE_FRAMES) return true
  for (const o of [m.objects, m.ms]) {
    if (o.target !== null && o.shown !== o.target) return true
    if (o.flash !== null && t < o.flash.until) return true
  }

  return false
}

/** How far a pulse lightens at this tick: its profile times the level's gain; 0 when none runs. */
function pulseAmount(p: { start: number } | null, tick: number, level: Motion): number {
  if (level === 'off' || !isPulseActive(p, tick) || p === null) return 0

  return (PULSE_PROFILE[(tick - p.start) % PULSE_LENGTH] ?? 0) * PULSE_GAIN[level]
}

/** The picture at `m.tick`: the wipe, then the stale dim, then the shimmer (Lively or Subtle, while Blender draws). */
export function composeImage(
  m: PaneMotion,
  base: Cell[],
  cols: number,
  rows: number,
  state: { isStale: boolean; isRendering: boolean },
  level: Motion,
): Cell[] {
  let cells = base
  const wipe = m.wipe
  if (
    level !== 'off' &&
    wipe !== null &&
    wipe.old !== null &&
    wipe.old.length === base.length &&
    m.tick - wipe.start < WIPE_FRAMES
  ) {
    const old = wipe.old
    const head = Math.floor(((m.tick - wipe.start + 1) * rows) / WIPE_FRAMES) - 1
    cells = base.map((cell, i) => {
      const cy = Math.floor(i / cols)
      if (cy < head) return cell
      if (cy > head) return old[i] ?? cell
      if (level !== 'lively' || cell.cp !== HALF_TOP) return cell

      return {
        cp: cell.cp,
        fg: cell.fg === DEFAULT ? DEFAULT : mixColor(cell.fg, GLINT_UP, WIPE_GLINT),
        bg: cell.bg === DEFAULT ? DEFAULT : mixColor(cell.bg, GLINT_UP, WIPE_GLINT),
      }
    })
  }
  if (state.isStale || state.isRendering) cells = dimCells(cells, STALE_DIM)
  if (level !== 'off' && state.isRendering) cells = shimmerCells(cells, cols, m.tick, SHIMMER_GAIN[level])

  return cells
}

/** The state dot as one cell at `m.tick`. */
export function dotCell(m: PaneMotion, dot: DotState, level: Motion): Cell {
  switch (dot) {
    case 'rendering': {
      const every = level === 'lively' ? SPIN_FRAMES : SPIN_SUBTLE_FRAMES
      const step = level === 'off' ? 0 : Math.floor(m.tick / every) % DOT_SPIN.length

      return { cp: DOT_SPIN[step] ?? DOT_SPIN[0] ?? DOT_FULL, fg: LIVE, bg: DEFAULT }
    }
    case 'idle':
      return { cp: DOT_FULL, fg: LIVE, bg: DEFAULT }
    case 'stale':
      return { cp: DOT_PENDING, fg: LIVE, bg: DEFAULT }
    case 'error':
      return { cp: CROSS, fg: lighten(HOT, pulseAmount(m.errorPulse, m.tick, level)), bg: DEFAULT }
    case 'empty':
      return { cp: DOT_EMPTY, fg: TRACK, bg: DEFAULT }
  }
}

const space = (): Cell => ({ cp: 0x20, fg: DEFAULT, bg: DEFAULT })

/**
 * One placed caption piece as cells: a rolling figure with its changed digits flashing, or the agent label pulsing. The rolled
 * figure is used only while it takes as many digits as the placed one, so a roll never spills into the next cell.
 */
function itemCells(m: PaneMotion, seg: Placed, level: Motion): Cell[] {
  if (seg.role === 'objects' || seg.role === 'ms') {
    const o = seg.role === 'objects' ? m.objects : m.ms
    const digits = /^\d+/.exec(seg.text)?.[0]
    const rolled = odoText(o)
    const text =
      o.target === null || digits === undefined || rolled.length !== digits.length
        ? seg.text
        : rolled + seg.text.slice(digits.length)
    const cells = textCells(text, seg.fg)
    if (level !== 'off' && o.flash !== null && m.tick < o.flash.until) {
      const color = o.flash.dir === 'up' ? GLINT_UP : GLINT_DOWN
      const mix = FLASH_MIX[level]
      cells.forEach((cell, i) => {
        if (o.flash !== null && i >= o.flash.from && cell.cp !== 0x20) cell.fg = mixColor(cell.fg, color, mix)
      })
    }

    return cells
  }
  if (seg.role === 'by') {
    const amount = pulseAmount(m.pulse, m.tick, level)

    return textCells(seg.text, amount > 0 ? lighten(seg.fg, amount) : seg.fg)
  }

  return textCells(seg.text, seg.fg)
}

/**
 * The caption at `m.tick` as `cols * layout.lines` cells, row-major, from spaces: the state dot at line 0, column 1, each
 * placed piece at its place; then, only where it fits after the last piece (two spaces apart), the fresh badge. The badge never
 * adds a line or moves a piece.
 */
export function composeCaption(m: PaneMotion, layout: CaptionLayout, dot: DotState, cols: number, level: Motion): Cell[] {
  const out: Cell[] = Array.from({ length: cols * layout.lines }, space)
  const put = (line: number, col: number, cells: Cell[]): void => {
    cells.forEach((cell, i) => {
      if (col + i < cols) out[line * cols + col + i] = cell
    })
  }
  put(0, 1, [dotCell(m, dot, level)])
  for (const item of layout.items) put(item.line, item.col, itemCells(m, item, level))
  const badge = m.badge
  if (level !== 'off' && badge !== null && m.tick < badge.start + BADGE_FRAMES) {
    const text =
      level === 'lively'
        ? `${String.fromCodePoint(Math.floor((m.tick - badge.start) / TWINKLE_FRAMES) % 2 === 0 ? SPARK_FULL : SPARK_HOLLOW)} fresh`
        : 'fresh'
    const cells = textCells(text, level === 'lively' ? OK_GREEN : PLAIN)
    if (layout.lastEnd + 2 + cells.length <= cols) put(layout.lines - 1, layout.lastEnd + 2, cells)
  }

  return out
}
