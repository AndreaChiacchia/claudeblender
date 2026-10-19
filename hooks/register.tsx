import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { Box as Room, By, Clip, ClipReply, Edit, FailCode, Frame, Pixels, Reply, Settings, ViewKind } from '../types'
import { PEER_COLORS, PLAIN, LIVE, encodeCells } from './cells'
import type { Cell } from './cells'
import {
  agentLabel,
  assignColor,
  captionSegments,
  colorOf,
  labelOf,
  layoutCaption,
  messageOf,
  MAIN_LABEL,
} from './caption'
import type { CaptionInput } from './caption'
import {
  DEMO_AGENT_IDS,
  DEMO_END_MS,
  DEMO_SCENE,
  DEMO_TICK_MS,
  demoEventsAt,
  demoPixels,
} from './demo'
import type { DemoAgent, DemoEvent } from './demo'
import { changesScene } from './edits'
import {
  FRAME_MS,
  advance,
  composeCaption,
  composeImage,
  createPaneMotion,
  dotCell,
  isActive,
  isWipeActive,
  observeError,
  observeFrame,
} from './motion'
import type { DotState, PaneMotion } from './motion'
import { boxFor, fitSize, halfBlockCells, placeFrame } from './pixels'
import { parseClip, parseReply } from './reply'
import { renderScript } from './script'
import type { ScriptParams } from './script'
import {
  MIN_GAP_MS,
  RENDER_TIMEOUT_MS,
  begin,
  byOf,
  createSched,
  dueAt,
  finish,
  isStale,
  markDirty,
  noteEdit,
  noteForce,
} from './schedule'
import { DEFAULT_SETTINGS, normalizeSettings, toolPrefix } from './settings'
import { PRESET_IDS, PRESET_LABELS, chipList, layoutChips, matchView, presetChoice, viewName } from './views'
import type { ViewChoice } from './views'

const PANE = 'blender'
const PANE_TITLE = 'Claude-Blender'
const OPEN_ROWS = 20
const OPEN_COLUMNS = 72
const KEY_IMAGE = 'blender-image'
const KEY_CAPTION = 'blender-caption'
const KEY_DOT = 'blender-dot'
/** Fresh draws whose first blit was refused before the pane is drawn still. */
const MAX_REFUSED_MOUNTS = 3
const DEFAULT_BOX: Room = { cols: 72, rows: 19 }
/** The picture keeps at least this many rows; the chip rows give way first. */
const MIN_IMAGE_ROWS = 6
/** The chip rows never take more than this many rows. */
const MAX_CHIP_ROWS = 3
const DEFAULT_PANE = { cols: 72, bodyRows: 20 }

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
/** The Blender MCP tools that change the scene: a draw follows each. */
const TRIGGER_TOOLS: readonly string[] = ['execute_blender_code', 'import_asset', 'generate_3d']
/** `/blender play` samples at most this many frames of the scene's range. */
const CLIP_FRAMES = 48
/** A capture batch asks for at most this many bytes of RGB: about one full-size frame, which the MCP passes whole. */
const CLIP_BATCH_BYTES = 48_000
/** Where blits are refused, a playing clip is redrawn at most this often (ms). */
const PLAY_REDRAW_MS = 100

type ErrorState = { code: FailCode; message: string; at: number }
/** One Raster of the pane: its key, its width at the render, and its cells now. */
type Piece = { key: string; width: number; compose: () => Cell[] }
/** The mounted Rasters the timer repaints: the render's request and each piece. */
type Site = { requestId: string; pieces: Piece[] }
/** The running `/blender demo`, with the real state it set aside. */
type Demo = {
  ticks: number
  timer: Timer
  isStale: boolean
  saved: { frame: Frame | null; error: ErrorState | null }
}
/** `/blender play`: a capture asked for or under way (`got` of `total` frames so far), or the clip looping since `t0`. */
type Play =
  | { phase: 'capturing'; got: number; total: number | null; isAborted: boolean }
  | { phase: 'playing'; clip: Clip; t0: number; index: number }

/** The /config settings, read in `register`: a module variable, so /clear and /resume keep them. */
let settings: Settings = DEFAULT_SETTINGS

// State of the running module. It is lost on a reload by design: the next Pane draw starts a fresh draw.
// `register` resets it, so a module instance shared by several loads starts each one clean.
let sched = createSched()
let dueTimer: Timer | null = null
let timeoutTimer: Timer | null = null
let flightGen = 0
let settledGen = 0

let frame: Frame | null = null
let error: ErrorState | null = null
let isRendering = false
let box: Room = DEFAULT_BOX
/** The pane's own size as last drawn: only a change of it asks for a resize draw. */
let paneSize = { ...DEFAULT_PANE }
/** The view the pane shows this session: starts as the `view` setting, and the chips and `/blender view` change it. */
let viewChoice: ViewChoice = presetChoice(DEFAULT_SETTINGS.view)
/** The scene's cameras and its active one, from the last reply; `camsKnown` once a reply has carried them. */
let cams: string[] = []
let activeCam = ''
let camsKnown = false
/** The label of each agent that edited, captured while its tool call ran. */
const labels = new Map<string, string>()
/** The share of the pane's size the draw is asked for: halved down to a quarter when Blender's answer is cut. */
let sizeScale = 1
/** The picture as last composed, for the wipe's old rows. */
let lastImage: { cells: Cell[]; cols: number; rows: number } | null = null
/** Minutes east of UTC, for the caption clock. */
let offsetMin = 0

