import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { decodeCells } from '../hooks/cells'
import type { Cell } from '../hooks/cells'
import { MARK_BEGIN, MARK_END } from '../hooks/script'

const NOW = Date.parse('2026-10-14T10:00:00Z')

/** The pane as the engine mounts it: `bodyColumns` columns, `bodyRows` rows. */
const paneOf = (bodyColumns: number, bodyRows = 20) =>
  ({
    plugin: 'claudeblender',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'blender',
    props: {
      title: 'Claude-Blender',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { bodyRows, contentRows: bodyRows, offset: 0 },
      view: {},
    } as never,
  }) as const

const PANE = paneOf(72)

const PANE_DESKTOP = { ...PANE, surface: 'desktop' } as const

type Answer = { content: { type: string; text: string }[]; isError: boolean }

const b64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))

  return btoa(binary)
}

const answerOf = (text: string): Answer => ({ content: [{ type: 'text', text }], isError: false })

/** What the Blender MCP returns for a draw: `{"result": "..."}` around the marked line. `extra` adds reply fields (`cams`, `active`). */
function frameReply(w: number, h: number, fill = 0x40, extra: Record<string, unknown> = {}): Answer {
  const rgb = new Uint8Array(w * h * 3).fill(fill)
  for (let i = 0; i < rgb.length; i += 3) rgb[i] = (fill + ((i / 3) % w)) & 0xff
  const line =
    MARK_BEGIN +
    JSON.stringify({
      v: 1,
      ok: true,
      w,
      h,
      rgb: b64(rgb),
      scene: 'Scene',
      objects: 3,
      ms: 120,
      blender: '4.2.0',
      view: 'viewport',
      ...extra,
    }) +
    MARK_END

  return answerOf(JSON.stringify({ result: 'Code executed successfully: ' + line + '\n' }))
}

/** A script failure as Blender's reply carries it. */
const failReply = (fields: Record<string, unknown>): Answer =>
  answerOf(JSON.stringify({ result: 'Code executed successfully: ' + MARK_BEGIN + JSON.stringify({ v: 1, ok: false, ...fields }) + MARK_END + '\n' }))

/** The parameters inside the script a call carried, decoded as the Python does. */
function paramsIn(code: string): Record<string, unknown> {
  const binary = atob(/base64\.b64decode\('([^']*)'\)/.exec(code)?.[1] ?? '')

  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)))) as Record<string, unknown>
}

const OFFLINE = answerOf(
  JSON.stringify({ result: 'Error getting scene info: Could not connect to Blender. Make sure the Blender addon is running.' }),
)

const TRUNCATED = answerOf(JSON.stringify({ result: 'Code executed successfully: ' + MARK_BEGIN + '{"ok":true,"w":65,"h":40,"rgb":"AAAA' }))

/** The engine beneath the mod: the pane, the agents, the Blender MCP, the recorders. */
function world(on: On) {
  const state = {
    placed: true,
    shown: true,
    open: false,
    agents: [] as { id: string; type: string; description: string; status: string; name?: string }[],
    reply: (async () => frameReply(65, 40)) as () => Promise<Answer>,
    blitAnswer: {} as { deny?: string },
  }
  const calls: { server: string; tool: string; code: string }[] = []
  const opens: Record<string, unknown>[] = []
  const commands: string[] = []
  const blits: { requestId: string; key: string; cells: string }[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: NOW })

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    commands.push((e as unknown as { name: string }).name)
    return { value: { command: 'blender' } }
  })
  on('ui.open', (_$, e) => {
    opens.push(e as unknown as Record<string, unknown>)
    state.open = true
    return { value: state.placed ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } } as never
  })
  on('ui.close', () => {
    state.open = false
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: state.open ? [{ id: 'blender', title: 'Claude-Blender', isShown: state.shown, isFocused: false, isPlaced: state.placed }] : [],
  }))
  on('agent.list', () => ({ value: state.agents }) as never)
  on('mcp.call', async (_$, e) => {
    calls.push({ server: e.server, tool: e.tool, code: String(e.args.code ?? '') })
    return { value: await state.reply() } as never
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.blit', (_$, e) => {
    blits.push({ requestId: e.requestId, key: e.key, cells: (e as unknown as { cells?: string }).cells ?? '' })
    return { value: state.blitAnswer }
  })
  on('ui.render', ({ ui }, e) => {
    const { Text } = ui.resolve(e)
    return <Text>engine</Text>
  })

  return { state, calls, opens, commands, blits, toasts, clock }
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

