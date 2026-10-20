import { expect, test } from 'claude-code/testing'

import { DEFAULT, HALF_TOP, INK_DARK, WHITE, mixColor } from '../hooks/cells'
import type { Cell } from '../hooks/cells'
import { boxFor, dimCells, fitSize, glowCells, halfBlockCells, placeFrame, scaleNearest } from '../hooks/pixels'
import type { Pixels } from '../types'

/** A picture from colors given as 0xRRGGBB, row-major. */
function pixels(w: number, h: number, colors: number[]): Pixels {
  const rgb = new Uint8Array(w * h * 3)
  colors.forEach((c, i) => {
    rgb[i * 3] = (c >> 16) & 0xff
    rgb[i * 3 + 1] = (c >> 8) & 0xff
    rgb[i * 3 + 2] = c & 0xff
  })

  return { w, h, rgb }
}

const flat = (w: number, h: number, c: number): Pixels => pixels(w, h, new Array<number>(w * h).fill(c))

test('fitSize fits wide, tall and square shapes inside the limits', () => {
  expect(fitSize(2, 72, 40)).toEqual({ w: 72, h: 36 })
  expect(fitSize(0.5, 72, 40)).toEqual({ w: 20, h: 40 })
  expect(fitSize(1, 72, 40)).toEqual({ w: 40, h: 40 })
  expect(fitSize(100, 72, 40)).toEqual({ w: 72, h: 1 })
})

test('scaleNearest keeps a picture as it is and takes the pixel under each center when shrinking', () => {
  const p = pixels(2, 2, [0xff0000, 0x00ff00, 0x0000ff, 0xffffff])
  expect(scaleNearest(p, 2, 2)).toEqual(p)
  const wide = pixels(4, 2, [1, 2, 3, 4, 5, 6, 7, 8])
  const small = scaleNearest(wide, 2, 1)
  // The source pixel under each center: (1, 1) and (3, 1), the colors 6 and 8.
  expect(Array.from(small.rgb)).toEqual([0, 0, 6, 0, 0, 8])
})

test('halfBlockCells: a half block per two pixel rows, letterbox spaces around', () => {
  const p = pixels(2, 2, [0xff0000, 0x00ff00, 0x0000ff, 0xffffff])
  const cells = halfBlockCells({ pixels: p, rows: 1, x0: 1 }, 4)
  expect(cells.length).toBe(4)
  expect(cells[0]).toEqual({ cp: 0x20, fg: DEFAULT, bg: DEFAULT })
  expect(cells[3]).toEqual({ cp: 0x20, fg: DEFAULT, bg: DEFAULT })
  expect(cells[1]).toEqual({ cp: 0x2580, fg: 0xff0000, bg: 0x0000ff })
  expect(cells[2]).toEqual({ cp: 0x2580, fg: 0x00ff00, bg: 0xffffff })
})

test('halfBlockCells: an odd height leaves the last row without a bottom color', () => {
  const p = pixels(1, 3, [0x111111, 0x222222, 0x333333])
  const cells = halfBlockCells({ pixels: p, rows: 2, x0: 0 }, 1)
  expect(cells).toEqual([
    { cp: 0x2580, fg: 0x111111, bg: 0x222222 },
    { cp: 0x2580, fg: 0x333333, bg: DEFAULT },
  ])
})

test('boxFor keeps the reserved rows for the caption and the chips, and clamps', () => {
  expect(boxFor(72, 20, 1)).toEqual({ cols: 72, rows: 19 })
  expect(boxFor(72, 20, 3)).toEqual({ cols: 72, rows: 17 })
  expect(boxFor(500, 500, 3)).toEqual({ cols: 160, rows: 48 })
  expect(boxFor(2, 1, 4)).toEqual({ cols: 8, rows: 3 })
})

test('the glow lightens every picture cell alike toward white, and keeps blanks and a missing bottom pixel', () => {
  const blank: Cell = { cp: 0x20, fg: DEFAULT, bg: DEFAULT }
  const cells: Cell[] = [
    { cp: HALF_TOP, fg: 0x000000, bg: 0x000000 },
    { cp: HALF_TOP, fg: 0x204060, bg: DEFAULT },
    blank,
  ]
  const lit = glowCells(cells, 0.5)
  expect(lit[0]).toEqual({ cp: HALF_TOP, fg: mixColor(0x000000, WHITE, 0.5), bg: mixColor(0x000000, WHITE, 0.5) })
  expect(lit[1]).toEqual({ cp: HALF_TOP, fg: mixColor(0x204060, WHITE, 0.5), bg: DEFAULT })
  expect(lit[2]).toEqual(blank)
})

test('the glow with no amount returns the cells as they are', () => {
  const cells: Cell[] = Array.from({ length: 12 }, () => ({ cp: HALF_TOP, fg: 0x336699, bg: 0x112233 }))
  expect(glowCells(cells, 0)).toBe(cells)
})

test('placeFrame refits when the box shrank or grew, and keeps a frame that touches a limit', () => {
  const shrunk = placeFrame(flat(65, 40, 0x123456), { cols: 72, rows: 10 })
  expect(shrunk.pixels.w).toBe(33)
  expect(shrunk.pixels.h).toBe(20)
  expect(shrunk.rows).toBe(10)
  expect(shrunk.x0).toBe(Math.floor((72 - 33) / 2))
  const grown = placeFrame(flat(10, 6, 0x123456), { cols: 72, rows: 19 })
  expect(grown.pixels.h).toBe(38)
  expect(grown.pixels.w).toBe(63)
  const kept = flat(72, 20, 0x123456)
  expect(placeFrame(kept, { cols: 72, rows: 19 }).pixels).toBe(kept)
  const full = placeFrame(flat(60, 38, 0x123456), { cols: 72, rows: 19 })
  expect(full.pixels.w).toBe(60)
  expect(full.rows).toBe(19)
  expect(full.x0).toBe(6)
})

test('dimCells dims the picture toward the ink and leaves letterbox cells and a missing bottom as they are', () => {
  const blankCell: Cell = { cp: 0x20, fg: DEFAULT, bg: DEFAULT }
  const cells: Cell[] = [blankCell, { cp: HALF_TOP, fg: 0xffffff, bg: DEFAULT }, { cp: HALF_TOP, fg: 0x000000, bg: 0xffffff }]
  const dimmed = dimCells(cells, 0.2)
  expect(dimmed[0]).toBe(blankCell)
  expect(dimmed[1]).toEqual({ cp: HALF_TOP, fg: mixColor(0xffffff, INK_DARK, 0.2), bg: DEFAULT })
  expect(dimmed[2]).toEqual({ cp: HALF_TOP, fg: mixColor(0x000000, INK_DARK, 0.2), bg: mixColor(0xffffff, INK_DARK, 0.2) })
})