let isPaneOpen = false
let isAutoOpenSuppressed = false
let triedSinceOpen = false
const palette = new Map<string, number>()

let motion: PaneMotion = createPaneMotion()
let frameTimer: Timer | null = null
let site: Site | null = null
/** What each Raster last showed (by key), so an unchanged frame is not sent again. */
const lastBlit = new Map<string, string>()
/** Blits accepted since the last render that drew the Rasters. */
let framesSinceMount = 0
/** Fresh draws whose first blit was refused, while no blit has ever been accepted. */
let refusedMounts = 0
let everBlitted = false
/** Set when this slot keeps refusing the first blit: the pane is drawn still from then on. */
let isStaticFallback = false
let isBlitting = false
let demo: Demo | null = null
let play: Play | null = null
/** Set by `/blender play`: the next flight captures the animation instead of drawing one frame. */
let wantClip = false
/** The clip's frames as half-block cells, made on first show for the box they were made for. */
let clipCells: { cols: number; rows: number; cells: Array<Cell[] | undefined> } | null = null
/** Redraws a playing clip where the slot refuses blits. */
let playRedraw: Timer | null = null

/** The motion level in force: still when the slot refuses blits. */
const levelNow = () => (isStaticFallback ? 'off' : settings.motion)

/** True when edits (or a resize) wait for a draw; under a demo, the demo's own flag. */
const staleNow = (): boolean => (demo !== null ? demo.isStale : isStale(sched))

function dotNow(): DotState {
  if (error !== null) return 'error'
  if (isRendering) return 'rendering'
  if (staleNow()) return 'stale'

  return 'idle'
}

function stopFrameTimer(): void {
  frameTimer?.cancel()
  frameTimer = null
}

function stopDueTimer(): void {
  dueTimer?.cancel()
  dueTimer = null
}

function stopPlayRedraw(): void {
  playRedraw?.cancel()
  playRedraw = null
}

/** The looping clip, or null when none plays. */
const playingNow = (): Extract<Play, { phase: 'playing' }> | null => (play?.phase === 'playing' ? play : null)

/** Which of the clip's frames shows at `now`: real time from its start, each frame for `frameMs`, round and round. */
function clipIndexAt(p: Extract<Play, { phase: 'playing' }>, now: number): number {
  return Math.floor(Math.max(0, now - p.t0) / p.clip.frameMs) % p.clip.frames.length
}

/** The clip's frame `index` as half-block cells in `room`, made once per frame and box. */
function clipFrameCells(clip: Clip, index: number, room: Room): Cell[] {
  if (clipCells === null || clipCells.cols !== room.cols || clipCells.rows !== room.rows) {
    clipCells = { cols: room.cols, rows: room.rows, cells: [] }
  }
  const made = clipCells.cells[index]
  if (made !== undefined) return made
  const f = clip.frames[index]
  const cells = f === undefined ? [] : halfBlockCells(placeFrame(f.pixels, room), room.cols)
  clipCells.cells[index] = cells

  return cells
}

/** The scene frame the caption shows while a clip plays, else null. */
function playFrameNow(): number | null {
  const p = playingNow()

  return p === null ? null : (p.clip.frames[p.index]?.n ?? null)
}

/** Forgets the clip and any capture asked for; a capture under way stops after its batch. */
function forgetPlay(): void {
  if (play?.phase === 'capturing') play.isAborted = true
  play = null
  wantClip = false
  clipCells = null
  stopPlayRedraw()
}

/**
 * Ends `/blender play`. With `redraw`, the current frame is drawn again at once, since the held picture is the clip's first
 * frame (an edit or a view pick that ends it draws by itself). A closed or hidden pane keeps the draw for when it shows.
 */
function stopPlay($: EngineInterface, redraw: boolean): void {
  if (play === null && !wantClip) return
  forgetPlay()
  if (redraw) {
    void (async () => {
      const now = await $.clock.now()
      markDirty(sched, now)
      noteForce(sched, now)
      await arm($)
    })().catch(() => undefined)
  }
  $.ui.invalidate('ui.render')
}

/** Where blits are refused, a playing clip is moved on by redraws instead. */
function kickPlayRedraw($: EngineInterface): void {
  const p = playingNow()
  if (p === null || !isStaticFallback) {
    stopPlayRedraw()

    return
  }
  playRedraw ??= $.clock.every(Math.max(PLAY_REDRAW_MS, p.clip.frameMs), () => $.ui.invalidate('ui.render'))
}

/** Forgets what the module knows of the picture's motion (a load, a new session, a demo's start or end). */
function silencePane(): void {
  motion = createPaneMotion()
  lastImage = null
  stopFrameTimer()
  site = null
}

function resetSession(): void {
  frame = null
  error = null
  isRendering = false
  sched = createSched()
  palette.clear()
  labels.clear()
  viewChoice = presetChoice(settings.view)
  cams = []
  activeCam = ''
  camsKnown = false
  isAutoOpenSuppressed = false
  triedSinceOpen = false
  sizeScale = 1
  stopDueTimer()
  timeoutTimer?.cancel()
  timeoutTimer = null
  forgetPlay()
  silencePane()
}

