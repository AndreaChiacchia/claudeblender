import { expect, test } from 'claude-code/testing'

import { PEER_COLORS } from '../hooks/cells'
import { DEMO_END_MS, DEMO_TIMELINE, DEMO_TICK_MS, demoEventsAt, demoPixels } from '../hooks/demo'
import { fitSize } from '../hooks/pixels'

const at = (p: { w: number; rgb: Uint8Array }, x: number, y: number): [number, number, number] => {
  const i = (y * p.w + x) * 3

  return [p.rgb[i] ?? 0, p.rgb[i + 1] ?? 0, p.rgb[i + 2] ?? 0]
}

test('demoPixels is the size asked for, with the sky color at the top row', () => {
  const { w, h } = fitSize(16 / 9, 72, 38)
  const p = demoPixels(w, h, 0)
  expect([p.w, p.h, p.rgb.length]).toEqual([w, h, w * h * 3])
  expect(at(p, 0, 0)).toEqual([0x87, 0xaf, 0xd7])
  // The floor: the checker's two grays.
  const grays = new Set<string>()
  for (let x = 0; x < w; x++) grays.add(at(p, x, h - 1).join(','))
  expect(grays).toEqual(new Set(['88,88,88', '138,138,138']))
})

test('the sphere moves and changes color with the variant', () => {
  const w = 68
  const h = 38
  const centre = (variant: 0 | 1 | 2) => at(demoPixels(w, h, variant), Math.round(w * [0.35, 0.5, 0.65][variant]!), Math.round(h * 0.55))
  const [r0, g0, b0] = centre(0)
  expect(r0).toBe(g0)
  expect(b0).toBeGreaterThan(r0)
  const [r1, g1, b1] = centre(1)
  expect(r1).toBeGreaterThan(g1)
  expect(g1).toBeGreaterThan(b1)
  const [r2, g2, b2] = centre(2)
  expect(r2).toBe(0)
  expect(g2).toBeGreaterThan(0)
  expect(b2).toBe(g2)
  // The sphere has moved: where variant 0 has its centre, variant 1 has the sphere's edge, not the same pixel.
  expect(at(demoPixels(w, h, 1), Math.round(w * 0.35), Math.round(h * 0.55))).not.toEqual(centre(0))
})

test('the timeline is in order, and ends at 14 s', () => {
  const times = DEMO_TIMELINE.map(t => t.at)
  expect(times).toEqual([...times].sort((a, b) => a - b))
  expect(times.every(t => t % DEMO_TICK_MS === 0 && t < DEMO_END_MS)).toBe(true)
  expect(DEMO_END_MS).toBe(14_000)
  expect(demoEventsAt(0)).toEqual([{ kind: 'rendering' }])
  expect(demoEventsAt(1300)).toEqual([])
  expect(demoEventsAt(1200)).toEqual([{ kind: 'frame', variant: 0, objects: 3, ms: 140, agent: 'Claude', others: 0 }])
  expect(demoEventsAt(9200)).toEqual([{ kind: 'error' }])
  expect(demoEventsAt(11800)).toEqual([{ kind: 'frame', variant: 2, objects: 7, ms: 171, agent: 'general-purpose', others: 1 }])
  expect(PEER_COLORS.length).toBeGreaterThanOrEqual(2)
})