const cellText = (cells: Cell[]): string => cells.map(c => String.fromCodePoint(c.cp)).join('')

/** The drawing as text; a Raster contributes the characters of the cells it was mounted with. */
function seen(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  const { type, props, children } = node as Node
  if (type === 'Raster') return cellText(decodeCells(String(props?.cells ?? '')))

  return (children ?? []).map(seen).join('')
}

function walk(node: unknown, out: Node[] = []): Node[] {
  if (node === null || typeof node !== 'object') return out
  out.push(node as Node)
  for (const child of (node as Node).children ?? []) walk(child, out)

  return out
}

const rasters = (node: unknown): Node[] => walk(node).filter(n => n.type === 'Raster')
const keyOf = (n: Node): string => String(n.props?.key ?? (n as { key?: unknown }).key)

const begin = ($: Engine) => $.session.start({ cwd: '/x/proj', surface: 'terminal', isInteractive: true } as never)

const command = ($: Engine, args: string) =>
  $.command.run({ command: 'blender', args, origin: { kind: 'composer' } } as never) as Promise<{ text: string }>

/** A Blender edit by the main loop, or by the subagent `agentId`. */
const edit = ($: Engine, tool = 'execute_blender_code', agentId?: string) =>
  $.tool.call({ tool: `mcp__blender__${tool}`, code: 'x', ...(agentId === undefined ? {} : { agentId }) } as never)

test('/blender is registered, opens the pane and says so', async ($, on) => {
  const w = world(on)
  await begin($)
  expect(w.commands).toEqual(['blender'])
  const r = await command($, '')
  expect(r.text).toBe('Opened the Blender view. It redraws after each Blender edit; /blender refresh draws it now.')
  expect(w.opens.length).toBe(1)
  expect(w.opens[0]?.id).toBe('blender')
  expect(w.opens[0]?.title).toBe('Claude-Blender')
  expect((await command($, 'what')).text).toBe(
    'Claude-Blender: /blender opens the view, /blender view <name> picks a view (/blender views lists them), /blender refresh draws it now, /blender close closes it, /blender demo plays the effects. The settings are in /config.',
  )
})

test('the empty pane says there is no frame yet', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(PANE as never)
  const text = seen(await ui.drawn())
  expect(text).toContain('No frame yet.')
  expect(text).toContain("Claude's next Blender edit draws the scene here")
})

test('a Blender edit draws one frame 350 ms later, in half blocks with a caption', async ($, on) => {
  const w = world(on)
  w.state.open = true
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  await edit($)
  await w.clock.advance(349)
  expect(w.calls.length).toBe(0)
  await w.clock.advance(1)
  expect(w.calls.length).toBe(1)
  expect(w.calls[0]?.server).toBe('blender')
  expect(w.calls[0]?.tool).toBe('execute_blender_code')
  expect(w.calls[0]?.code).toContain('@@claudeblender@@')
  const drawn = await ui.drawn()
  const pieces = rasters(drawn)
  expect(pieces.map(keyOf)).toEqual(['blender-image', 'blender-caption'])
  const image = decodeCells(String(pieces[0]?.props?.cells ?? ''))
  expect(image.some(c => c.cp === 0x2580)).toBe(true)
  expect(seen(pieces[1])).toContain('3 obj')
  expect(seen(pieces[1])).toContain('by Claude')
})

test('a read-only Blender tool and another server draw nothing', async ($, on) => {
  const w = world(on)
  w.state.open = true
  await begin($)
  await edit($, 'get_scene_info')
  await edit($, 'look')
  await $.tool.call({ tool: 'mcp__other__execute_blender_code', code: 'x' } as never)
  await w.clock.advance(5000)
  expect(w.calls.length).toBe(0)
  expect(w.opens.length).toBe(0)
})

