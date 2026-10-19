import { expect, test } from 'claude-code/testing'

import { DEFAULT_SETTINGS, normalizeSettings, toolPrefix } from '../hooks/settings'

test('the defaults', () => {
  expect(DEFAULT_SETTINGS).toEqual({
    autoOpen: true,
    view: 'viewport',
    shading: 'solid',
    motion: 'lively',
    redraw: 'edits',
    server: 'blender',
  })
  expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
})

test('values are taken, and an unknown one falls back to its default', () => {
  expect(normalizeSettings({ autoOpen: 'off', view: 'camera', shading: 'material', motion: 'subtle', redraw: 'every' })).toEqual({
    autoOpen: false,
    view: 'camera',
    shading: 'material',
    motion: 'subtle',
    redraw: 'every',
    server: 'blender',
  })
  expect(normalizeSettings({ autoOpen: 'maybe', view: 'x', shading: 3, motion: 'wild', redraw: 'never' })).toEqual(DEFAULT_SETTINGS)
})

test('every view preset is a valid value of the view setting', () => {
  for (const view of ['viewport', 'camera', 'top', 'bottom', 'front', 'back', 'left', 'right', 'iso']) {
    expect(normalizeSettings({ view }).view).toBe(view)
  }
  expect(normalizeSettings({ view: 'object' }).view).toBe('viewport')
})

test('the server is trimmed and defaults to blender', () => {
  expect(normalizeSettings({ server: '  my blender ' }).server).toBe('my blender')
  expect(normalizeSettings({ server: '   ' }).server).toBe('blender')
})

test('the tool prefix follows the engine spelling of the server', () => {
  expect(toolPrefix('blender')).toBe('mcp__blender__')
  expect(toolPrefix('claude.ai X')).toBe('mcp__claude_ai_X__')
})
