import type { ViewKind } from '../types'

/** The line the script prints begins with this, and ends with `MARK_END`. */
export const MARK_BEGIN = '@@claudeblender@@'
export const MARK_END = '@@end@@'
/** The script draws at this many times the target size and box-downsamples. */
export const SUPERSAMPLE = 2
/** A camera name is cut at this many characters before it travels. */
export const MAX_CAM_NAME = 200
/** An animation capture samples at most this many frames of the scene's range, however long it is. */
export const MAX_CLIP_FRAMES = 240

/** One batch of an animation capture: the range sampled down to `max` frames, of which `count` from `from`. */
export type ClipParams = { max: number; from: number; count: number }

export type ScriptParams = {
  maxW: number
  maxH: number
  view: ViewKind
  /** The camera object to draw through when `view` is `object`; '' otherwise. */
  cam: string
  shading: 'solid' | 'material'
  /** Present for an animation capture: the script then draws a batch of the scene's frames instead of the current one. */
  clip?: ClipParams
}

const clampInt = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.floor(n)))

/**
 * The parameters the script reads, clamped: sizes to 160 x 96 whole numbers, the camera name cut, `cam` empty unless `view`
 * is `object`, and a capture's batch to whole numbers within `MAX_CLIP_FRAMES`.
 */
export function paramsOf(p: ScriptParams): Record<string, string | number | Record<string, number>> {
  const params: Record<string, string | number | Record<string, number>> = {
    maxW: clampInt(p.maxW, 1, 160),
    maxH: clampInt(p.maxH, 1, 96),
    ss: SUPERSAMPLE,
    view: p.view,
    cam: p.view === 'object' ? Array.from(p.cam).slice(0, MAX_CAM_NAME).join('') : '',
    shading: p.shading,
  }
  if (p.clip !== undefined) {
    params.clip = {
      max: clampInt(p.clip.max, 1, MAX_CLIP_FRAMES),
      from: clampInt(p.clip.from, 0, MAX_CLIP_FRAMES),
      count: clampInt(p.clip.count, 1, MAX_CLIP_FRAMES),
    }
  }

  return params
}