test('three edits 100 ms apart make one call', async ($, on) => {
  const w = world(on)
  w.state.open = true
  await begin($)
  await edit($)
  await w.clock.advance(100)
  await edit($)
  await w.clock.advance(100)
  await edit($)
  await w.clock.advance(349)
  expect(w.calls.length).toBe(0)
  await w.clock.advance(1)
  expect(w.calls.length).toBe(1)
  await w.clock.advance(5000)
  expect(w.calls.length).toBe(1)
})

test('an edit while a draw is pending starts no second call; one follows when it ends', async ($, on) => {
  const w = world(on)
  w.state.open = true
  let release: (a: Answer) => void = () => undefined
  w.state.reply = () =>
    new Promise<Answer>(resolve => {
      release = resolve
    })
  await begin($)
  await edit($)
  await w.clock.advance(350)
  expect(w.calls.length).toBe(1)
  await edit($, 'execute_blender_code', 'a1')
  await w.clock.advance(3000)
  expect(w.calls.length).toBe(1)
  release(frameReply(65, 40))
  await w.clock.advance(200)
  expect(w.calls.length).toBe(2)
  await w.clock.advance(2000)
  expect(w.calls.length).toBe(2)
})

test('the first edit opens the pane without taking the keyboard', async ($, on) => {
  const w = world(on)
  await begin($)
  await edit($)
  await w.clock.settle()
  expect(w.opens.length).toBe(1)
  expect(w.opens[0]?.id).toBe('blender')
  expect(w.opens[0]?.focus).toBe(undefined)
  expect(w.opens[0]?.closeOnEscape).toBe(undefined)
  expect(w.opens[0]?.holdToasts).toBe(undefined)
  // The test kit's `$` cannot raise `ui.close` with origin `person` (the engine raises it for the person), so a
  // person's close keeping the pane closed is not tested here; a later edit finds the pane open and opens nothing.
  await edit($)
  await w.clock.settle()
  expect(w.opens.length).toBe(1)
  // /blender opens it again.
  await command($, '')
  expect(w.opens.length).toBe(2)
})

test('with Open on the first edit off, an edit never opens the pane', { options: { autoOpen: 'off' } }, async ($, on) => {
  const w = world(on)
  await begin($)
  await edit($)
  await w.clock.advance(5000)
  expect(w.opens.length).toBe(0)
  expect(w.calls.length).toBe(0)
})

test('an unreachable Blender shows its message and is not polled', async ($, on) => {
  const w = world(on)
  w.state.open = true
  w.state.reply = async () => OFFLINE
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  await edit($)
  await w.clock.advance(350)
  expect(w.calls.length).toBe(1)
  expect(seen(await ui.drawn())).toContain("Blender isn't reachable.")
  await w.clock.advance(10_000)
  expect(w.calls.length).toBe(1)
  // A new edit tries again.
  w.state.reply = async () => frameReply(65, 40)
  await edit($)
  await w.clock.advance(350)
  expect(w.calls.length).toBe(2)
  expect(seen(await ui.drawn())).toContain('3 obj')
})

test('after a failure, an edit made while the pane was hidden draws when it shows', async ($, on) => {
  const w = world(on)
  w.state.open = true
  w.state.reply = async () => OFFLINE
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  await edit($)
  await w.clock.advance(350)
  expect(w.calls.length).toBe(1)
  w.state.reply = async () => frameReply(65, 40)
  w.state.shown = false
  await edit($)
  await w.clock.advance(5000)
  expect(w.calls.length).toBe(1)
  w.state.shown = true
  await ui.unmount()
  const shown = await $.ui.mount(PANE as never)
  await shown.drawn()
  await w.clock.advance(350)
  expect(w.calls.length).toBe(2)
  expect(seen(await shown.drawn())).toContain('3 obj')
})

test('an edit by a subagent is credited to it', async ($, on) => {
  const w = world(on)
  w.state.open = true
  w.state.agents = [{ id: 'a1', type: 'Explore', description: 'x', status: 'running' }]
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  await edit($, 'execute_blender_code', 'a1')
  await w.clock.advance(350)
  expect(w.calls.length).toBe(1)
  expect(seen(await ui.drawn())).toContain('by Explore')
})

