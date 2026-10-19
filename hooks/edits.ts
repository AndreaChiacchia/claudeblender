// Whether the Python of an `execute_blender_code` call may change the scene, so that a call that only reads draws nothing. Pure.
//
// It leans to yes. A script reads only when nothing in it can write: no operator (`bpy.ops`), no `bmesh`, `exec` or `setattr`,
// no assignment to an attribute or to an item of anything but a local list or dict, and no method call outside a set known to
// read (or a list or dict method on a local one). A wrong yes costs one draw; a wrong no leaves the picture stale until the
// next edit or /blender refresh.

/** Words that can write whatever follows them. */
const WRITERS = /\b(?:ops|bmesh|exec|eval|setattr|delattr|__import__|del)\b/

/** An assignment operator, plain or augmented, and not a comparison. */
const ASSIGN = String.raw`(?:\*\*|//|>>|<<|[-+*/%@&|^])?=(?!=)`
/** One subscript, `[...]`, on one line. */
const SUBSCRIPT = String.raw`\[[^\n;]*?\]\s*`

/** `x.y = …`, `x.y[0] += …`. */
const ATTR_SET = new RegExp(String.raw`\.\s*\w+\s*(?:${SUBSCRIPT})*${ASSIGN}`)
/** `name[…] = …` on a bare name. */
const ITEM_SET = new RegExp(String.raw`(?<![\w.\])"])(\w+)\s*(?:${SUBSCRIPT})+${ASSIGN}`, 'g')
/** `name = []`, `name = {}`, `name: dict = dict()`: a local list, dict or set. */
const CONTAINER = new RegExp(
  String.raw`(?<![\w.])(\w+)\s*(?::[^=\n]*)?=(?!=)\s*(?:\[|\{|(?:collections\s*\.\s*)?(?:dict|list|set|defaultdict|OrderedDict|Counter|deque)\s*\()`,
  'g',
)
/** `.name(` */
const CALL = /\.\s*(\w+)\s*\(/g

/** Methods that only read, on anything. With the `to_`, `is_` and `as_` prefixes and the `_get` suffix. */
const READ_METHODS: ReadonlySet<string> = new Set([
  // dict, list, str
  'get', 'keys', 'values', 'items', 'find', 'rfind', 'index', 'rindex', 'count', 'copy',
  'join', 'split', 'rsplit', 'splitlines', 'partition', 'rpartition', 'strip', 'lstrip', 'rstrip',
  'lower', 'upper', 'title', 'capitalize', 'casefold', 'swapcase', 'startswith', 'endswith', 'replace',
  'format', 'format_map', 'encode', 'decode', 'zfill', 'ljust', 'rjust', 'center', 'expandtabs',
  'isdigit', 'isalpha', 'isalnum', 'isspace', 'isupper', 'islower', 'isidentifier',
  // mathutils
  'dot', 'cross', 'angle', 'angle_signed', 'normalized', 'inverted', 'inverted_safe', 'transposed', 'adjugated',
  'decompose', 'lerp', 'slerp', 'project', 'reflect', 'rotation_difference', 'orthogonal', 'freeze', 'determinant',
  // bpy reads
  'evaluated_get', 'ray_cast', 'closest_point_on_mesh', 'calc_matrix_camera', 'view_frame', 'evaluate',
  'path_resolve', 'path_from_id', 'temp_override', 'lookup', 'abspath', 'basename', 'display_name', 'relpath',
  // re, datetime, numbers
  'match', 'search', 'fullmatch', 'findall', 'finditer', 'group', 'groups', 'groupdict', 'span',
  'isoformat', 'strftime', 'total_seconds', 'timestamp', 'hex', 'bit_length', 'is_integer',
  // numpy
  'tolist', 'tobytes', 'reshape', 'astype', 'mean', 'sum', 'min', 'max', 'round', 'flatten', 'ravel', 'all', 'any',
  'argmax', 'argmin', 'clip', 'std', 'nonzero',
])

/** What a local list, dict or set may have called on it. */
const LOCAL_MUTATORS: ReadonlySet<string> = new Set([
  'append', 'extend', 'insert', 'pop', 'remove', 'clear', 'update', 'add', 'discard', 'setdefault', 'popitem',
  'sort', 'reverse', 'appendleft', 'extendleft', 'popleft',
])

/** Modules and types whose functions never touch the scene. */
const SAFE_HEADS: ReadonlySet<string> = new Set([
  'json', 'math', 'time', 're', 'random', 'os', 'sys', 'statistics', 'itertools', 'functools', 'operator', 'string',
  'textwrap', 'base64', 'struct', 'hashlib', 'datetime', 'traceback', 'pprint', 'collections', 'np', 'numpy',
  'mathutils', 'Vector', 'Matrix', 'Euler', 'Quaternion', 'Color',
])

const isReadMethod = (name: string): boolean =>
  READ_METHODS.has(name) || /^(?:to|is|as)_/.test(name) || /_get$/.test(name)

/** The source with its comments dropped and every string literal emptied to `""`, so neither is read as code. */
export function codeOnly(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i] ?? ''
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = src.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch
      i += quote.length
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src.startsWith(quote, i)) {
          i += quote.length
          break
        }
        // An unclosed one-line string ends at the line.
        if (quote.length === 1 && src[i] === '\n') break
        i++
      }
      out += '""'
      continue
    }
    out += ch
    i++
  }

  return out
}