// ─── The frame and the error ──────────────────────────────────────────────────────────────────────────────────────

type FrameData = {
  pixels: Pixels
  reqPane: { cols: number; bodyRows: number }
  scene: string
  objects: number
  ms: number
  view: ViewKind
  cam: string
  by: By | null
  label: string
  color: number
  at: number
}

const frameOf = (prev: Frame | null, f: FrameData): Frame => ({
  seq: (prev?.seq ?? 0) + 1,
  pixels: f.pixels,
  reqPane: f.reqPane,
  scene: f.scene,
  objects: f.objects,
  ms: f.ms,
  at: f.at,
  view: f.view,
  cam: f.cam,
  by: f.by,
  byLabel: f.label,
  byColor: f.color,
})

/** A new frame is held and its effects start. Real draws and the demo's both come through here. */
function applyFrame(f: FrameData): void {
  const next = frameOf(frame, f)
  const rows = placeFrame(next.pixels, box).rows
  const prevImage =
    lastImage !== null && lastImage.cols === box.cols && lastImage.rows === rows ? lastImage.cells : null
  frame = next
  error = null
  observeFrame(motion, { seq: next.seq, objects: next.objects, ms: next.ms, hasBy: next.by !== null }, prevImage, settings.motion)
}

/** A draw failed: the frame (if any) is kept, and the dot pulses. */
function applyError(code: FailCode, detail: string, at: number): void {
  error = { code, message: messageOf(code, settings.server, detail), at }
  observeError(motion, settings.motion)
}

// ─── The scheduler's driver ───────────────────────────────────────────────────────────────────────────────────────

/** Sets the timer of the next draw from the scheduler: none while a draw is in flight, a demo plays or nothing is stale. */
async function arm($: EngineInterface, minDelay = 0): Promise<void> {
  if (sched.inFlight || demo !== null) return
  const due = dueAt(sched)
  if (due === null) return
  const now = await $.clock.now()
  stopDueTimer()
  dueTimer = $.clock.after(Math.max(minDelay, due - now), () => void startRender($).catch(() => undefined))
}

async function callBlender($: EngineInterface, params: ScriptParams): Promise<Reply> {
  try {
    return parseReply(await $.mcp.call(settings.server, 'execute_blender_code', { code: renderScript(params) }))
  } catch {
    return { kind: 'fail', code: 'no-server', message: '' }
  }
}

const paramsFor = (room: Room): ScriptParams => ({
  maxW: Math.max(8, Math.floor(room.cols * sizeScale)),
  maxH: Math.max(6, Math.floor(room.rows * 2 * sizeScale)),
  view: viewChoice.kind === 'cam' ? 'object' : viewChoice.id,
  cam: viewChoice.kind === 'cam' ? viewChoice.name : '',
  shading: settings.shading,
})

/** The view is picked (a chip, or `/blender view`): a forced draw follows at once, after the one in flight if any. Blender is not changed. */
async function setView($: EngineInterface, choice: ViewChoice): Promise<void> {
  // The view's own draw replaces a playing clip.
  stopPlay($, false)
  viewChoice = choice
  const now = await $.clock.now()
  markDirty(sched, now)
  noteForce(sched, now)
  void arm($).catch(() => undefined)
  // The chip highlight moves at once.
  $.ui.invalidate('ui.render')
}

/** The scene's cameras as the last reply listed them. */
function noteCams(names: string[], active: string): void {
  cams = names
  activeCam = active
  camsKnown = true
}

/** The one place a Blender call starts. It returns at once while another is in flight, so agents editing together coalesce. */
async function startRender($: EngineInterface): Promise<void> {
  dueTimer = null
  if (sched.inFlight || demo !== null) return
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane === undefined) {
    isPaneOpen = false

    return
  }
  // Not drawn yet, or a background tab: the dirt stays, and the Pane hook arms again when it draws.
  if (!pane.isPlaced || !pane.isShown) return
  if (sched.inFlight || demo !== null) return
  const edits = begin(sched)
  isRendering = true
  triedSinceOpen = true
  const gen = ++flightGen
  $.ui.invalidate('ui.render')
  kick($)
  const reqBox: Room = { ...box }
  const reqPane = { ...paneSize }
  timeoutTimer = $.clock.after(
    RENDER_TIMEOUT_MS,
    () => void settle($, gen, { kind: 'fail', code: 'timeout', message: '' }, edits, reqPane).catch(() => undefined),
  )
  const cap = play
  if (wantClip && cap?.phase === 'capturing' && !cap.isAborted) {
    wantClip = false
    await capture($, gen, cap, edits, reqBox, reqPane)

    return
  }
  wantClip = false
  let reply = await callBlender($, paramsFor(reqBox))
  // The MCP layer cut the answer: draw smaller, once more in the same flight, and keep the size for the session.
  if (reply.kind === 'fail' && reply.code === 'truncated' && sizeScale > 0.25 && gen > settledGen) {
    sizeScale /= 2
    reply = await callBlender($, paramsFor(reqBox))
  }
  // The chosen camera is gone: back to the viewport with a toast, and one more draw in the same flight.
  if (reply.kind === 'fail' && reply.code === 'no-such-camera' && viewChoice.kind === 'cam' && gen > settledGen) {
    const name = viewChoice.name
    viewChoice = presetChoice('viewport')
    if (reply.cams !== undefined) noteCams(reply.cams, reply.active ?? '')
    $.ui.toast(`Claude-Blender: the camera "${name}" is gone; showing the viewport.`)
    $.ui.invalidate('ui.render')
    reply = await callBlender($, paramsFor(reqBox))
  }
  await settle($, gen, reply, edits, reqPane)
}