test('/blender refresh draws at once and credits you', async ($, on) => {
  const w = world(on)
  w.state.open = true
  await begin($)
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  expect((await command($, 'refresh')).text).toBe('Drawing the scene now.')
  await w.clock.advance(1)
  expect(w.calls.length).toBe(1)
  expect(seen(await ui.drawn())).toContain('by you')
})

test('the desktop draws only a one-line notice', async ($, on) => {
  const w = world(on)
  w.state.open = true
  const ui = await $.ui.mount(PANE_DESKTOP as never)
  const drawn = await ui.drawn()
  expect(seen(drawn)).toContain('The Blender view draws in the terminal only.')
  expect(rasters(drawn).length).toBe(0)
  await w.clock.advance(5000)
  expect(w.blits.length).toBe(0)
})

test('a draw that never answers is given up after 20 s, and a late answer is ignored', async ($, on) => {
  const w = world(on)
  w.state.open = true
  let release: (a: Answer) => void = () => undefined
  w.state.reply = () =>
    new Promise<Answer>(resolve => {
      release = resolve
    })
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  await edit($)
  await w.clock.advance(350)
  expect(w.calls.length).toBe(1)
  await w.clock.advance(20_000)
  expect(seen(await ui.drawn())).toContain('took longer')
  release(frameReply(65, 40))
  await w.clock.advance(100)
  const text = seen(await ui.drawn())
  expect(text).toContain('took longer')
  expect(text).not.toContain('3 obj')
})

test('an answer cut by the MCP layer is asked again, smaller, in the same flight', async ($, on) => {
  const w = world(on)
  w.state.open = true
  let n = 0
  w.state.reply = async () => (n++ === 0 ? TRUNCATED : frameReply(65, 40))
  await begin($)
  await edit($)
  await w.clock.advance(350)
  expect(w.calls.length).toBe(2)
  expect(paramsIn(w.calls[0]?.code ?? '').maxW).toBe(72)
  expect(paramsIn(w.calls[1]?.code ?? '').maxW).toBe(36)
  expect(paramsIn(w.calls[1]?.code ?? '').maxH).toBe(19)
})

test('/blender demo plays made-up frames and never calls Blender', async ($, on) => {
  const w = world(on)
  w.state.open = true
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  const started = await command($, 'demo')
  expect(started.text).toBe(
    "Playing the Blender view demo for 14 s with made-up frames; Blender isn't touched. /blender demo stop ends it.",
  )
  await w.clock.advance(1300)
  expect(seen(await ui.drawn())).toContain('Demo')
  // No call to Blender within the 14 s; the pane's own redraw after the demo ends is outside the window.
  await w.clock.advance(12_600)
  expect(w.calls.length).toBe(0)
  await w.clock.advance(200)
  expect((await command($, 'demo stop')).text).toBe('No demo is running.')
})

test('demo stop returns to the real pane', async ($, on) => {
  const w = world(on)
  w.state.open = true
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  await command($, 'demo')
  await w.clock.advance(5600)
  expect(seen(await ui.drawn())).toContain('by Explore')
  expect((await command($, 'demo stop')).text).toBe('Stopped the demo: the pane shows your Blender scene again.')
  expect(seen(await ui.drawn())).not.toContain('Demo')
})

test('Lively wipes a second frame in over several blits', async ($, on) => {
  const w = world(on)
  w.state.open = true
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  await edit($)
  await w.clock.advance(350)
  w.state.reply = async () => frameReply(65, 40, 0x90)
  await edit($)
  await w.clock.advance(350)
  await w.clock.advance(300)
  const images = w.blits.filter(b => b.key === 'blender-image')
  expect(new Set(images.map(b => b.cells)).size).toBeGreaterThanOrEqual(3)
  expect(w.blits.every(b => b.requestId === 'blender' && b.key.startsWith('blender-'))).toBe(true)
})