/** The parameters as standard base64 of their UTF-8 JSON, so any camera name is safe inside the script's source. */
export function encodeParams(p: ScriptParams): string {
  const bytes = new TextEncoder().encode(JSON.stringify(paramsOf(p)))
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

/**
 * The Python the mod sends through the Blender MCP's `execute_blender_code`.
 *
 * It draws offscreen (`GPUOffScreen.draw_view3d`, with explicit matrices and size), box-downsamples with numpy and prints one
 * marked line of JSON holding base64 RGB, the scene's camera names and its active camera. The view is the largest 3D
 * Viewport's own, the scene camera, any named camera object, or an orthographic preset framed on the scene's visible
 * geometry; all of them compute their matrices here and never move the viewport or the scene camera. It assigns only two
 * viewport-space properties (`space.shading.type`, `space.overlay.show_overlays`), restored in `finally` within the same
 * call; it touches no scene, object or datablock and writes no file. The parameters travel as base64 JSON.
 *
 * With `clip`, it draws a batch of the scene's frame range instead, sampled down to `clip.max` frames: it sets each frame
 * (`scene.frame_set`) and puts the current frame and subframe back in the same `finally`. A preset's framing is taken once,
 * at the current frame, so the clip does not jitter; a camera view follows its camera through the frames.
 */
export function renderScript(p: ScriptParams): string {
  return `import bpy, gpu, json, time, base64
P = json.loads(base64.b64decode('${encodeParams(p)}').decode('utf-8'))
M, E = '${MARK_BEGIN}', '${MARK_END}'
def out(d):
    d['v'] = 1
    print(M + json.dumps(d, separators=(',', ':')) + E)
def fit(a, mw, mh):
    if mw / mh > a:
        h = mh; w = max(1, min(mw, round(mh * a)))
    else:
        w = mw; h = max(1, min(mh, round(mw / a)))
    return w, h
def main():
    if bpy.app.version < (3, 0, 0):
        return out({'ok': False, 'code': 'too-old', 'message': bpy.app.version_string})
    import numpy as np
    from mathutils import Matrix, Vector
    best = None
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type != 'VIEW_3D':
                continue
            reg = next((r for r in area.regions if r.type == 'WINDOW'), None)
            if reg is None or reg.width < 2 or reg.height < 2:
                continue
            if best is None or area.width * area.height > best[1].width * best[1].height:
                best = (win, area, reg)
    if best is None:
        return out({'ok': False, 'code': 'no-view3d', 'message': ''})
    win, area, reg = best
    space, scene, layer = area.spaces.active, win.scene, win.view_layer
    r = scene.render
    cams = sorted(o.name for o in scene.objects if o.type == 'CAMERA')[:24]
    active = scene.camera.name if scene.camera else ''
    tail = {'cams': cams, 'active': active}
    kind = P['view']
    ss = P['ss']
    C = P.get('clip')
    if kind in ('camera', 'object'):
        if kind == 'camera':
            if scene.camera is None:
                return out(dict({'ok': False, 'code': 'no-camera', 'message': ''}, **tail))
        else:
            cam = scene.objects.get(P['cam'])
            if cam is None or cam.type != 'CAMERA':
                return out(dict({'ok': False, 'code': 'no-such-camera', 'message': P['cam']}, **tail))
        aspect = (r.resolution_x * r.pixel_aspect_x) / (r.resolution_y * r.pixel_aspect_y)
        w, h = fit(aspect, P['maxW'], P['maxH'])
    elif kind == 'viewport':
        w, h = fit(reg.width / reg.height, P['maxW'], P['maxH'])
    else:
        w, h = P['maxW'], P['maxH']
    sw, sh = w * ss, h * ss
    def through():
        cam = scene.camera if kind == 'camera' else scene.objects.get(P['cam'])
        view = cam.matrix_world.inverted()
        proj = cam.calc_matrix_camera(layer.depsgraph, x=sw, y=sh,
                                      scale_x=r.pixel_aspect_x, scale_y=r.pixel_aspect_y)
        return view, proj
    def framed():
        SKIP = {'CAMERA', 'LIGHT', 'LIGHT_PROBE', 'LIGHTPROBE', 'SPEAKER', 'EMPTY'}
        AXES = {
            'front': ((0, -1, 0), (1, 0, 0)), 'back': ((0, 1, 0), (-1, 0, 0)),
            'right': ((1, 0, 0), (0, 1, 0)), 'left': ((-1, 0, 0), (0, -1, 0)),
            'top': ((0, 0, 1), (1, 0, 0)), 'bottom': ((0, 0, -1), (1, 0, 0)),
        }
        pts = [ob.matrix_world @ Vector(c) for ob in scene.objects
               if ob.type not in SKIP and ob.visible_get(view_layer=layer) for c in ob.bound_box]
        if not pts:
            pts = [Vector((x, y, z)) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
        lo = Vector(tuple(min(p[i] for p in pts) for i in range(3)))
        hi = Vector(tuple(max(p[i] for p in pts) for i in range(3)))
        c = (lo + hi) / 2
        if kind == 'iso':
            b = Vector((1, -1, 0.8)).normalized()
            rr = (-b).cross(Vector((0, 0, 1))).normalized()
        else:
            b, rr = (Vector(v) for v in AXES[kind])
        u = b.cross(rr)
        R = max(((p - c).length for p in pts), default=1.0) or 1.0
        A = w / h
        ex = max(abs((p - c).dot(rr)) for p in pts)
        ey = max(abs((p - c).dot(u)) for p in pts)
        hw = max(ex, ey * A, 0.01) * 1.1
        hh = hw / A
        eye = c + b * (2 * R + 1)
        n, f = 0.1, 4 * R + 2
        view = Matrix(((rr.x, u.x, b.x, eye.x), (rr.y, u.y, b.y, eye.y),
                       (rr.z, u.z, b.z, eye.z), (0, 0, 0, 1))).inverted()
        proj = Matrix(((1 / hw, 0, 0, 0), (0, 1 / hh, 0, 0),
                       (0, 0, -2 / (f - n), -(f + n) / (f - n)), (0, 0, 0, 1)))
        return view, proj
    if kind in ('camera', 'object'):
        fixed = None
    elif kind == 'viewport':
        fixed = (space.region_3d.view_matrix.copy(), space.region_3d.window_matrix.copy())
    else:
        fixed = framed()
    def shot(off):
        view, proj = fixed or through()
        off.draw_view3d(scene, layer, space, reg, view, proj, do_color_management=True)
        buf = off.texture_color.read()
        buf.dimensions = sw * sh * 4
        try:
            a = np.asarray(buf)
            isf = a.dtype.kind == 'f'
            a = a.astype(np.float32).reshape(-1)
            if a.size != sw * sh * 4:
                raise ValueError
        except Exception:
            a = np.asarray(buf.to_list(), dtype=np.float32)
            isf = bool(a.size) and a.max() <= 1.0001
        if isf:
            a = a * 255.0
        a = a.reshape(sh, sw, 4)[::-1, :, :3]
        a = a.reshape(h, ss, w, ss, 3).mean(axis=(1, 3))
        return np.clip(np.rint(a), 0, 255).astype(np.uint8).tobytes()
    b64 = lambda raw: base64.b64encode(raw).decode('ascii')
    if C:
        f0 = scene.frame_start
        f1 = max(f0, scene.frame_end)
        step = max(1, -(-(f1 - f0 + 1) // C['max']))
        todo = list(range(f0, f1 + 1, step))
        total = len(todo)
        todo = todo[C['from']:C['from'] + C['count']]
    t0 = time.perf_counter()
    old_type, old_ov = space.shading.type, space.overlay.show_overlays
    old_f, old_sub = scene.frame_current, scene.frame_subframe
    off = gpu.types.GPUOffScreen(sw, sh)
    shots = []
    try:
        space.shading.type = 'SOLID' if P['shading'] == 'solid' else 'MATERIAL'
        space.overlay.show_overlays = False
        if C:
            for fr in todo:
                scene.frame_set(fr)
                shots.append({'n': fr, 'rgb': b64(shot(off))})
        else:
            rgb = shot(off)
    finally:
        space.shading.type = old_type
        space.overlay.show_overlays = old_ov
        off.free()
        if C:
            scene.frame_set(old_f, subframe=old_sub)
    meta = {'scene': scene.name, 'objects': len(scene.objects),
            'ms': int((time.perf_counter() - t0) * 1000),
            'blender': bpy.app.version_string, 'view': kind, 'cam': P['cam'],
            'cams': cams, 'active': active}
    if C:
        return out(dict({'ok': True, 'clip': True, 'w': w, 'h': h, 'frames': shots, 'total': total,
                         'from': C['from'], 'step': step, 'start': f0, 'end': f1,
                         'fps': r.fps / r.fps_base}, **meta))
    out(dict({'ok': True, 'w': w, 'h': h, 'rgb': b64(rgb)}, **meta))
try:
    main()
except Exception as ex:
    out({'ok': False, 'code': 'error', 'message': str(ex)[:300]})
`
}