/** A draw ended. A late reply after a timeout, or a timeout after a reply, finds its flight settled and does nothing. */
async function settle(
  $: EngineInterface,
  gen: number,
  reply: Reply,
  edits: Edit[],
  reqPane: { cols: number; bodyRows: number },
): Promise<void> {
  if (!closeFlight(gen)) return
  const now = await $.clock.now()
  if (reply.kind === 'frame') noteCams(reply.cams, reply.active)
  else if (reply.cams !== undefined) noteCams(reply.cams, reply.active ?? '')
  if (reply.kind === 'frame') {
    const held = demo !== null ? demo.saved.frame : frame
    const by = byOf(edits, held?.by ?? null)
    const data: FrameData = {
      pixels: { w: reply.w, h: reply.h, rgb: reply.rgb },
      reqPane,
      scene: reply.scene,
      objects: reply.objects,
      ms: reply.ms,
      view: reply.view,
      cam: reply.cam,
      by,
      label: by === null ? '' : labelOf(by, labels),
      color: by === null ? PLAIN : colorOf(by, palette),
      at: now,
    }
    if (demo !== null) {
      // A draw that was in flight when a demo began: kept for when the demo ends.
      demo.saved.frame = frameOf(demo.saved.frame, data)
      demo.saved.error = null
    } else {
      // A new picture of the scene replaces a playing clip.
      if (playingNow() !== null) forgetPlay()
      applyFrame(data)
    }
  } else if (demo !== null) {
    demo.saved.error = { code: reply.code, message: messageOf(reply.code, settings.server, reply.message), at: now }
  } else {
    applyError(reply.code, reply.message, now)
  }
  afterFlight($)
}

/** Marks flight `gen` settled; false when it already was (a late reply after a timeout, or a timeout after a reply). */
function closeFlight(gen: number): boolean {
  if (gen <= settledGen) return false
  settledGen = gen
  timeoutTimer?.cancel()
  timeoutTimer = null
  isRendering = false
  finish(sched)

  return true
}

/** After a flight: the pane redrawn, its motion kicked, and the follow-up of edits that came meanwhile armed. */
function afterFlight($: EngineInterface): void {
  $.ui.invalidate('ui.render')
  kick($)
  if (isStale(sched)) void arm($, MIN_GAP_MS).catch(() => undefined)
}

async function callClip($: EngineInterface, params: ScriptParams): Promise<ClipReply> {
  try {
    return parseClip(await $.mcp.call(settings.server, 'execute_blender_code', { code: renderScript(params) }))
  } catch {
    return { kind: 'fail', code: 'no-server', message: '' }
  }
}

/**
 * `/blender play`'s flight: the scene's frame range in batches sized to pass the MCP whole (halved when one is cut anyway),
 * each with its own timeout. The first frame becomes the held frame through `settle`, then the clip loops. A capture stopped
 * on the way (an edit, a view pick, /blender play stop, a demo) ends its flight after the batch with nothing shown.
 */
async function capture(
  $: EngineInterface,
  gen: number,
  cap: Extract<Play, { phase: 'capturing' }>,
  edits: Edit[],
  reqBox: Room,
  reqPane: { cols: number; bodyRows: number },
): Promise<void> {
  const params = paramsFor(reqBox)
  let per = Math.max(1, Math.floor(CLIP_BATCH_BYTES / (params.maxW * params.maxH * 3)))
  const frames: Clip['frames'] = []
  let last: Extract<ClipReply, { kind: 'clip' }> | null = null
  let ms = 0
  const fail = (reply: Extract<Reply, { kind: 'fail' }>): Promise<void> => {
    if (play === cap) play = null

    return settle($, gen, reply, edits, reqPane)
  }
  for (;;) {
    timeoutTimer?.cancel()
    timeoutTimer = $.clock.after(
      RENDER_TIMEOUT_MS,
      () => void fail({ kind: 'fail', code: 'timeout', message: '' }).catch(() => undefined),
    )
    const reply = await callClip($, { ...params, clip: { max: CLIP_FRAMES, from: frames.length, count: per } })
    if (gen <= settledGen) return
    if (cap.isAborted || play !== cap) {
      if (closeFlight(gen)) afterFlight($)

      return
    }
    if (reply.kind === 'fail') {
      if (reply.code === 'truncated' && per > 1) {
        per = Math.max(1, Math.floor(per / 2))
        continue
      }
      await fail(reply)

      return
    }
    last = reply
    ms += reply.ms
    for (const f of reply.frames) frames.push({ n: f.n, pixels: { w: reply.w, h: reply.h, rgb: f.rgb } })
    cap.got = frames.length
    cap.total = reply.total
    $.ui.invalidate('ui.render')
    if (reply.frames.length === 0 || frames.length >= reply.total) break
  }
  const first = frames[0]
  if (first === undefined || last === null) {
    await fail({ kind: 'fail', code: 'bad-reply', message: '' })

    return
  }
  await settle(
    $,
    gen,
    {
      kind: 'frame',
      w: last.w,
      h: last.h,
      rgb: first.pixels.rgb,
      scene: last.scene,
      objects: last.objects,
      ms,
      blender: '',
      view: last.view,
      cam: last.cam,
      cams: last.cams,
      active: last.active,
    },
    edits,
    reqPane,
  )
  if (play !== cap || cap.isAborted) return
  if (frames.length < 2) {
    play = null
    $.ui.toast("Claude-Blender: the scene's frame range is a single frame; there is nothing to play.")
    $.ui.invalidate('ui.render')

    return
  }
  const now = await $.clock.now()
  play = {
    phase: 'playing',
    clip: { frames, start: last.start, end: last.end, frameMs: Math.max(FRAME_MS, (1000 * last.step) / last.fps) },
    t0: now,
    index: 0,
  }
  clipCells = null
  $.ui.invalidate('ui.render')
  kick($)
  kickPlayRedraw($)
}

