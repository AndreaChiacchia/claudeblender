import { expect, test } from 'claude-code/testing'

import { MARK_BEGIN, MARK_END, renderScript } from '../hooks/script'
import type { ScriptParams } from '../hooks/script'

const B64 = /base64\.b64decode\('([^']*)'\)/

/** The parameters inside the script's source, decoded the way the Python does: base64, then UTF-8 JSON. */
function paramsIn(code: string): Record<string, unknown> {
  const binary = atob(B64.exec(code)?.[1] ?? '')
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))

  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

const base: ScriptParams = { maxW: 72, maxH: 40, view: 'viewport', cam: '', shading: 'solid' }

test('the script draws offscreen, prints one marked line and restores what it changed', () => {
  const code = renderScript(base)
  for (const part of [
    MARK_BEGIN,
    MARK_END,
    'draw_view3d',
    'finally:',
    'space.shading.type = old_type',
    'space.overlay.show_overlays = old_ov',
    'off.free()',
  ]) {
    expect(code).toContain(part)
  }
  expect(paramsIn(code)).toEqual({ maxW: 72, maxH: 40, ss: 2, view: 'viewport', cam: '', shading: 'solid' })
})

test('the sizes are clamped to 160 x 96 and floored to integers', () => {
  const big = paramsIn(renderScript({ ...base, maxW: 999, maxH: 0, view: 'camera', shading: 'material' }))
  expect(big).toEqual({ maxW: 160, maxH: 1, ss: 2, view: 'camera', cam: '', shading: 'material' })
  const frac = paramsIn(renderScript({ ...base, maxW: 71.9, maxH: 40.2 }))
  expect(frac.maxW).toBe(71)
  expect(frac.maxH).toBe(40)
})

test('a camera name with quotes, a backslash and non-ASCII travels whole as base64 JSON', () => {
  const name = 'Cock"pit\\é'
  const code = renderScript({ ...base, view: 'object', cam: name })
  expect(paramsIn(code)).toEqual({ maxW: 72, maxH: 40, ss: 2, view: 'object', cam: name, shading: 'solid' })
  // Nothing of the name appears in the source itself.
  expect(code).not.toContain('Cock')
})

test('the camera name is cut at 200 characters, and ignored unless the view is a camera object', () => {
  expect((paramsIn(renderScript({ ...base, view: 'object', cam: 'x'.repeat(250) })).cam as string).length).toBe(200)
  expect(paramsIn(renderScript({ ...base, view: 'top', cam: 'Cockpit' })).cam).toBe('')
})

test('the script names its failures and replies, and frames a preset from the scene', () => {
  const code = renderScript({ ...base, view: 'iso' })
  for (const part of ['no-such-camera', 'no-camera', "'cams'", "'active'", 'calc_matrix_camera', 'AXES', '.inverted()', 'visible_get']) {
    expect(code).toContain(part)
  }
})

test('the script assigns no render setting, scene camera or viewport matrix, and sends no user_prompt', () => {
  const code = renderScript(base)
  expect(/render\.\w+\s*=/.test(code)).toBe(false)
  expect(/scene\.camera\s*=/.test(code)).toBe(false)
  expect(/region_3d\.\w+\s*=/.test(code)).toBe(false)
  expect(code).not.toContain('user_prompt')
  expect(code).not.toContain('bpy.ops')
})
