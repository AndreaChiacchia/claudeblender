import type { By, FailCode } from '../types'
import { HOT, LIVE, PEER_COLORS, PLAIN } from './cells'

export const MAIN_LABEL = 'Claude'
export const REFRESH_LABEL = 'you'
export const UNKNOWN_LABEL = 'subagent'
export const MAX_LABEL = 20
/** The scene name is cut at this many characters. */
export const MAX_SCENE = 24
/** An error is cut at this many characters in the caption (it wraps over up to three lines first). */
export const MAX_SHORT = 120

/** `text` cut to `max` characters, the last one an ellipsis when it was cut. */
function cut(text: string, max: number): string {
  const chars = Array.from(text)

  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…'
}

/** The label a listed agent is credited under: its name, else its type, cut to 20 characters. */
export function agentLabel(agent: { type: string; name?: string }): string {
  return cut(agent.name ?? agent.type, MAX_LABEL)
}

/**
 * The name an edit is credited to: Claude for the main loop, the person for a refresh, else the label captured while the
 * agent's tool call ran (an agent never captured, such as a workflow agent, is `subagent`).
 */
export function labelOf(by: By, labels: ReadonlyMap<string, string>): string {
  if (by.isRefresh) return REFRESH_LABEL
  if (by.agentId === null) return MAIN_LABEL

  return labels.get(by.agentId) ?? UNKNOWN_LABEL
}

/** The color of the next subagent: the palette's slots in first-seen order, wrapping after four. Idempotent per id. */
export function assignColor(palette: Map<string, number>, agentId: string): number {
  const have = palette.get(agentId)
  if (have !== undefined) return have
  const color = PEER_COLORS[palette.size % PEER_COLORS.length] ?? LIVE
  palette.set(agentId, color)

  return color
}

/** The color of an edit's agent: lavender for the main loop, gray for the person, a palette slot for a subagent. */
export function colorOf(by: By, palette: Map<string, number>): number {
  if (by.isRefresh) return PLAIN
  if (by.agentId === null) return LIVE

  return assignColor(palette, by.agentId)
}

const two = (n: number): string => String(n).padStart(2, '0')

/** `HH:MM:SS`, 24 h, of `at` (ms since the epoch) shifted by `offsetMin` minutes, read in UTC fields. */
export function clockText(at: number, offsetMin: number): string {
  const d = new Date(at + offsetMin * 60_000)

  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`
}

/** What the pane says of a failed draw. */
export function messageOf(code: FailCode, server: string, detail: string): string {
  switch (code) {
    case 'offline':
      return "Blender isn't reachable. Start Blender with its MCP add-on connected, then /blender refresh."
    case 'no-server':
      return `The MCP server "${server}" isn't connected. Check /mcp, or the Blender MCP server setting in /config.`
    case 'no-view3d':
      return 'Blender has no 3D Viewport open to draw from.'
    case 'no-camera':
      return 'The scene has no camera. Add one, or set View to viewport in /config.'
    case 'no-such-camera':
      return `The camera "${detail}" is gone; showing the viewport.`
    case 'too-old':
      return `This needs Blender 3.0 or later (found ${detail}).`
    case 'timeout':
      return 'Blender took longer than 20 s to answer.'
    case 'truncated':
    case 'bad-reply':
      return "Blender's answer could not be read."
    case 'error':
      return detail === '' ? 'The draw failed.' : `The draw failed: ${detail}`
  }
}

/** A message cut at 120 characters (119 plus an ellipsis). */
export function shortOf(message: string): string {
  return cut(message, MAX_SHORT)
}

/** A piece of the caption: its text and color; `role` marks the pieces the motion changes (`play`: the clip's frame number). */
export type Segment = { text: string; fg: number; role?: 'by' | 'objects' | 'ms' | 'play' }

/** Marks the playing clip's piece. */
export const PLAY_MARK = '▶'

/** The playing clip's piece: `▶ 25/60`, the frame number padded to the width of the last frame's so the piece never moves. */
export function playText(frame: number, end: number): string {
  return `${PLAY_MARK} ${String(frame).padStart(String(end).length)}/${end}`
}

export type CaptionInput = {
  scene: string
  objects: number
  ms: number
  /** When the frame was drawn (ms). */
  at: number
  /** Who made the edit; null leaves the `by` piece out. */
  by: { label: string; color: number; others: number } | null
  /** The failure message of the last draw, when it failed; the frame is then the last one. */
  errorMessage: string | null
  /** Minutes east of UTC, for the clock. */
  offsetMin: number
  /** `/blender play`: the clip looping (the frame showing and the range's last), or a capture with `got` of `total` frames. */
  play?: { kind: 'playing'; frame: number; end: number } | { kind: 'capturing'; got: number; total: number | null } | null
}

