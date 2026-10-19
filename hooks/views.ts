// The views the pane can show: ids, chip labels and rows, and how `/blender view <name>` is matched. Pure.

/** The views Blender is not needed to name: the viewport, the scene camera and straight-on orthographic presets. */
export const PRESET_IDS = ['viewport', 'camera', 'top', 'bottom', 'front', 'back', 'left', 'right', 'iso'] as const
export type PresetId = (typeof PRESET_IDS)[number]

/** The chip text of each preset (`¾` is U+00BE, one cell). */
export const PRESET_LABELS: Record<PresetId, string> = {
  viewport: 'Viewport',
  camera: 'Camera',
  top: 'Top',
  bottom: 'Bottom',
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  iso: '¾',
}

/** What the pane shows: a preset, or the camera object of that name. */
export type ViewChoice = { kind: 'preset'; id: PresetId } | { kind: 'cam'; name: string }

export const presetChoice = (id: PresetId): ViewChoice => ({ kind: 'preset', id })

/** The view's name for a message: `top`, `iso`, `camera "Cockpit"`. */
export function viewName(c: ViewChoice): string {
  return c.kind === 'preset' ? c.id : `camera "${c.name}"`
}

/** A camera chip's name is cut at this many characters. */
export const MAX_CHIP_LABEL = 16
/** Marks a camera chip. */
export const CAM_MARK = '▸'

/** One chip of the view row: its address, its text (padded, or bracketed when current) and what it picks. */
export type Chip = { key: string; text: string; width: number; choice: ViewChoice; isCurrent: boolean }

const widthOf = (text: string): number => Array.from(text).length

/** `text` cut to `max` characters, the last one an ellipsis when it was cut. */
function cut(text: string, max: number): string {
  const chars = Array.from(text)

  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…'
}

function chipOf(key: string, label: string, choice: ViewChoice, isCurrent: boolean): Chip {
  const text = isCurrent ? `[${label}]` : ` ${label} `

  return { key, text, width: widthOf(text), choice, isCurrent }
}

/**
 * The chips in order: the presets (the camera one left out when the scene is known to have no active camera, unless it is
 * the current view), then one per camera of the scene. A current camera that is no longer listed keeps a chip, last.
 */
export function chipList(choice: ViewChoice, cams: readonly string[], activeCam: string, camsKnown: boolean): Chip[] {
  const chips: Chip[] = []
  for (const id of PRESET_IDS) {
    const isCurrent = choice.kind === 'preset' && choice.id === id
    if (id === 'camera' && camsKnown && activeCam === '' && !isCurrent) continue
    chips.push(chipOf(`view-${id}`, PRESET_LABELS[id], presetChoice(id), isCurrent))
  }
  const named = choice.kind === 'cam' && !cams.includes(choice.name) ? [...cams, choice.name] : cams
  for (const name of named) {
    chips.push(
      chipOf(`view-cam-${name}`, CAM_MARK + cut(name, MAX_CHIP_LABEL), { kind: 'cam', name }, choice.kind === 'cam' && choice.name === name),
    )
  }

  return chips
}

/** The chips in rows of at most `cols` cells, with no gap between chips; a chip wider than a row is cut to it. */
export function layoutChips(chips: Chip[], cols: number): Chip[][] {
  const rows: Chip[][] = []
  let row: Chip[] = []
  let used = 0
  for (const original of chips) {
    let chip = original
    if (chip.width > cols) {
      const text = cut(chip.text, Math.max(1, cols))
      chip = { ...chip, text, width: widthOf(text) }
    }
    if (row.length > 0 && used + chip.width > cols) {
      rows.push(row)
      row = []
      used = 0
    }
    row.push(chip)
    used += chip.width
  }
  if (row.length > 0) rows.push(row)

  return rows
}

const ALIASES: Record<string, PresetId> = {
  '3/4': 'iso',
  '¾': 'iso',
  'three-quarter': 'iso',
  cam: 'camera',
  'scene camera': 'camera',
}

/** The view a `/blender view <input>` names: a preset (id, label or alias), else a camera by exact name, name ignoring case, or a unique prefix. */
export function matchView(input: string, cams: readonly string[]): ViewChoice | null {
  let s = input.trim()
  if (s.startsWith(CAM_MARK)) s = s.slice(CAM_MARK.length).trim()
  const low = s.toLowerCase()
  if (low === '') return null
  for (const id of PRESET_IDS) {
    if (low === id || low === PRESET_LABELS[id].toLowerCase()) return presetChoice(id)
  }
  const alias = ALIASES[low]
  if (alias !== undefined) return presetChoice(alias)
  const exact = cams.find(n => n === s)
  if (exact !== undefined) return { kind: 'cam', name: exact }
  const loose = cams.filter(n => n.toLowerCase() === low)
  if (loose.length === 1 && loose[0] !== undefined) return { kind: 'cam', name: loose[0] }
  const prefixed = cams.filter(n => n.toLowerCase().startsWith(low))
  if (prefixed.length === 1 && prefixed[0] !== undefined) return { kind: 'cam', name: prefixed[0] }

  return null
}