test('under Off the frames swap in at once, with no blit', { options: { motion: 'off' } }, async ($, on) => {
  const w = world(on)
  w.state.open = true
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  await edit($)
  await w.clock.advance(350)
  w.state.reply = async () => frameReply(65, 40, 0x90)
  await edit($)
  await w.clock.advance(350)
  await w.clock.advance(1000)
  expect(w.blits.length).toBe(0)
  expect(seen(await ui.drawn())).toContain('3 obj')
})

const buttonsOf = (node: unknown): Node[] => walk(node).filter(n => n.type === 'Button')

test('a narrow pane wraps the caption onto two lines and cuts nothing', async ($, on) => {
  const w = world(on)
  w.state.open = true
  const ui = await $.ui.mount(paneOf(40) as never)
  await ui.drawn()
  await edit($)
  await w.clock.advance(350)
  const pieces = rasters(await ui.drawn())
  expect(pieces.map(keyOf)).toEqual(['blender-image', 'blender-caption'])
  expect(pieces[1]?.props?.rows).toBe(2)
  const text = seen(pieces[1])
  expect(text).toContain('by Claude')
  expect(text).not.toContain('…')
})

test('the agent label is taken while its tool call runs, not at the draw', async ($, on) => {
  const w = world(on)
  w.state.open = true
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  w.state.agents = [{ id: 'a1', type: 'Explore', description: 'x', status: 'running' }]
  await edit($, 'execute_blender_code', 'a1')
  await w.clock.advance(5)
  // The subagent has left the list by the time Blender answers.
  w.state.agents = []
  await w.clock.advance(400)
  expect(w.calls.length).toBe(1)
  const text = seen(await ui.drawn())
  expect(text).toContain('by Explore')
  expect(text).not.toContain('by subagent')
})

test('the chips show the view; pressing one draws that view at once and moves the highlight', async ($, on) => {
  const w = world(on)
  w.state.open = true
  const ui = await $.ui.mount(PANE as never)
  const first = seen(await ui.drawn())
  expect(first).toContain('[Viewport]')
  expect(first).toContain(' Top ')
  await w.clock.advance(350)
  expect(w.calls.length).toBe(1)
  expect(paramsIn(w.calls[0]?.code ?? '').view).toBe('viewport')
  await ui.press({ key: 'view-top' })
  await w.clock.advance(5)
  expect(w.calls.length).toBe(2)
  expect(paramsIn(w.calls[1]?.code ?? '').view).toBe('top')
  expect(paramsIn(w.calls[1]?.code ?? '').cam).toBe('')
  const after = seen(await ui.drawn())
  expect(after).toContain('[Top]')
  expect(after).not.toContain('[Viewport]')
})

test('a camera of the scene gets a chip, and pressing it draws through that camera', async ($, on) => {
  const w = world(on)
  w.state.open = true
  w.state.reply = async () => frameReply(65, 40, 0x40, { cams: ['Camera', 'Cockpit'], active: 'Camera' })
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  await w.clock.advance(350)
  expect(w.calls.length).toBe(1)
  expect(seen(await ui.drawn())).toContain('▸Cockpit')
  expect(buttonsOf(await ui.drawn()).some(b => b.props?.key === 'view-cam-Cockpit')).toBe(true)
  await ui.press({ key: 'view-cam-Cockpit' })
  await w.clock.advance(5)
  expect(w.calls.length).toBe(2)
  const params = paramsIn(w.calls[1]?.code ?? '')
  expect(params.view).toBe('object')
  expect(params.cam).toBe('Cockpit')
  expect(seen(await ui.drawn())).toContain('[▸Cockpit]')
})

test('a camera that is gone sends the pane back to the viewport in the same flight, with a toast', async ($, on) => {
  const w = world(on)
  w.state.open = true
  let n = 0
  w.state.reply = async () => {
    n += 1
    if (n === 2) return failReply({ code: 'no-such-camera', message: 'Cockpit', cams: ['Camera'], active: 'Camera' })

    return frameReply(65, 40, 0x40, { cams: n === 1 ? ['Camera', 'Cockpit'] : ['Camera'], active: 'Camera' })
  }
  const ui = await $.ui.mount(PANE as never)
  await ui.drawn()
  await w.clock.advance(350)
  expect(seen(await ui.drawn())).toContain('▸Cockpit')
  await ui.press({ key: 'view-cam-Cockpit' })
  await w.clock.advance(5)
  expect(w.calls.length).toBe(3)
  expect(paramsIn(w.calls[1]?.code ?? '').view).toBe('object')
  expect(paramsIn(w.calls[2]?.code ?? '').view).toBe('viewport')
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('Cockpit')
  const text = seen(await ui.drawn())
  expect(text).toContain('[Viewport]')
  expect(text).not.toContain('▸Cockpit')
})

