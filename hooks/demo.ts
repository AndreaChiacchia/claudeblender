// The motion demo: a timeline of made-up draws and a picture to draw, so the effects can be seen with Blender closed.

import type { Pixels } from '../types'
import { mixColor } from './cells'

/** The demo advances in steps of this many milliseconds. */
export const DEMO_TICK_MS = 100
/** The demo ends here (14 s). */
export const DEMO_END_MS = 14_000

/** The agents of the demo: Explore and general-purpose take the first two subagent colors, Claude the lavender. */
export type DemoAgent = 'Claude' | 'Explore' | 'general-purpose'

export type DemoEvent =
  | { kind: 'rendering' }
  | { kind: 'edit'; agent: DemoAgent }
  | { kind: 'frame'; variant: 0 | 1 | 2; objects: number; ms: number; agent: DemoAgent; others: number }
  | { kind: 'error' }

/** The scene name every demo frame carries. */
export const DEMO_SCENE = 'Demo'

/** What happens when, in ms. */
export const DEMO_TIMELINE: ReadonlyArray<{ at: number; event: DemoEvent }> = [
  { at: 0, event: { kind: 'rendering' } },
  { at: 1200, event: { kind: 'frame', variant: 0, objects: 3, ms: 140, agent: 'Claude', others: 0 } },
  { at: 4000, event: { kind: 'edit', agent: 'Explore' } },
  { at: 4400, event: { kind: 'rendering' } },
  { at: 5400, event: { kind: 'frame', variant: 1, objects: 5, ms: 162, agent: 'Explore', others: 0 } },
  { at: 8000, event: { kind: 'edit', agent: 'general-purpose' } },
  { at: 8400, event: { kind: 'rendering' } },
  { at: 9200, event: { kind: 'error' } },
  { at: 11000, event: { kind: 'rendering' } },
  { at: 11800, event: { kind: 'frame', variant: 2, objects: 7, ms: 171, agent: 'general-purpose', others: 1 } },
]

/** The events whose time is exactly `ms`. */
export function demoEventsAt(ms: number): DemoEvent[] {
  return DEMO_TIMELINE.filter(t => t.at === ms).map(t => t.event)
}

/** The ids the demo's agents are listed under, in the order of the subagent colors. */
export const DEMO_AGENT_IDS: Record<Exclude<DemoAgent, 'Claude'>, string> = {
  Explore: 'demo-explore',
  'general-purpose': 'demo-general-purpose',
}

const SKY_TOP = 0x87afd7
const SKY_HORIZON = 0xd7d7ff
const FLOOR_DARK = 0x585858
const FLOOR_LIGHT = 0x8a8a8a
const SPHERE_X = [0.35, 0.5, 0.65] as const
const SPHERE_COLORS = [0xafafd7, 0xd7af5f, 0x00afaf] as const
const LIGHT = (() => {
  const l = [-0.5, -0.7, 0.5] as const
  const n = Math.hypot(...l)

  return [l[0] / n, l[1] / n, l[2] / n] as const
})()

/** A made-up scene, `w x h`: a sky, a checkered floor and a shaded sphere that moves and changes color with `variant`. */
export function demoPixels(w: number, h: number, variant: 0 | 1 | 2): Pixels {
  const rgb = new Uint8Array(w * h * 3)
  const skyH = Math.round(h * 0.62)
  const cell = Math.max(2, Math.round(w / 12))
  const cx = w * SPHERE_X[variant]
  const cy = h * 0.55
  const radius = 0.22 * Math.min(w, h * 1.6)
  const base = SPHERE_COLORS[variant]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let color: number
      if (y < skyH) {
        color = mixColor(SKY_TOP, SKY_HORIZON, y / Math.max(1, skyH - 1))
      } else {
        color = (Math.floor(x / cell) + Math.floor((y - skyH) / cell)) % 2 === 0 ? FLOOR_DARK : FLOOR_LIGHT
      }
      const nx = (x + 0.5 - cx) / radius
      const ny = (y + 0.5 - cy) / radius
      const d2 = nx * nx + ny * ny
      if (d2 < 1) {
        const nz = Math.sqrt(1 - d2)
        const shade = 0.25 + 0.75 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2])
        const ch = (shift: number): number => Math.min(255, Math.round(((base >> shift) & 0xff) * shade))
        color = (ch(16) << 16) | (ch(8) << 8) | ch(0)
      }
      const i = (y * w + x) * 3
      rgb[i] = (color >> 16) & 0xff
      rgb[i + 1] = (color >> 8) & 0xff
      rgb[i + 2] = color & 0xff
    }
  }

  return { w, h, rgb }
}
