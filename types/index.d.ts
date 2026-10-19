/** How the pane moves: `lively`, `subtle`, or not at all. */
export type Motion = 'lively' | 'subtle' | 'off'

/** A view the pane can show: Blender's viewport, the scene camera, or a straight-on orthographic preset. */
export type PresetId = 'viewport' | 'camera' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso'

/** What a draw was asked for: a preset, or `object` (through the camera object named by `cam`). */
export type ViewKind = PresetId | 'object'

/** The /config settings, normalized. */
export type Settings = {
  autoOpen: boolean
  view: PresetId
  shading: 'solid' | 'material'
  motion: Motion
  server: string
}

/** One Blender edit: who made it (null: the main loop), with which tool, and when (ms). `tool` is `refresh` for /blender refresh. */
export type Edit = { agentId: string | null; tool: string; at: number }

/** The debounce and single-flight state of the draw scheduler. */
export type Sched = {
  inFlight: boolean
  firstDirtyAt: number | null
  lastEditAt: number | null
  edits: Edit[]
  force: boolean
}

/** Who a frame is credited to: the agent of the last edit, and how many other agents edited since the last draw. */
export type By = { agentId: string | null; isRefresh: boolean; others: number }

/** Why a draw did not give a frame. */
export type FailCode =
  | 'offline'
  | 'no-server'
  | 'no-view3d'
  | 'no-camera'
  | 'no-such-camera'
  | 'too-old'
  | 'timeout'
  | 'truncated'
  | 'bad-reply'
  | 'error'

/** What Blender's answer to the draw script was, parsed. */
export type Reply =
  | {
      kind: 'frame'
      w: number
      h: number
      rgb: Uint8Array
      scene: string
      objects: number
      ms: number
      blender: string
      view: ViewKind
      /** The camera object the draw went through (`view: 'object'`), else ''. */
      cam: string
      /** The scene's camera objects by name, at most 24. */
      cams: string[]
      /** The scene's active camera, '' when none. */
      active: string
    }
  | { kind: 'fail'; code: FailCode; message: string; cams?: string[]; active?: string }

/** A picture: `w * h` pixels of r, g, b bytes, row-major, top row first. */
export type Pixels = { w: number; h: number; rgb: Uint8Array }

/** The most the picture may take in the pane: terminal columns, and picture rows (two pixels each). */
export type Box = { cols: number; rows: number }

/** The held frame: the picture and what the caption says of it. */
export type Frame = {
  seq: number
  pixels: Pixels
  /** The pane's own size when the draw was asked: a change of it, and only that, asks for a resize draw. */
  reqPane: { cols: number; bodyRows: number }
  scene: string
  objects: number
  ms: number
  at: number
  view: ViewKind
  cam: string
  by: By | null
  byLabel: string
  byColor: number
}