test('/blender view picks a view, /blender views lists them, and an unknown name says so', async ($, on) => {
  const w = world(on)
  await begin($)
  expect((await command($, 'views')).text).toBe(
    'Views: viewport, camera, top, bottom, front, back, left, right, iso. Cameras in the scene: not known until the first draw. Showing: viewport.',
  )
  expect((await command($, 'view nope')).text).toBe(
    'No view called "nope". Views: viewport, camera, top, bottom, front, back, left, right, iso; cameras: none known yet.',
  )
  expect(w.calls.length).toBe(0)
  expect((await command($, 'view top')).text).toBe('Showing the Top view.')
  await w.clock.advance(5)
  expect(w.calls.length).toBe(1)
  expect(paramsIn(w.calls[0]?.code ?? '').view).toBe('top')
  expect((await command($, 'views')).text).toContain('Showing: top.')
  expect((await command($, 'view 3/4')).text).toBe('Showing the ¾ view.')
})

test('/blender views lists the cameras of the last reply, and /blender view <camera> matches them', async ($, on) => {
  const w = world(on)
  w.state.reply = async () => frameReply(65, 40, 0x40, { cams: ['Camera', 'Cockpit'], active: 'Camera' })
  await begin($)
  await command($, 'refresh')
  await w.clock.advance(5)
  expect(w.calls.length).toBe(1)
  expect((await command($, 'views')).text).toContain('Cameras in the scene: Camera, Cockpit.')
  expect((await command($, 'view cockpit')).text).toBe('Showing the view through "Cockpit".')
  await w.clock.advance(5)
  expect(w.calls.length).toBe(2)
  const params = paramsIn(w.calls[1]?.code ?? '')
  expect([params.view, params.cam]).toEqual(['object', 'Cockpit'])
})

test('with no room under the picture the chips are dropped first', async ($, on) => {
  const w = world(on)
  w.state.open = true
  const ui = await $.ui.mount(paneOf(72, 7) as never)
  expect(buttonsOf(await ui.drawn()).length).toBe(0)
})

test('with room under the picture the chips are drawn as plain Buttons', async ($, on) => {
  const w = world(on)
  w.state.open = true
  const ui = await $.ui.mount(PANE as never)
  const buttons = buttonsOf(await ui.drawn())
  expect(buttons.map(b => b.props?.key)).toEqual([
    'view-viewport',
    'view-camera',
    'view-top',
    'view-bottom',
    'view-front',
    'view-back',
    'view-left',
    'view-right',
    'view-iso',
  ])
  expect(buttons.every(b => Boolean(b.props?.plain) && b.props?.hotkey === undefined)).toBe(true)
})

test('a caption that grows a line draws no extra frame once the scheduler is idle', async ($, on) => {
  const w = world(on)
  w.state.open = true
  const ui = await $.ui.mount(paneOf(56) as never)
  await ui.drawn()
  await edit($)
  await w.clock.advance(350)
  expect(w.calls.length).toBe(1)
  expect(rasters(await ui.drawn())[1]?.props?.rows).toBe(1)
  // A subagent with a long label: the caption no longer fits one line at 56 columns.
  w.state.agents = [{ id: 'a1', type: 'a'.repeat(20), description: 'x', status: 'running' }]
  await edit($, 'execute_blender_code', 'a1')
  await w.clock.advance(5)
  await w.clock.advance(400)
  expect(w.calls.length).toBe(2)
  expect(rasters(await ui.drawn())[1]?.props?.rows).toBe(2)
  await w.clock.advance(10_000)
  expect(w.calls.length).toBe(2)
})
