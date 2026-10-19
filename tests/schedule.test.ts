import { expect, test } from 'claude-code/testing'

import {
  begin,
  byOf,
  createSched,
  dueAt,
  finish,
  isStale,
  markDirty,
  noteEdit,
  noteForce,
  MAX_EDITS,
} from '../hooks/schedule'
import type { Edit } from '../types'

const edit = (at: number, agentId: string | null = null, tool = 'execute_blender_code'): Edit => ({ agentId, tool, at })

test('three edits 100 ms apart are due 350 ms after the last', () => {
  const s = createSched()
  expect(dueAt(s)).toBeNull()
  for (const at of [1000, 1100, 1200]) noteEdit(s, edit(at))
  expect(dueAt(s)).toBe(1550)
  expect(isStale(s)).toBe(true)
})

test('a burst never waits past 1.5 s after its first edit', () => {
  const s = createSched()
  for (let at = 0; at <= 3000; at += 200) noteEdit(s, edit(at))
  expect(dueAt(s)).toBe(1500)
})

test('a forced draw is due at once, and a first draw or resize is stale with no edit to credit', () => {
  const s = createSched()
  noteEdit(s, edit(1000))
  noteForce(s, 5000)
  expect(dueAt(s)).toBe(1000)
  const fresh = createSched()
  noteForce(fresh, 5000)
  expect(dueAt(fresh)).toBe(5000)
  const dirty = createSched()
  markDirty(dirty, 700)
  expect(dueAt(dirty)).toBe(1050)
  expect(dirty.edits).toEqual([])
})

test('edits that come while a draw is in flight make the next one due after it ends', () => {
  const s = createSched()
  noteEdit(s, edit(1000))
  const taken = begin(s)
  expect(taken).toEqual([edit(1000)])
  expect(s.inFlight).toBe(true)
  expect(isStale(s)).toBe(false)
  noteEdit(s, edit(1100, 'a1'))
  finish(s)
  expect(s.inFlight).toBe(false)
  expect(isStale(s)).toBe(true)
  expect(dueAt(s)).toBe(1450)
})

test('only the last 20 edits are kept', () => {
  const s = createSched()
  for (let i = 0; i < MAX_EDITS + 5; i++) noteEdit(s, edit(i))
  expect(s.edits.length).toBe(MAX_EDITS)
  expect(s.edits[0]?.at).toBe(5)
})

test('byOf credits the last edit, counts the other agents, and falls back when there is none', () => {
  expect(byOf([edit(1)], null)).toEqual({ agentId: null, isRefresh: false, others: 0 })
  expect(byOf([edit(1, 'a1'), edit(2, 'a2')], null)).toEqual({ agentId: 'a2', isRefresh: false, others: 1 })
  expect(byOf([edit(1, 'a1'), edit(2, 'a1'), edit(3, null), edit(4, 'a2')], null)).toEqual({
    agentId: 'a2',
    isRefresh: false,
    others: 2,
  })
  expect(byOf([edit(1, null, 'refresh')], null)).toEqual({ agentId: null, isRefresh: true, others: 0 })
  expect(byOf([edit(1, 'a1'), edit(2, null, 'refresh')], null)).toEqual({ agentId: null, isRefresh: true, others: 1 })
  const fallback = { agentId: 'a9', isRefresh: false, others: 0 }
  expect(byOf([], fallback)).toBe(fallback)
  expect(byOf([], null)).toBeNull()
})