/** The caption under the picture as pieces; the layout adds the separators between them. */
export function captionSegments(input: CaptionInput): Segment[] {
  const time = clockText(input.at, input.offsetMin)
  if (input.errorMessage !== null) {
    return [
      { text: shortOf(input.errorMessage), fg: HOT },
      { text: `last frame ${time}`, fg: PLAIN },
    ]
  }
  const out: Segment[] = [{ text: cut(input.scene, MAX_SCENE), fg: LIVE }]
  const play = input.play ?? null
  if (play !== null && play.kind === 'playing') {
    out.push({ text: playText(play.frame, play.end), fg: LIVE, role: 'play' })
  } else if (play !== null) {
    out.push({ text: `capturing ${play.got}/${play.total ?? '…'}`, fg: PLAIN })
  }
  out.push(
    { text: `${input.objects} obj`, fg: PLAIN, role: 'objects' },
    { text: `${input.ms} ms`, fg: PLAIN, role: 'ms' },
    { text: time, fg: PLAIN },
  )
  if (input.by !== null) {
    out.push({
      text: `by ${input.by.label}` + (input.by.others > 0 ? ` +${input.by.others}` : ''),
      fg: input.by.color,
      role: 'by',
    })
  }

  return out
}

/** The caption wraps over at most this many lines. */
export const MAX_CAPTION_LINES = 3
/** Every caption line's text starts at this column: line 0 keeps the first three cells for ` ● `. */
export const CAPTION_INDENT = 3

const SEPARATOR = ' · '

/** A piece of text placed on a caption line, at a column. Fragments of a split piece have no `role`. */
export type Placed = { line: number; col: number; text: string; fg: number; role?: Segment['role'] }

/** The caption laid out in `lines` lines; `lastEnd` is the column after the last placed cell on the last line. */
export type CaptionLayout = { lines: number; items: Placed[]; lastEnd: number }

const widthOf = (text: string): number => Array.from(text).length

/**
 * Lays the caption pieces out over at most `maxLines` lines of `cols` cells, text from column 3 on every line.
 * Pieces go greedily; one that does not fit starts the next line (its ` · ` separator is not drawn at a break). A piece wider
 * than a line is wrapped at spaces, and when the lines run out the rest is cut with an ellipsis, and every later piece dropped.
 */
export function layoutCaption(pieces: Segment[], cols: number, maxLines: number = MAX_CAPTION_LINES): CaptionLayout {
  const room = Math.max(1, cols - CAPTION_INDENT)
  const items: Placed[] = []
  let line = 0
  let col = CAPTION_INDENT
  let count = 0
  let done = false

  const place = (text: string, fg: number, role?: Segment['role']): void => {
    items.push(role === undefined ? { line, col, text, fg } : { line, col, text, fg, role })
    col += widthOf(text)
  }

  for (const piece of pieces) {
    if (done) break
    const width = widthOf(piece.text)
    // 1 and 2: the piece fits on this line, or on the next one when it holds a piece already.
    let placed = false
    for (;;) {
      const sepWidth = count > 0 ? widthOf(SEPARATOR) : 0
      if (col + sepWidth + width <= cols) {
        if (count > 0) place(SEPARATOR, PLAIN)
        place(piece.text, piece.fg, piece.role)
        count += 1
        placed = true
        break
      }
      if (count > 0 && line + 1 < maxLines) {
        line += 1
        col = CAPTION_INDENT
        count = 0
        continue
      }
      break
    }
    if (placed) continue
    if (count > 0) {
      // 4: no line is left. The piece is cut to the room that remains, or the line's last cell becomes an ellipsis.
      const left = cols - col - widthOf(SEPARATOR)
      if (left >= 2) {
        place(SEPARATOR, PLAIN)
        place(cut(piece.text, left), piece.fg)
      } else {
        const last = items[items.length - 1]
        if (last !== undefined) {
          const chars = Array.from(last.text)
          chars.pop()
          last.text = chars.join('') + '…'
          delete last.role
          col = last.col + widthOf(last.text)
        }
      }
      done = true
      continue
    }
    // 3: wider than an empty line: wrapped at spaces over the lines left, the rest cut with an ellipsis on the last.
    const words = piece.text.split(' ')
    let wi = 0
    while (wi < words.length) {
      col = CAPTION_INDENT
      if (line === maxLines - 1) {
        place(cut(words.slice(wi).join(' '), room), piece.fg)
        count = 1
        done = true
        break
      }
      let fragment = words[wi] ?? ''
      wi += 1
      if (widthOf(fragment) > room) {
        fragment = cut(fragment, room)
      } else {
        while (wi < words.length && widthOf(fragment) + 1 + widthOf(words[wi] ?? '') <= room) {
          fragment += ' ' + (words[wi] ?? '')
          wi += 1
        }
      }
      place(fragment, piece.fg)
      count = 1
      if (wi < words.length) line += 1
    }
  }

  return { lines: line + 1, items, lastEnd: col }
}