/** An agent (or the person, with /blender refresh) changed the scene: noted, the pane opened if it should be, a draw armed. */
async function onEdit($: EngineInterface, agentId: string | null, tool: string): Promise<void> {
  const at = await $.clock.now()
  noteEdit(sched, { agentId, tool, at })
  // The scene changed under the clip: it stops, and the edit's own draw shows the current frame.
  stopPlay($, false)
  if (agentId !== null) assignColor(palette, agentId)
  // The agent is alive while its tool call runs: its label is taken now, since a short-lived subagent has left the list by the draw.
  if (agentId !== null && !labels.has(agentId)) {
    const listed = await $.agent.list().catch(() => [] as AgentInfo[])
    const agent = listed.find(a => a.id === agentId)
    if (agent !== undefined) labels.set(agentId, agentLabel(agent))
  }
  if (!isPaneOpen && settings.autoOpen && !isAutoOpenSuppressed && demo === null) {
    isPaneOpen = true
    triedSinceOpen = false
    // No focus, no Escape-closes, no held toasts: the pane never takes the keyboard.
    void $.ui.open({ id: PANE, title: PANE_TITLE, rows: OPEN_ROWS, columns: OPEN_COLUMNS }).catch(() => undefined)
  }
  if (isPaneOpen) void arm($).catch(() => undefined)
  // The dot turns stale and the held picture dims.
  $.ui.invalidate('ui.render')
  kick($)
}

// ─── Painting ────────────────────────────────────────────────────────────────────────────────────────────────────

/** True while there is a pane to repaint and something to move in it. */
function needsTimer(): boolean {
  if (site === null || isStaticFallback) return false
  // A playing clip moves under every motion level: it was asked for.
  if (playingNow() !== null) return true

  return settings.motion !== 'off' && isActive(motion, isRendering, settings.motion)
}

function kick($: EngineInterface): void {
  if (frameTimer === null && needsTimer()) frameTimer = $.clock.every(FRAME_MS, () => void step($).catch(() => undefined))
}

/** One frame: the motion advances and each piece that changed is repainted in place. */
async function step($: EngineInterface): Promise<void> {
  if (isBlitting || site === null) return
  isBlitting = true
  try {
    const target = site
    const playing = playingNow()
    if (levelNow() === 'off' && playing === null) {
      stopFrameTimer()

      return
    }
    advance(motion)
    if (playing !== null) playing.index = clipIndexAt(playing, await $.clock.now())
    for (const piece of target.pieces) {
      // While only the shimmer moves the picture it is drawn at 10 fps; a playing clip at its own rate.
      if (piece.key === KEY_IMAGE && playing === null && !isWipeActive(motion) && motion.tick % 2 !== 0) continue
      const cells = piece.compose()
      if (cells.length !== piece.width) {
        // A size change is a redraw, never a blit.
        stopFrameTimer()
        $.ui.invalidate('ui.render')

        return
      }
      const encoded = encodeCells(cells)
      if (encoded === lastBlit.get(piece.key)) continue
      const r = await $.ui.blit({ requestId: target.requestId, key: piece.key, cells: encoded })
      if (r.deny === undefined) {
        everBlitted = true
        framesSinceMount += 1
        lastBlit.set(piece.key, encoded)
        if (piece.key === KEY_IMAGE && lastImage !== null) lastImage = { ...lastImage, cells }
      } else if (framesSinceMount === 0 && !everBlitted) {
        // The first blit after a fresh draw was refused: this slot may not take blits. A fresh mount retries.
        refusedMounts += 1
        stopFrameTimer()
        if (refusedMounts >= MAX_REFUSED_MOUNTS) {
          isStaticFallback = true
          site = null
        }
        $.ui.invalidate('ui.render')

        return
      } else {
        // Refused after earlier successes (a dialog, a resize): a later render restarts the timer.
        stopFrameTimer()

        return
      }
      if (site !== target) return
    }
    if (!needsTimer()) stopFrameTimer()
  } finally {
    isBlitting = false
  }
}

// ─── The demo ────────────────────────────────────────────────────────────────────────────────────────────────────

