import type { Motion, Settings } from '../types'
import { PRESET_IDS } from './views'

export const DEFAULT_SETTINGS: Settings = {
  autoOpen: true,
  view: 'viewport',
  shading: 'solid',
  motion: 'lively',
  redraw: 'edits',
  server: 'blender',
}

/** `value` when it is one of `options`, else `fallback`. */
function pick<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback
}

/** The /config values as the module uses them: each falls back to its default when it is not one of its options. */
export function normalizeSettings(options: Record<string, unknown>): Settings {
  return {
    autoOpen: options.autoOpen !== 'off',
    view: pick(options.view, PRESET_IDS, DEFAULT_SETTINGS.view),
    shading: pick(options.shading, ['solid', 'material'] as const, DEFAULT_SETTINGS.shading),
    motion: pick<Motion>(options.motion, ['lively', 'subtle', 'off'], DEFAULT_SETTINGS.motion),
    redraw: pick(options.redraw, ['edits', 'every'] as const, DEFAULT_SETTINGS.redraw),
    server: String(options.server ?? '').trim() || 'blender',
  }
}

/** The tool-name prefix of a server's tools: `claude.ai X` gives `mcp__claude_ai_X__`. */
export function toolPrefix(server: string): string {
  return 'mcp__' + server.replace(/[^A-Za-z0-9_-]/g, '_') + '__'
}