/** `text` without its trailing subscripts (`a[0]['k']` gives `a`); null when a bracket does not close. */
function dropSubscripts(text: string): { rest: string; had: boolean } | null {
  let rest = text.trimEnd()
  let had = false
  while (rest.endsWith(']')) {
    let depth = 0
    let i = rest.length - 1
    for (; i >= 0; i--) {
      if (rest[i] === ']') depth++
      else if (rest[i] === '[' && --depth === 0) break
    }
    if (i < 0) return null
    rest = rest.slice(0, i).trimEnd()
    had = true
  }

  return { rest, had }
}

/**
 * What a method is called on, from the code before its dot: a string literal, a dotted chain of names (`obj.data.materials`,
 * its subscripts dropped), or null for anything else (a call's result, a chain under a subscript).
 */
function receiverOf(before: string): { kind: 'string' } | { kind: 'chain'; names: string[]; subscripted: boolean } | null {
  const trimmed = before.trimEnd()
  if (trimmed.endsWith('"')) return { kind: 'string' }
  const dropped = dropSubscripts(trimmed)
  if (dropped === null) return null
  const m = /((?:\w+\s*\.\s*)*\w+)$/.exec(dropped.rest)
  if (m === null) return null
  // A chain right after `.`, `]`, `)` or a string on the same line hangs off something else.
  if (/[.\])"][ \t]*$/.test(dropped.rest.slice(0, m.index))) return null

  return { kind: 'chain', names: (m[1] ?? '').split('.').map(s => s.trim()), subscripted: dropped.had }
}

/** True when `code` may change the Blender scene; false only when every line of it reads. Anything not a string may. */
export function changesScene(code: unknown): boolean {
  if (typeof code !== 'string') return true
  const src = codeOnly(code)
  if (WRITERS.test(src) || ATTR_SET.test(src)) return true

  const locals = new Set<string>()
  for (const m of src.matchAll(CONTAINER)) if (m[1] !== undefined) locals.add(m[1])

  for (const m of src.matchAll(ITEM_SET)) {
    if (m[1] === undefined || !locals.has(m[1])) return true
  }

  for (const m of src.matchAll(CALL)) {
    const name = m[1] ?? ''
    if (isReadMethod(name)) continue
    const receiver = receiverOf(src.slice(0, m.index))
    if (receiver === null) return true
    if (receiver.kind === 'string') continue
    const head = receiver.names[0] ?? ''
    if (SAFE_HEADS.has(head)) continue
    if (receiver.names.length === 1 && locals.has(head) && LOCAL_MUTATORS.has(name)) continue

    return true
  }

  return false
}
