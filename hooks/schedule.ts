import type { By, Edit, Sched } from '../types'

/** A draw waits this long after the last edit, so a burst of edits is one draw. */
export const DEBOUNCE_MS = 350
/** A draw is due this long after the first edit of a burst, however long the burst goes on. */
export const MAX_WAIT_MS = 1500
/** The least gap before the follow-up draw of edits that came in while one was in flight. */
export const MIN_GAP_MS = 150
/** Blender gets this long to answer before the draw is given up. */
export const RENDER_TIMEOUT_MS = 20_000
/** The edits kept for the caption's attribution. */
export const MAX_EDITS = 20

export function createSched(): Sched {
  return { inFlight: false, firstDirtyAt: null, lastEditAt: null, edits: [], force: false }
}

/** An edit by an agent: it makes the picture stale and starts or extends the debounce. */
export function noteEdit(s: Sched, edit: Edit): void {
  s.lastEditAt = edit.at
  s.firstDirtyAt ??= edit.at
  s.edits.push(edit)
  if (s.edits.length > MAX_EDITS) s.edits.splice(0, s.edits.length - MAX_EDITS)
}

/** A draw that must not wait: `/blender refresh`. */
export function noteForce(s: Sched, now: number): void {
  s.force = true
  s.firstDirtyAt ??= now
  s.lastEditAt ??= now
}

/** The picture is stale with no edit to credit: a first draw or a resize. */
export function markDirty(s: Sched, now: number): void {
  s.firstDirtyAt ??= now
  s.lastEditAt ??= now
}

/** When the next draw is due (ms), or null when nothing is stale. */
export function dueAt(s: Sched): number | null {
  if (s.firstDirtyAt === null) return null
  if (s.force) return s.firstDirtyAt

  return Math.min((s.lastEditAt ?? s.firstDirtyAt) + DEBOUNCE_MS, s.firstDirtyAt + MAX_WAIT_MS)
}

/** A draw starts: the edits it will show are taken, and what comes in from now on is for the next one. */
export function begin(s: Sched): Edit[] {
  const edits = s.edits
  s.edits = []
  s.firstDirtyAt = null
  s.lastEditAt = null
  s.force = false
  s.inFlight = true

  return edits
}

/** The draw ended, whatever came of it. */
export function finish(s: Sched): void {
  s.inFlight = false
}

/** True when edits (or a resize) came since the last draw started. */
export function isStale(s: Sched): boolean {
  return s.firstDirtyAt !== null
}

const MAIN_KEY = '\u0000main'
const keyOf = (agentId: string | null): string => agentId ?? MAIN_KEY

/**
 * Who a frame is credited to: the agent of the last edit, and how many other agents edited in the list.
 * A refresh edit is the person's: it is credited as `isRefresh` and never counts as another agent.
 */
export function byOf(edits: Edit[], fallback: By | null): By | null {
  const last = edits[edits.length - 1]
  if (last === undefined) return fallback
  const isRefresh = last.tool === 'refresh'
  const others = new Set<string>()
  for (const edit of edits) {
    if (edit.tool === 'refresh') continue
    if (!isRefresh && keyOf(edit.agentId) === keyOf(last.agentId)) continue
    others.add(keyOf(edit.agentId))
  }

  return { agentId: last.agentId, isRefresh, others: others.size }
}
