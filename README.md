# Claude-Blender

![version](https://img.shields.io/badge/version-0.2.0-blue)

A mod for the Claude Code CLI that keeps a pane with a live, low-res picture of your Blender scene. You stay in the terminal while Claude, or a subagent, edits the scene through the Blender MCP: each edit redraws the picture a moment later, with the name of the agent that made it, and the pane moves while it does.

```
┌ Claude-Blender ──────────────────────────────────────────────────────────┐
│          ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀                │
│          ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀                │
│          ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀                │
│          ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀                │
│ ● Scene · 3 obj · 142 ms · 14:02:31 · by general-purpose  ✦ fresh        │
│[Viewport] Camera  Top  Bottom  Front  Back  Left  Right  ¾  ▸Cockpit     │
└──────────────────────────────────────────────────────────────────────────┘
```

## Features

- **The live view:** the largest 3D Viewport of your Blender (or, by setting, the scene camera) drawn in half blocks, `▀` with the top pixel as its color and the bottom pixel as its background, in truecolor. The picture keeps Blender's shape, centered, with blank cells around it.
- **Every agent counts:** an edit from the main session or from any subagent redraws the view. The caption names who made the last one, `by Explore` or `by general-purpose`, in that agent's color (lavender for Claude, a color of its own for each subagent, gray for `you` after `/blender refresh`), and adds `+2` when two more agents edited since the last draw.
- **Which tools redraw it:** the Blender MCP's `execute_blender_code`, `import_asset` and `generate_3d`. Reading tools (`get_scene_info`, `look`, `search_assets`, `get_addon_status`) never do.
- **Coalescing:** a burst of edits is one draw (350 ms after the last edit, 1.5 s at the most), and one draw is in flight at a time, so several agents editing together cost one call and one follow-up.
- **Pick the view from the pane:** a chip row under the picture holds the presets (`Viewport`, `Camera`, `Top`, `Bottom`, `Front`, `Back`, `Left`, `Right` and `¾`, a three-quarter view) and one chip for every camera in the scene, such as a `▸Cockpit` a subagent added. The current one is bracketed. The chips are clickable in the fullscreen terminal; otherwise use ctrl+x tab, then Tab or the arrows and Enter, or `/blender view <name>`. The chips give way first when the pane is short.
- **The caption:** a state dot, the scene name, the object count, the draw time in ms, the time of the frame and who made the edit. On a narrow pane it wraps between its pieces onto up to three lines, starting flush under the first piece, instead of cutting.
- **States:** the empty pane (`○ No frame yet.`), drawing (a spinning `◐ ◓ ◑ ◒`, the held picture dimmed), stale (`◌`, the picture dimmed while edits wait), idle (`●`) and failed (`✗` in red with the reason, the last picture kept dimmed). After a failure nothing is retried until the next edit or `/blender refresh`.
- **Motion** (setting `motion`): Lively (default), Subtle or Off.
  - **Lively:** a new frame wipes in from the top behind a warm glint line; a soft shimmer drifts across the held frame while Blender draws; the dot spins every 0.2 s; the object count and draw time roll to their new values with the changed digits flashing; the agent's name pulses three times in its color; `✦ fresh` twinkles for 2 s; a failed draw pulses the `✗` red.
  - **Subtle:** the wipe without the glint, a fainter shimmer, the spinner a step every second, softer pulses and a plain `fresh`.
  - **Off:** a still pane, each frame swapped in at once.
- **A demo:** `/blender demo` plays a 14-second tour of the effects with made-up frames, three agents and a failed draw, with Blender closed and untouched.

## Install

**Claude Code CLI only.** You need Claude Code 2.1.302 or later, the Blender MCP server connected (`/mcp` lists `blender`), and Blender 3.0 or later with its MCP add-on running and a 3D Viewport open.

Load it in every session by adding the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (separate several folders with `;` on Windows, `:` elsewhere):

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\<you>\\projects\\mods\\claudeblender"
  }
}
```

Or load it for a single session with `claude --plugin-dir <path to this folder>`.

## Usage

| Command | What it does |
|---|---|
| `/blender` | Open the Blender view |
| `/blender view <name>` | Pick a view: a preset (`top`, `bottom`, `front`, `back`, `left`, `right`, `iso`, `viewport`, `camera`) or a camera of the scene by name (any case, or a unique start of it) |
| `/blender views` | List the views, the cameras in the scene and the one showing |
| `/blender refresh` | Draw the scene now (also the way to recover after Blender was closed) |
| `/blender close` | Close the view; edits then leave it closed until `/blender` |
| `/blender demo` | Play a 14-second tour of the effects with made-up frames |
| `/blender demo stop` | End the demo; your Blender scene comes back |

The pane opens by itself on the first Blender edit of a session (setting `autoOpen`). Closing it by hand keeps it closed for the rest of the session. Opened unasked, a pane shows from 144 terminal columns (110 once you have opened it yourself); `/blender` opens it at any width.

## Settings

Set them in `/config`, or in settings under `pluginConfigs.claudeblender`. A change applies at once.

| Setting | Values (default first) | What it does |
|---|---|---|
| `autoOpen` | `on`, `off` | on: the pane opens on the first edit by Claude or a subagent / off: only `/blender` opens it |
| `view` | `viewport`, `camera`, `top`, `bottom`, `front`, `back`, `left`, `right`, `iso` | the view each session starts with; the chips and `/blender view` change it for the session only. viewport: what the largest 3D Viewport shows, at its shape / camera: through the scene camera, at the render resolution's shape / the rest: straight-on orthographic views framed on the scene, and a three-quarter view |
| `shading` | `solid`, `material` | Solid shading, fast and clear / Material Preview, the scene's real colors, slower |
| `motion` | `lively`, `subtle`, `off` | wipe, shimmer, spinner, rolling figures and pulses / the same, softer / still |
| `server` | `blender` | the name of the Blender MCP server as `/mcp` lists it |

## How it works

- **Triggers:** a `tool.call` hook sees a Blender edit made by the main loop or by any subagent (a subagent's tools raise their own `tool.call`, carrying its `agentId`). It only observes: the tool runs as it was, and the draw is scheduled after it returns.
- **Scheduling:** 350 ms after the last edit of a burst, 1.5 s after its first at the latest, one call in flight at a time. Edits that come while Blender draws are one follow-up. A draw that does not answer is given up after 20 s.
- **The draw:** the mod sends a short Python script through the MCP's `execute_blender_code`. It draws the largest 3D Viewport offscreen (`GPUOffScreen.draw_view3d`, with explicit matrices and size) at twice the target size, box-downsamples with numpy and prints one marked line of JSON with the pixels as base64 RGB. The mod reads that line from the MCP's answer.
- **The views:** the preset views are orthographic and framed on the visible objects of the scene (a 2 m cube at the origin when there is none), like Blender's numpad views. A camera view draws through that camera object without making it the scene's active camera. The matrices are computed in the script, so Blender's own viewport and its active camera never move. The list of cameras (at most 24) arrives with each draw.
- **What it changes and restores:** two viewport-space properties, the viewport's shading type and its overlays, are set for the draw and put back in a `finally` within the same call. No scene, object, material or render setting is touched, no datablock is created and nothing is written to disk.
- **The picture:** one cell is one `▀`, two pixels tall, so a pane 72 columns wide takes at most 72 by 40 pixels. The view is drawn for the pane's size and redrawn once, after a short wait, when the pane is resized.
- **Painting:** the picture and the caption are Raster cell grids. They are repainted up to 20 times a second while something moves (the wipe, a rolling figure, a pulse, a draw in flight) and not at all otherwise. Only the pieces that changed are sent, the picture at 10 frames a second while only the shimmer moves it. Effects never start a Blender call.
- **No Blender call** is made while the pane is not open and shown.

## Limitations

- **Low resolution.** A cell is one pixel wide and two tall, and the picture is at most 160 by 96 pixels.
- **A limited palette.** The terminal paints 1024 distinct color pairs at once and the rest as their nearest, so a busy frame shows some banding.
- **No real-pixel path yet.** A true image needs the kitty graphics protocol (kitty, Ghostty), which Windows Terminal does not have; the mod draws half blocks everywhere.
- **Each draw is an `execute_blender_code` call.** Blender's window pauses for it, typically a fraction of a second (Material shading takes longer, more than a second for the first draw after new materials), and the call shows in the MCP for Blender add-on's own history and telemetry like any other.
- **Big answers can be cut.** The mod asks for a picture sized to the pane. If the MCP layer cuts Blender's answer, the mod asks again at half the size, down to a quarter, and keeps that size for the session.
- **Material shading may show unfinished shaders** on the first draw after new materials appear.
- **Edits you make in Blender by hand do not redraw the view.** Use `/blender refresh`.
- **A camera named like a preset** (`Top`, say) is picked from its chip, not with `/blender view`, which takes the preset.
- **A deleted or renamed camera** falls back to the viewport, with a toast, on the next draw.

## Development

```
npx -y -p typescript@5.6.3 tsc -p .
claude plugin validate .
claude plugin test .
```

| Path | Contents |
|---|---|
| `hooks/register.tsx` | the mod: the hooks, the scheduler's driver, the draw, the pane, the frame timer, `/blender` and the demo |
| `hooks/script.ts` | the Python the mod sends to Blender |
| `hooks/reply.ts` | Blender's answer parsed into a frame or a failure |
| `hooks/schedule.ts` | the debounce, the coalescing, the single flight and who edited |
| `hooks/pixels.ts` | the picture's geometry, half blocks, the stale dim and the shimmer |
| `hooks/caption.ts` | the caption and its wrapping, agent labels and colors, the failure texts |
| `hooks/motion.ts` | the pane's motion: what changed, the effects, each frame |
| `hooks/settings.ts` | the settings and the tool-name prefix |
| `hooks/views.ts` | the view ids, the chips and their rows, `/blender view` matching |
| `hooks/cells.ts` | colors, blending, the cell encoding |
| `hooks/demo.ts` | the demo's timeline and made-up picture |
| `types/index.d.ts` | the mod's shared types |
| `tests/` | tests for the answer, the script, the picture, the scheduler, the caption, the motion, the demo and the pane |

## License

MIT, see [LICENSE](LICENSE).
