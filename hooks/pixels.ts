import type { Box, Pixels } from '../types'
import { DEFAULT, HALF_TOP, INK_DARK, WHITE, mixColor } from './cells'
import type { Cell } from './cells'

/** The shimmer band moves this many cells a frame (an image frame is every other tick: 10 fps). */
export const SHIMMER_SPEED = 5
/** The band's feathered half-width in diagonal steps: it fades to nothing at this distance, with no hard edge. */
export const SHIMMER_RADIUS = 8
/** The most the band lightens a cell toward white, by motion level. */
export const SHIMMER_GAIN: Record<'lively' | 'subtle', number> = { lively: 0.17, subtle: 0.09 }
/** The stale dim: how far the held frame goes toward the dark ink while Blender draws or edits wait. */
export const STALE_DIM = 0.2

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** The largest `w x h` of `aspect` (width over height) inside `maxW x maxH`: each side at least 1 and at most its max. */
export function fitSize(aspect: number, maxW: number, maxH: number): { w: number; h: number } {
  if (maxW / maxH > aspect) {
    return { w: clamp(Math.round(maxH * aspect), 1, maxW), h: maxH }
  }

  return { w: maxW, h: clamp(Math.round(maxW / aspect), 1, maxH) }
}

/** `p` resampled to `w x h`, each pixel taken from the source pixel under its center. */
export function scaleNearest(p: Pixels, w: number, h: number): Pixels {
  const rgb = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(p.h - 1, Math.floor(((y + 0.5) * p.h) / h))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(p.w - 1, Math.floor(((x + 0.5) * p.w) / w))
      const s = (sy * p.w + sx) * 3
      const d = (y * w + x) * 3
      rgb[d] = p.rgb[s] ?? 0
      rgb[d + 1] = p.rgb[s + 1] ?? 0
      rgb[d + 2] = p.rgb[s + 2] ?? 0
    }
  }

  return { w, h, rgb }
}

/** The room the picture may take in a pane body: `reserved` rows (the caption's lines and the chip rows) are kept for the rest. */
export function boxFor(bodyColumns: number, bodyRows: number, reserved: number): Box {
  return { cols: clamp(bodyColumns, 8, 160), rows: clamp(bodyRows - reserved, 3, 48) }
}

/** The frame as it will be drawn in `box`: refit when it overflows or when the box grew, else as it is, and where it sits. */
export function placeFrame(p: Pixels, box: Box): { pixels: Pixels; rows: number; x0: number } {
  const maxW = box.cols
  const maxH = box.rows * 2
  let pixels = p
  if (p.w > maxW || p.h > maxH || (p.w < maxW && p.h < maxH)) {
    const { w, h } = fitSize(p.w / p.h, maxW, maxH)
    if (w !== p.w || h !== p.h) pixels = scaleNearest(p, w, h)
  }

  return { pixels, rows: Math.ceil(pixels.h / 2), x0: Math.floor((box.cols - pixels.w) / 2) }
}

/** The picture as `cols * rows` cells, row-major: a half block per two pixel rows, blanks around it. */
export function halfBlockCells(placed: { pixels: Pixels; rows: number; x0: number }, cols: number): Cell[] {
  const { pixels, rows, x0 } = placed
  const rgbAt = (x: number, y: number): number => {
    const i = (y * pixels.w + x) * 3

    return ((pixels.rgb[i] ?? 0) << 16) | ((pixels.rgb[i + 1] ?? 0) << 8) | (pixels.rgb[i + 2] ?? 0)
  }
  const cells: Cell[] = []
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = cx - x0
      if (x < 0 || x >= pixels.w) {
        cells.push({ cp: 0x20, fg: DEFAULT, bg: DEFAULT })
        continue
      }
      cells.push({
        cp: HALF_TOP,
        fg: rgbAt(x, 2 * cy),
        bg: 2 * cy + 1 < pixels.h ? rgbAt(x, 2 * cy + 1) : DEFAULT,
      })
    }
  }

  return cells
}

/** The picture toward the dark ink by `amount`; blanks and a missing bottom pixel stay as they are. */
export function dimCells(cells: Cell[], amount: number): Cell[] {
  return cells.map(cell => {
    if (cell.cp !== HALF_TOP) return cell

    return {
      cp: cell.cp,
      fg: cell.fg === DEFAULT ? DEFAULT : mixColor(cell.fg, INK_DARK, amount),
      bg: cell.bg === DEFAULT ? DEFAULT : mixColor(cell.bg, INK_DARK, amount),
    }
  })
}

/**
 * A soft diagonal band crossing the picture: `tick` moves its head `SHIMMER_SPEED` cells a frame, and the band fades out
 * over `SHIMMER_RADIUS` steps on a smoothstep (flat at its center, no visible edge). `gain` is its peak lightening.
 */
export function shimmerCells(cells: Cell[], cols: number, tick: number, gain: number): Cell[] {
  const rows = Math.ceil(cells.length / cols)
  const head = ((tick * SHIMMER_SPEED) % (cols + 2 * rows + 2 * SHIMMER_RADIUS)) - SHIMMER_RADIUS

  return cells.map((cell, i) => {
    const cx = i % cols
    const cy = Math.floor(i / cols)
    const x = Math.abs(cx + 2 * cy - head) / SHIMMER_RADIUS
    const amount = x >= 1 ? 0 : gain * (1 - x * x * (3 - 2 * x))
    if (amount <= 0) return cell

    return {
      cp: cell.cp,
      fg: cell.fg === DEFAULT ? DEFAULT : mixColor(cell.fg, WHITE, amount),
      bg: cell.bg === DEFAULT ? DEFAULT : mixColor(cell.bg, WHITE, amount),
    }
  })
}