const DEMO_COLORS: Record<DemoAgent, number> = {
  Claude: LIVE,
  Explore: PEER_COLORS[0] ?? LIVE,
  'general-purpose': PEER_COLORS[1] ?? LIVE,
}

function endDemo($: EngineInterface): void {
  if (demo === null) return
  demo.timer.cancel()
  const { saved } = demo
  demo = null
  silencePane()
  // The real picture comes back silently.
  frame = saved.frame
  error = saved.error
  isRendering = sched.inFlight
  if (frame !== null) {
    observeFrame(motion, { seq: frame.seq, objects: frame.objects, ms: frame.ms, hasBy: false }, null, settings.motion)
  }
  $.ui.invalidate('ui.render')
  if (isStale(sched)) void arm($).catch(() => undefined)
}

function applyDemoEvent($: EngineInterface, event: DemoEvent, now: number): void {
  if (demo === null) return
  if (event.kind === 'rendering') {
    isRendering = true
  } else if (event.kind === 'edit') {
    demo.isStale = true
  } else if (event.kind === 'frame') {
    const { w, h } = fitSize(16 / 9, box.cols, box.rows * 2)
    const agentId = event.agent === 'Claude' ? null : DEMO_AGENT_IDS[event.agent]
    isRendering = false
    demo.isStale = false
    applyFrame({
      pixels: demoPixels(w, h, event.variant),
      reqPane: { ...paneSize },
      scene: DEMO_SCENE,
      objects: event.objects,
      ms: event.ms,
      view: 'viewport',
      cam: '',
      by: { agentId, isRefresh: false, others: event.others },
      label: event.agent === 'Claude' ? MAIN_LABEL : event.agent,
      color: DEMO_COLORS[event.agent],
      at: now,
    })
  } else {
    isRendering = false
    demo.isStale = false
    applyError('offline', '', now)
  }
}

async function onDemoTick($: EngineInterface): Promise<void> {
  if (demo === null) return
  demo.ticks += 1
  const ms = demo.ticks * DEMO_TICK_MS
  if (ms >= DEMO_END_MS) {
    endDemo($)

    return
  }
  const events = demoEventsAt(ms)
  if (events.length === 0) return
  const now = await $.clock.now()
  for (const event of events) applyDemoEvent($, event, now)
  $.ui.invalidate('ui.render')
  kick($)
}

/** Starts the demo, or restarts it from the beginning when one runs. The real frame and error are set aside until it ends. */
function startDemo($: EngineInterface): void {
  // The clip stops; the current frame is drawn once the demo ends.
  stopPlay($, true)
  const saved = demo !== null ? demo.saved : { frame, error }
  demo?.timer.cancel()
  stopDueTimer()
  silencePane()
  frame = null
  error = null
  isRendering = false
  // The demo's frames enter with their effects.
  motion.primed = true
  demo = { ticks: 0, timer: $.clock.every(DEMO_TICK_MS, () => void onDemoTick($).catch(() => undefined)), isStale: false, saved }
  // The tick-0 event: a draw under way.
  applyDemoEvent($, { kind: 'rendering' }, 0)
  $.ui.invalidate('ui.render')
  kick($)
}

