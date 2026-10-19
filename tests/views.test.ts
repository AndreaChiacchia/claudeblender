import { expect, test } from 'claude-code/testing'

import { chipList, layoutChips, matchView, presetChoice, viewName } from '../hooks/views'
import type { Chip, ViewChoice } from '../hooks/views'

const VIEWPORT = presetChoice('viewport')

const rowText = (row: Chip[]): string => row.map(c => c.text).join('')

test('chipList: the presets in order, then one chip per camera; the current one is bracketed', () => {
  const chips = chipList(VIEWPORT, ['Cockpit', 'Chase'], 'Camera', true)
  expect(chips.map(c => c.key)).toEqual([
    'view-viewport',
    'view-camera',
    'view-top',
    'view-bottom',
    'view-front',
    'view-back',
    'view-left',
    'view-right',
    'view-iso',
    'view-cam-Cockpit',
    'view-cam-Chase',
  ])
  expect(chips.map(c => c.text)).toEqual([
    '[Viewport]',
    ' Camera ',
    ' Top ',
    ' Bottom ',
    ' Front ',
    ' Back ',
    ' Left ',
    ' Right ',
    ' ¾ ',
    ' ▸Cockpit ',
    ' ▸Chase ',
  ])
  expect(chips.filter(c => c.isCurrent).map(c => c.key)).toEqual(['view-viewport'])
  expect(chips.every(c => c.width === Array.from(c.text).length)).toBe(true)
  const top = chipList(presetChoice('top'), [], '', false).find(c => c.isCurrent)
  expect(top?.text).toBe('[Top]')
  const cockpit = chipList({ kind: 'cam', name: 'Cockpit' }, ['Cockpit'], 'Camera', true).find(c => c.isCurrent)
  expect(cockpit?.text).toBe('[▸Cockpit]')
  expect(cockpit?.choice).toEqual({ kind: 'cam', name: 'Cockpit' })
})

test('chipList: the camera chip is left out when the scene has no active camera, unless it is the current view', () => {
  expect(chipList(VIEWPORT, [], '', true).some(c => c.key === 'view-camera')).toBe(false)
  expect(chipList(VIEWPORT, [], '', false).some(c => c.key === 'view-camera')).toBe(true)
  expect(chipList(presetChoice('camera'), [], '', true).some(c => c.key === 'view-camera')).toBe(true)
})

test('chipList: a current camera that is no longer listed keeps its chip, last; a long name is cut to 16', () => {
  const chips = chipList({ kind: 'cam', name: 'Gone' }, ['Cockpit'], 'Camera', true)
  expect(chips.at(-1)?.key).toBe('view-cam-Gone')
  expect(chips.at(-1)?.isCurrent).toBe(true)
  const long = chipList(VIEWPORT, ['A'.repeat(30)], 'Camera', true).at(-1)
  expect(long?.text).toBe(' ▸' + 'A'.repeat(15) + '… ')
})

test('layoutChips: 40 columns give two rows with no gaps between chips', () => {
  const chips = chipList(VIEWPORT, ['Cockpit', 'Chase'], 'Camera', true)
  const rows = layoutChips(chips, 40)
  expect(rows.map(rowText)).toEqual(['[Viewport] Camera  Top  Bottom  Front ', ' Back  Left  Right  ¾  ▸Cockpit  ▸Chase '])
  expect(layoutChips(chips, 72).length).toBe(2)
  expect(layoutChips(chips.slice(0, 9), 72).map(rowText)).toEqual(['[Viewport] Camera  Top  Bottom  Front  Back  Left  Right  ¾ '])
})

test('layoutChips: a chip wider than a row is cut to the row', () => {
  const rows = layoutChips(chipList(VIEWPORT, ['A'.repeat(16)], 'Camera', true).slice(-1), 6)
  expect(rows.length).toBe(1)
  expect(Array.from(rowText(rows[0] ?? [])).length).toBe(6)
  expect(rowText(rows[0] ?? []).endsWith('…')).toBe(true)
})

test('matchView: presets by id or label, aliases, in any case', () => {
  expect(matchView('top', [])).toEqual(presetChoice('top'))
  expect(matchView('TOP', [])).toEqual(presetChoice('top'))
  expect(matchView('Viewport', [])).toEqual(presetChoice('viewport'))
  expect(matchView('iso', [])).toEqual(presetChoice('iso'))
  for (const alias of ['3/4', '¾', 'three-quarter']) expect(matchView(alias, [])).toEqual(presetChoice('iso'))
  for (const alias of ['cam', 'scene camera', 'camera']) expect(matchView(alias, [])).toEqual(presetChoice('camera'))
})

test('matchView: cameras by exact name, ignoring case, or a unique prefix; an ambiguous one is no view', () => {
  const cams = ['Cockpit', 'Chase', 'Chase2']
  const cam = (name: string): ViewChoice => ({ kind: 'cam', name })
  expect(matchView('Cockpit', cams)).toEqual(cam('Cockpit'))
  expect(matchView('cockpit', cams)).toEqual(cam('Cockpit'))
  expect(matchView('▸Cockpit', cams)).toEqual(cam('Cockpit'))
  expect(matchView('coc', cams)).toEqual(cam('Cockpit'))
  expect(matchView('Chase', cams)).toEqual(cam('Chase'))
  expect(matchView('cha', cams)).toBeNull()
  expect(matchView('nope', cams)).toBeNull()
  expect(matchView('   ', cams)).toBeNull()
})

test('viewName names a preset by id and a camera with its name', () => {
  expect(viewName(presetChoice('iso'))).toBe('iso')
  expect(viewName({ kind: 'cam', name: 'Cockpit' })).toBe('camera "Cockpit"')
})
