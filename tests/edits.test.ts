import { expect, test } from 'claude-code/testing'

import { changesScene, codeOnly } from '../hooks/edits'

const reads = (code: string): void => expect(changesScene(code)).toBe(false)
const writes = (code: string): void => expect(changesScene(code)).toBe(true)

test('codeOnly drops comments and empties strings of every kind', () => {
  expect(codeOnly("x = 1  # bpy.ops.mesh.delete()\ny = 'a.b = 1'")).toBe('x = 1  \ny = ""')
  expect(codeOnly('s = """\nobj.location = 1\n"""\nt = r"\\d"')).toBe('s = ""\nt = r""')
  expect(codeOnly("s = 'it\\'s'; u = 2")).toBe('s = ""; u = 2')
  expect(codeOnly('f"{o.name}".join(x)')).toBe('f"".join(x)')
})

test('typical reading scripts read', () => {
  reads('print(len(bpy.data.objects))')
  reads('for o in bpy.data.objects:\n    print(o.name, o.type, tuple(o.location))')
  reads(
    [
      'import bpy, json',
      'info = {}',
      "info['objects'] = []",
      'for o in bpy.context.scene.objects:',
      "    info['objects'].append({'name': o.name, 'loc': list(o.matrix_world.to_translation())})",
      "info['camera'] = bpy.context.scene.camera.name if bpy.context.scene.camera else None",
      'print(json.dumps(info))',
    ].join('\n'),
  )
  reads("names = []\nfor m in bpy.data.materials:\n    names.append(m.name)\nprint(', '.join(sorted(names)))")
  reads("o = bpy.data.objects.get('Cube')\nprint(o.dimensions, o.matrix_world.inverted() @ Vector((0, 0, 0)))")
  reads('dg = bpy.context.evaluated_depsgraph_get()\nev = bpy.data.objects["Cube"].evaluated_get(dg)\nprint(len(ev.data.vertices))')
  reads('import re\npat = re.compile(r"^Cube")\nprint([o.name for o in bpy.data.objects if pat.match(o.name)])')
  reads('print(bpy.context.scene.frame_current == 1, bpy.context.scene.render.fps >= 24)')
  reads('n = 0\nfor o in bpy.data.objects:\n    n += 1\nprint(n)')
  reads('print(f"{bpy.context.scene.name=}")')
  reads('# bpy.ops.object.delete()\nprint("bpy.ops would delete it: obj.location = 0")')
})

test('operators, bmesh, exec and setattr write', () => {
  writes('bpy.ops.mesh.primitive_cube_add(size=2)')
  writes('from bpy import ops\nops.object.delete()')
  writes('import bmesh\nbm = bmesh.new()')
  writes('exec(code)')
  writes("setattr(bpy.data.objects['Cube'], 'location', (0, 0, 1))")
  writes("del bpy.data.objects['Cube']['prop']")
})

test('assignments to attributes and to items of scene data write', () => {
  writes("bpy.data.objects['Cube'].location = (0, 0, 1)")
  writes('obj.location.z += 0.5')
  writes('obj.location[2] = 1')
  writes('o.matrix_world @= M')
  writes("o['custom'] = 1")
  writes('v = o.location\nv[0] = 2')
  writes('bpy.context.view_layer.objects.active = o')
  writes('mat.node_tree.nodes["Principled BSDF"].inputs[0].default_value = (1, 0, 0, 1)')
})

test('calls that can write do, on anything but a local list or dict', () => {
  writes("bpy.data.meshes.new('M')")
  writes('bpy.data.objects.remove(o)')
  writes('bpy.context.collection.objects.link(o)')
  writes('o.data.materials.append(mat)')
  writes('bpy.context.scene.frame_set(10)')
  writes("o.rotation_euler.rotate_axis('Z', 0.5)")
  writes('o.hide_set(True)')
  writes('o.select_set(True)')
  writes('me.update()')
  writes('o.keyframe_insert("location")')
  writes('get_obj().select_set(True)')
  writes('objs[0].hide_set(True)')
  writes('do_the_thing.run()')
})

test('a local container is not mistaken for scene data, but its look-alike is', () => {
  reads("d = {}\nd['a'] = 1\nd.update({'b': 2})\nd.setdefault('c', 3)\nprint(d)")
  // A method on a call's result could be on anything: it may write.
  writes("d = {}\nd.setdefault('c', []).append(3)")
  writes("d = o.data\nd.update()")
  writes("cube['a'] = 1")
})

test('anything not a string may change the scene', () => {
  expect(changesScene(undefined)).toBe(true)
  expect(changesScene(42)).toBe(true)
})