// ─── The hooks ───────────────────────────────────────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  settings = normalizeSettings(options)
  // A fresh load starts from a clean state.
  demo?.timer.cancel()
  demo = null
  resetSession()
  flightGen = 0
  settledGen = 0
  box = DEFAULT_BOX
  paneSize = { ...DEFAULT_PANE }
  isPaneOpen = false
  lastBlit.clear()
  framesSinceMount = 0
  refusedMounts = 0
  everBlitted = false
  isStaticFallback = false
  isBlitting = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'blender',
      description: 'Show the live Blender view in a pane; pick a view, refresh, close or demo it',
      argumentHint: '[refresh | view <name> | views | play | play stop | close | demo | demo stop]',
    })
    endDemo($)
    resetSession()
    isPaneOpen = (await $.ui.panes()).some(p => p.id === PANE)
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // Every Blender edit, from the main loop or any subagent (a subagent's tools raise their own `tool.call`), starts a draw.
  // A pass-through observer: `next` first, nothing changed, nothing delayed. The mod's own draws are `mcp.call`s, never `tool.call`s.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const name = String(e.tool)
    const prefix = toolPrefix(settings.server)
    if (name.startsWith(prefix) && ran.deny === undefined) {
      const tool = name.slice(prefix.length)
      // A script that only reads the scene draws nothing, unless the redraw setting says every call.
      const isRead =
        tool === 'execute_blender_code' &&
        settings.redraw === 'edits' &&
        !changesScene((e as unknown as { code?: unknown }).code)
      if (TRIGGER_TOOLS.includes(tool) && !isRead) void onEdit($, e.agentId ?? null, tool).catch(() => undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // The pane closing: a close by the person keeps it closed for the session. This only observes.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      isPaneOpen = false
      if (e.origin.kind === 'person') isAutoOpenSuppressed = true
      // The clip ends with the pane; the next opening draws the current frame.
      stopPlay($, true)
      stopFrameTimer()
      site = null
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'blender' }, async ($, e) => {
    const given = e.args.trim()
    const arg = given.toLowerCase()
    const open = async (): Promise<void> => {
      await $.ui.open({ id: PANE, title: PANE_TITLE, rows: OPEN_ROWS, columns: OPEN_COLUMNS })
      isPaneOpen = true
      isAutoOpenSuppressed = false
      triedSinceOpen = false
    }
    if (arg === '') {
      await open()
      if (isStale(sched)) void arm($).catch(() => undefined)

      return { text: 'Opened the Blender view. It redraws after each Blender edit; /blender refresh draws it now.' }
    }
    if (arg === 'refresh') {
      await open()
      stopPlay($, false)
      const now = await $.clock.now()
      noteEdit(sched, { agentId: null, tool: 'refresh', at: now })
      noteForce(sched, now)
      void arm($).catch(() => undefined)

      return { text: 'Drawing the scene now.' }
    }
    if (arg === 'close') {
      const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
      if (!isOpen) return { text: "The Blender view isn't open." }
      isAutoOpenSuppressed = true
      await $.ui.close({ id: PANE })

      return { text: 'Closed the Blender view.' }
    }
    if (arg === 'demo') {
      await open()
      startDemo($)

      return {
        text:
          "Playing the Blender view demo for 14 s with made-up frames; Blender isn't touched. /blender demo stop ends it." +
          (settings.motion === 'off'
            ? ' Motion is off, so the frames change without effects: set Motion to lively or subtle in /config to see them.'
            : ''),
      }
    }
    if (arg === 'demo stop') {
      if (demo === null) return { text: 'No demo is running.' }
      endDemo($)

      return { text: 'Stopped the demo: the pane shows your Blender scene again.' }
    }
    if (arg === 'play') {
      if (play?.phase === 'capturing') return { text: 'Already capturing the animation; it plays as soon as it is in.' }
      await open()
      endDemo($)
      stopPlay($, false)
      play = { phase: 'capturing', got: 0, total: null, isAborted: false }
      wantClip = true
      const now = await $.clock.now()
      markDirty(sched, now)
      noteForce(sched, now)
      void arm($).catch(() => undefined)
      $.ui.invalidate('ui.render')

      return {
        text: `Capturing the scene's frame range, up to ${CLIP_FRAMES} frames; it then loops in the pane until an edit, a view pick or /blender play stop. Blender's current frame is put back after each batch.`,
      }
    }
    if (arg === 'play stop') {
      if (play === null) return { text: 'Nothing is playing.' }
      stopPlay($, true)

      return { text: 'Stopped the animation: the pane draws the current frame again.' }
    }

    const known = (): string => (camsKnown ? (cams.length > 0 ? cams.join(', ') : 'none') : 'not known until the first draw')
    if (arg === 'views' || arg === 'view') {
      return {
        text: `Views: ${PRESET_IDS.join(', ')}. Cameras in the scene: ${known()}. Showing: ${viewName(viewChoice)}.`,
      }
    }
    if (arg.startsWith('view ')) {
      const rest = given.slice(5).trim()
      const choice = matchView(rest, cams)
      if (choice === null) {
        return {
          text: `No view called "${rest}". Views: ${PRESET_IDS.join(', ')}; cameras: ${cams.length > 0 ? cams.join(', ') : 'none known yet'}.`,
        }
      }
      await open()
      await setView($, choice)

      return {
        text:
          choice.kind === 'preset'
            ? `Showing the ${PRESET_LABELS[choice.id]} view.`
            : `Showing the view through "${choice.name}".`,
      }
    }

    return {
      text: 'Claude-Blender: /blender opens the view, /blender view <name> picks a view (/blender views lists them), /blender refresh draws it now, /blender play loops the animation (/blender play stop ends it), /blender close closes it, /blender demo plays the effects. The settings are in /config.',
    }
  })

  // The pane: the picture in half blocks and a caption under it, or a one-line state.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = await $.clock.now()
    isPaneOpen = true
    if (e.surface !== 'terminal') {
      stopFrameTimer()
      site = null
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          <Text dimColor>The Blender view draws in the terminal only.</Text>
        </Box>
      )
    }
    offsetMin = -new Date(now).getTimezoneOffset()
    paneSize = { cols: e.props.bodyColumns, bodyRows: e.props.scroll?.bodyRows ?? OPEN_ROWS }
    const cols = clamp(paneSize.cols, 8, 160)
    const playing = playingNow()
    if (playing !== null) playing.index = clipIndexAt(playing, now)
    const held = frame
    // The row budget: the caption's lines and the chip rows come out of the body; the picture keeps at least MIN_IMAGE_ROWS.
    const layout = held === null ? null : layoutCaption(captionSegments(captionInputOf(held)), cols)
    const captionLines = layout?.lines ?? 1
    const allowedChips = clamp(paneSize.bodyRows - captionLines - MIN_IMAGE_ROWS, 0, MAX_CHIP_ROWS)
    const chipRows = layoutChips(chipList(viewChoice, cams, activeCam, camsKnown), cols).slice(0, allowedChips)
    box = boxFor(paneSize.cols, paneSize.bodyRows, captionLines + chipRows.length)
    const room = box

    // Draws arm from here only when nothing else will: the first draw, a resize of the pane itself, and edits made while the pane
    // was hidden. A caption or chip row that changes height only rescales the held frame. After a failure only a new edit,
    // a view pick or /blender refresh draws again, so an offline Blender is never polled; such an edit made while the pane
    // was hidden still draws when it shows. A playing clip is rescaled on a resize, never drawn again.
    if (demo === null && !sched.inFlight && dueTimer === null) {
      if (error === null && frame === null && !triedSinceOpen) {
        markDirty(sched, now)
        void arm($).catch(() => undefined)
      } else if (
        error === null &&
        play === null &&
        frame !== null &&
        (frame.reqPane.cols !== paneSize.cols || frame.reqPane.bodyRows !== paneSize.bodyRows)
      ) {
        markDirty(sched, now)
        void arm($).catch(() => undefined)
      } else if (isStale(sched)) {
        void arm($).catch(() => undefined)
      }
    }

    const { Box, Text, Raster, Button } = $.ui.resolve(e)
    const level = levelNow()
    const pieces: Piece[] = []
    lastBlit.clear()
    let body
    if (held !== null && layout !== null) {
      const placed = placeFrame(held.pixels, room)
      const base = halfBlockCells(placed, room.cols)
      const rows = placed.rows
      // While a clip plays the picture is its current frame, the same size as the held one (its first).
      const baseNow = (): Cell[] => {
        const p = playingNow()
        const cells = p === null ? base : clipFrameCells(p.clip, p.index, room)

        return cells.length === base.length ? cells : base
      }
      const captionOf = (): Cell[] => composeCaption(motion, layout, dotNow(), cols, levelNow(), playFrameNow())
      const imageOf = (): Cell[] =>
        composeImage(motion, baseNow(), room.cols, rows, { isStale: staleNow(), isRendering }, levelNow())
      const image = composeImage(motion, baseNow(), room.cols, rows, { isStale: staleNow(), isRendering }, level)
      const caption = composeCaption(motion, layout, dotNow(), cols, level, playFrameNow())
      const imageEncoded = encodeCells(image)
      const captionEncoded = encodeCells(caption)
      pieces.push({ key: KEY_IMAGE, width: room.cols * rows, compose: imageOf })
      pieces.push({ key: KEY_CAPTION, width: cols * layout.lines, compose: captionOf })
      lastBlit.set(KEY_IMAGE, imageEncoded)
      lastBlit.set(KEY_CAPTION, captionEncoded)
      lastImage = { cells: image, cols: room.cols, rows }
      body = (
        <Box flexDirection="column">
          <Raster key={KEY_IMAGE} columns={room.cols} rows={rows} cells={imageEncoded} />
          <Raster key={KEY_CAPTION} columns={cols} rows={layout.lines} cells={captionEncoded} />
        </Box>
      )
    } else if (isRendering) {
      const dotOf = (): Cell[] => [dotCell(motion, 'rendering', levelNow())]
      const dotEncoded = encodeCells(dotOf())
      pieces.push({ key: KEY_DOT, width: 1, compose: dotOf })
      lastBlit.set(KEY_DOT, dotEncoded)
      body = (
        <Box flexDirection="row">
          <Raster key={KEY_DOT} columns={1} rows={1} cells={dotEncoded} />
          <Text dimColor>{play?.phase === 'capturing' ? ' Capturing the animation…' : ' Drawing the Blender scene…'}</Text>
        </Box>
      )
    } else if (error !== null) {
      body = (
        <Box flexDirection="column">
          <Text>
            <Text color="#ff0000">✗ </Text>
            {error.message}
          </Text>
          <Text dimColor>/blender refresh tries again.</Text>
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column">
          <Text dimColor>○ No frame yet.</Text>
          <Text dimColor>Claude's next Blender edit draws the scene here; /blender refresh draws it now.</Text>
        </Box>
      )
    }
    framesSinceMount = 0
    if (pieces.length === 0) {
      stopFrameTimer()
      site = null
    } else {
      site = { requestId: e.requestId, pieces }
      kick($)
    }
    kickPlayRedraw($)

    // The view chips follow the body in every state: the current one bracketed and bright, the others dim, no gap between them.
    const chips = chipRows.map(row => (
      <Box flexDirection="row">
        {row.map(chip => (
          <Button key={chip.key} plain onPress={() => void setView($, chip.choice).catch(() => undefined)}>
            {chip.isCurrent ? (
              <Text color="#afafd7" bold>
                {chip.text}
              </Text>
            ) : (
              <Text dimColor>{chip.text}</Text>
            )}
          </Button>
        ))}
      </Box>
    ))

    return (
      <Box flexDirection="column">
        {body}
        {chips}
      </Box>
    )
  })
}

/** The caption's input for a frame: the failure message too, while the last draw failed, and the clip or its capture. */
function captionInputOf(f: Frame): CaptionInput {
  const p = play
  const first = p?.phase === 'playing' ? p.clip.frames[0] : undefined

  return {
    scene: f.scene,
    objects: f.objects,
    ms: f.ms,
    at: f.at,
    by: f.by === null ? null : { label: f.byLabel, color: f.byColor, others: f.by.others },
    errorMessage: error === null ? null : error.message,
    offsetMin,
    play:
      p === null
        ? null
        : p.phase === 'capturing'
          ? { kind: 'capturing', got: p.got, total: p.total }
          : { kind: 'playing', frame: first?.n ?? p.clip.start, end: p.clip.end },
  }
}
