/**
 * Host half of dsh-plugin-your-preference.
 *
 * Exposes an owner-authenticated HTTP API to the browser half through the
 * Host Connection's shared `/api` channel (the same trust + auth fence every
 * other DSH API route uses):
 *   GET  /api/dsh-pref/inventory  -> the current Harness inventory as JSON
 *   GET  /api/dsh-pref/export     -> the inventory as a portable YAML document
 *   POST /api/dsh-pref/import     -> apply a YAML export (plugins + skills)
 *
 * The inventory is assembled from the same Host services the Plugins page
 * uses (`pluginManager` and `skills`), so what the dialog lists is the live
 * profile state rather than a second cache.
 */

const INVENTORY_PATH = '/api/dsh-pref/inventory'
const EXPORT_PATH = '/api/dsh-pref/export'
const IMPORT_PATH = '/api/dsh-pref/import'
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Harness product identity, constant for the dialog heading. */
const HARNESS_NAME = 'DeepSeek Harness'

/**
 * The bundle's Host entry. Requires the Host connection, the plugin manager
 * and the skill registry (all optional so the bundle stays inert in a profile
 * without them).
 */
export const inject = ['connection', 'pluginManager', 'skills']

/** @param ctx - the Host plugin context. */
export function apply(ctx) {
  const connection = ctx.get('connection')
  const pluginManager = ctx.get('pluginManager')
  const skills = ctx.get('skills')

  if (!connection?.fetch || !pluginManager || !skills) {
    ctx.logger.warn('dsh-plugin-your-preference: missing connection/pluginManager/skills; API not registered')
    return
  }

  const readInventory = () => buildInventory(pluginManager, skills)

  const disposers = [
    connection.fetch.register({
      path: INVENTORY_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: async () => jsonResponse(await readInventory()),
    }),
    connection.fetch.register({
      path: EXPORT_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: async () => exportResponse(ctx, pluginManager, skills, readInventory),
    }),
    connection.fetch.register({
      path: IMPORT_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: request => importResponse(ctx, pluginManager, skills, request),
    }),
  ]
  ctx.effect(() => async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }, 'dsh-plugin-your-preference: routes')
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Build the YAML export response, including full skill bodies. */
async function exportResponse(ctx, pluginManager, skills, readInventory) {
  const inventory = await readInventory()
  const skillsWithBodies = []
  for (const skill of inventory.skills ?? []) {
    let body
    try {
      const definition = await skills.get(skill.name)
      body = definition?.content
    } catch (error) {
      ctx.logger.warn('dsh-plugin-your-preference: could not read skill body', skill.name, error)
    }
    skillsWithBodies.push({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      provider: skill.provider,
      invocation: skill.invocation,
      ...(typeof body === 'string' ? { content: body } : {}),
    })
  }
  const document = {
    schemaVersion: 1,
    exportedBy: HARNESS_NAME,
    exportedAt: inventory.collectedAt,
    product: inventory.product,
    plugins: {
      defaultEnabled: inventory.plugins.defaultEnabled,
      externalInstalled: inventory.plugins.externalInstalled,
    },
    skills: skillsWithBodies,
  }
  const body = `# ${HARNESS_NAME} plugin & skill preference export\n${stringifyYaml(document)}`
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/yaml; charset=utf-8',
      'content-disposition': 'attachment; filename="dsh-preference.yaml"',
      'cache-control': 'no-store',
    },
  })
}

/** Handle POST /import on the authenticated channel. */
async function importResponse(ctx, pluginManager, skills, request) {
  let text
  try {
    text = await readBounded(request, MAX_BODY_BYTES)
  } catch (error) {
    return jsonResponse({ ok: false, error: `Cannot read request body: ${String(error)}` }, 400)
  }
  let manifest
  try {
    manifest = parseYaml(text)
  } catch (error) {
    return jsonResponse({ ok: false, error: `Invalid YAML: ${String(error)}` }, 400)
  }
  if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== 1) {
    return jsonResponse({ ok: false, error: 'Unsupported manifest: expected schemaVersion 1' }, 400)
  }
  const result = await applyManifest(ctx, pluginManager, skills, manifest)
  return jsonResponse(result, result.ok ? 200 : 422)
}

/** Read a bounded UTF-8 body from a Fetch Request. */
async function readBounded(request, limit) {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > limit) throw new Error('body too large')
  const chunks = []
  let total = 0
  for await (const chunk of request.body ?? []) {
    total += chunk.byteLength
    if (total > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return new TextDecoder().decode(concatBytes(chunks, total))
}

function concatBytes(chunks, total) {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
  return out
}

/** Resolve the running CLI version from the installation manifest. */
function harnessVersion() {
  const candidates = []
  if (typeof process.env.DSH_INSTALL_DIR === 'string' && process.env.DSH_INSTALL_DIR.length > 0) {
    candidates.push(`${process.env.DSH_INSTALL_DIR}/package.json`)
  }
  // Resolve from this bundle's own location: the profile links this package
  // and resolves @deepseek-ai/dsh from the installation next to it.
  try {
    const require = createRequire(import.meta.url)
    candidates.push(require.resolve('@deepseek-ai/dsh/package.json'))
  } catch { /* ignore */ }
  // The dsh bin lives in <install>/node_modules/.bin/dsh; resolve the package
  // manifest from the process entry point as a final fallback.
  try {
    if (typeof process.argv[1] === 'string') {
      const require = createRequire(process.argv[1])
      candidates.push(require.resolve('@deepseek-ai/dsh/package.json'))
    }
  } catch { /* ignore */ }
  for (const file of candidates) {
    try {
      const manifest = JSON.parse(nodeFs.readFileSync(file, 'utf8'))
      if (typeof manifest.version === 'string') return manifest.version
    } catch { /* try next */ }
  }
  return undefined
}

const nodeFs = await import('node:fs')
const { createRequire } = await import('node:module')

async function buildInventory(pluginManager, skills) {
  const [bundles, pluginEntries, skillSummaries] = await Promise.all([
    safe(() => pluginManager.listBundles()),
    safe(() => pluginManager.listPlugins()),
    safe(() => skills.list()),
  ])

  const defaultPlugins = []
  const externalPlugins = []
  for (const bundle of bundles ?? []) {
    const item = projectBundle(bundle)
    if (bundle.official === true || bundle.availability === 'installation') defaultPlugins.push(item)
    else externalPlugins.push(item)
  }

  const pluginRows = (pluginEntries ?? []).map((entry) => ({
    entryId: entry.entryId ?? entry.patchId ?? undefined,
    moduleName: entry.moduleName ?? '',
    enabled: entry.fiberPhase === 'active',
    fiberPhase: entry.fiberPhase ?? null,
  }))

  const skillItems = (skillSummaries ?? []).map((skill) => ({
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    source: skill.source,
    provider: skill.provider,
    path: skill.path,
    invocation: skill.invocation,
    content: undefined,
  }))

  return {
    ok: true,
    product: { name: HARNESS_NAME, version: harnessVersion() },
    plugins: {
      defaultEnabled: defaultPlugins,
      externalInstalled: externalPlugins,
      entries: pluginRows,
    },
    skills: skillItems,
    collectedAt: new Date().toISOString(),
  }
}

function projectBundle(bundle) {
  return {
    name: bundle.name,
    official: bundle.official === true,
    availability: bundle.availability,
    enabled: bundle.enabled === true,
    installed: bundle.installed === true,
    version: bundle.version,
    description: bundle.description,
    source: bundle.source,
    rows: (bundle.rows ?? []).map(row => ({
      rowId: row.rowId,
      moduleName: row.moduleName,
    })),
  }
}

async function safe(fn) {
  try {
    return await fn()
  } catch (error) {
    console.error('[dsh-plugin-your-preference] inventory read failed:', error)
    return []
  }
}

/**
 * Apply an exported manifest. Plugins are installed/enabled through the same
 * Host service the Plugins page uses. Skills are refreshed through their
 * providers; skills whose bodies were exported as runtime contributions are
 * registered back into `ctx.skills`.
 */
async function applyManifest(ctx, pluginManager, skills, manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'Manifest must be a mapping' }
  const report = { ok: true, plugins: [], skills: [], notes: [] }

  const currentBundles = new Map()
  try {
    for (const bundle of await pluginManager.listBundles()) currentBundles.set(bundle.name, bundle)
  } catch { /* an unreadable inventory does not block an explicit install request */ }

  const plugins = manifest.plugins ?? {}
  const bundles = [
    ...asArray(plugins.defaultEnabled),
    ...asArray(plugins.externalInstalled),
    ...asArray(plugins.bundles),
  ]

  for (const bundle of bundles) {
    if (!bundle || typeof bundle !== 'object' || typeof bundle.name !== 'string') continue
    const name = bundle.name
    const spec = typeof bundle.source === 'string' && bundle.source.length > 0 ? bundle.source : name
    try {
      const current = currentBundles.get(name)
      const present = current !== undefined && (current.installed === true || current.availability !== 'missing')
      const wantsInstall = bundle.installed === true && !isDefaultBundle(bundle)
      if (wantsInstall && !present) {
        const installed = await pluginManager.installBundle(spec)
        report.plugins.push({ name, action: 'install', result: summarizeChange(installed) })
      } else if (wantsInstall) {
        report.notes.push(`Plugin ${name} is already installed; kept as-is.`)
      }
      if (bundle.enabled === true && current?.enabled === true) {
        report.notes.push(`Plugin ${name} is already enabled.`)
      } else if (bundle.enabled === true) {
        const enabled = await pluginManager.setBundleEnabled(name, true)
        report.plugins.push({ name, action: 'enable', result: summarizeChange(enabled) })
      } else {
        report.notes.push(`Plugin ${name} was exported disabled; enable it from Plugins if needed.`)
      }
    } catch (error) {
      report.ok = false
      report.plugins.push({ name, action: 'apply', error: String(error) })
    }
  }

  for (const skill of asArray(manifest.skills)) {
    if (!skill || typeof skill !== 'object' || typeof skill.name !== 'string') continue
    // Provider-backed skills (filesystem, bundled, market) already exist after
    // install; re-registering their bodies would shadow them with a runtime
    // entry at a different rank. Only restore true runtime contributions.
    if (skill.provider !== 'runtime') {
      report.skills.push({ name: skill.name, action: 'already-available', note: `Provided by ${skill.provider ?? 'a skill provider'}.` })
      continue
    }
    if (typeof skill.content === 'string' && skill.content.length > 0) {
      try {
        const registration = {
          name: skill.name,
          description: typeof skill.description === 'string' ? skill.description : `Imported skill ${skill.name}`,
          content: skill.content,
          source: typeof skill.source === 'string' ? skill.source : 'user-dsh',
          invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
        }
        // Own the registration with this plugin's context so an imported
        // runtime skill is withdrawn when the plugin is disabled or removed.
        ctx.effect(() => skills.register(registration), `dsh-pref: skill ${skill.name}`)
        report.skills.push({ name: skill.name, action: 'register' })
      } catch (error) {
        report.ok = false
        report.skills.push({ name: skill.name, action: 'register', error: String(error) })
      }
    } else {
      report.skills.push({ name: skill.name, action: 'already-available', note: 'Discovered from its provider; no body to install.' })
    }
  }

  return report
}

function summarizeChange(result) {
  if (!result || typeof result !== 'object') return { changed: false, application: 'unknown' }
  return {
    changed: result.changed === true,
    application: result.application ?? 'unknown',
    stage: result.stage,
    target: result.target,
    error: result.error?.code ?? result.error?.message,
    warnings: result.warnings,
  }
}

function isDefaultBundle(bundle) {
  return bundle.official === true || bundle.availability === 'installation'
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

/* ------------------------------------------------------------------ *
 * Minimal YAML subset: block mappings, sequences and scalars. It is
 * intentionally small: it round-trips the shape emitted by the export
 * button and needs no third-party dependency at runtime.
 * ------------------------------------------------------------------ */

/** Serialize a JSON value as block YAML. */
function stringifyYaml(value, indent = 0) {
  const pad = ' '.repeat(indent)
  if (value === null || value === undefined) return `${pad}null\n`
  if (typeof value === 'boolean' || typeof value === 'number') return `${pad}${String(value)}\n`
  if (typeof value === 'string') return `${pad}${quoteYaml(value)}\n`
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`
    let out = ''
    for (const item of value) {
      if (isScalar(item)) {
        out += `${pad}- ${inlineScalar(item)}\n`
      } else {
        const nested = stringifyYaml(item, indent + 2).split('\n').filter(line => line.length > 0)
        const firstLine = nested.shift()?.slice(indent + 2) ?? ''
        out += `${pad}- ${firstLine}\n`
        for (const line of nested) out += `${line}\n`
      }
    }
    return out
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined)
    if (keys.length === 0) return `${pad}{}\n`
    let out = ''
    for (const key of keys) {
      const val = value[key]
      if (isScalar(val)) {
        out += `${pad}${quoteKey(key)}: ${inlineScalar(val)}\n`
      } else if (Array.isArray(val) && val.length === 0) {
        out += `${pad}${quoteKey(key)}: []\n`
      } else if (val && typeof val === 'object' && Object.keys(val).length === 0) {
        out += `${pad}${quoteKey(key)}: {}\n`
      } else {
        out += `${pad}${quoteKey(key)}:\n${stringifyYaml(val, indent + 2)}`
      }
    }
    return out
  }
  return `${pad}${quoteYaml(String(value))}\n`
}

function isScalar(value) {
  return value === null || value === undefined || ['boolean', 'number', 'string'].includes(typeof value)
}

function inlineScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return quoteYaml(String(value))
}

function quoteYaml(value) {
  if (/^[A-Za-z0-9_./@:+-]+$/.test(value) && value.length > 0 && !/^[-?:,\[\]{}#&*!|>'"%@`]/.test(value) && !looksNumeric(value)) {
    return value
  }
  return JSON.stringify(value)
}

function quoteKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

function looksNumeric(value) {
  return /^-?\d+(\.\d+)?$/.test(value)
}

/** Parse the block YAML subset emitted by stringifyYaml. */
function parseYaml(text) {
  if (typeof text !== 'string') throw new TypeError('YAML must be text')
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const entries = []
  for (const raw of lines) {
    if (raw.trim().length === 0 || raw.trimStart().startsWith('#')) continue
    const match = /^( *)(.*)$/.exec(raw)
    if (!match) continue
    entries.push({ indent: match[1].length, content: match[2] })
  }
  if (entries.length === 0) return null
  const { value, next } = parseBlock(entries, 0, entries[0].indent)
  if (next !== entries.length) throw new Error(`unexpected content at line ${entries[next].indent}`)
  return value
}

function parseBlock(entries, start, indent) {
  const first = entries[start]
  if (first.content.startsWith('- ')) return parseSequence(entries, start, indent)
  return parseMapping(entries, start, indent)
}

function parseSequence(entries, start, indent) {
  const items = []
  let i = start
  while (i < entries.length && entries[i].indent === indent && entries[i].content.startsWith('- ')) {
    const rest = entries[i].content.slice(2).trim()
    i += 1
    if (rest.length === 0) {
      if (i < entries.length && entries[i].indent > indent) {
        const parsed = parseBlock(entries, i, entries[i].indent)
        items.push(parsed.value)
        i = parsed.next
      } else {
        items.push(null)
      }
    } else if (isMappingHeader(rest)) {
      const colon = findColon(rest)
      const obj = {}
      const key = parseScalar(rest.slice(0, colon).trim())
      const inline = rest.slice(colon + 1).trim()
      if (inline.length > 0) {
        obj[key] = parseScalar(inline)
      } else if (i < entries.length && entries[i].indent > indent) {
        const parsed = parseBlock(entries, i, entries[i].indent)
        obj[key] = parsed.value
        i = parsed.next
      } else {
        obj[key] = null
      }
      if (i < entries.length && entries[i].indent > indent) {
        const continueParsed = parseMapping(entries, i, entries[i].indent)
        Object.assign(obj, continueParsed.value)
        i = continueParsed.next
      }
      items.push(obj)
    } else {
      items.push(parseScalar(rest))
    }
  }
  return { value: items, next: i }
}

function parseMapping(entries, start, indent) {
  const obj = {}
  let i = start
  while (i < entries.length && entries[i].indent === indent && !entries[i].content.startsWith('- ')) {
    const line = entries[i].content
    const colon = findColon(line)
    if (colon < 0) throw new Error(`expected ':' at line ${i + 1}`)
    const key = parseScalar(line.slice(0, colon).trim())
    if (['__proto__','constructor','prototype'].includes(String(key))) throw new Error(`unsafe YAML key: ${String(key)}`)
    const inline = line.slice(colon + 1).trim()
    i += 1
    if (inline.length === 0) {
      if (i < entries.length && entries[i].indent > indent) {
        const parsed = parseBlock(entries, i, entries[i].indent)
        obj[key] = parsed.value
        i = parsed.next
      } else {
        obj[key] = null
      }
    } else {
      obj[key] = parseScalar(inline)
    }
  }
  return { value: obj, next: i }
}

function isMappingHeader(rest) {
  return findColon(rest) >= 0
}

function findColon(text) {
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote !== null) {
      if (char === '\\') { i += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === ':') return i
  }
  return -1
}

function parseScalar(text) {
  const value = text.trim()
  if (value === 'null' || value === '~') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === '[]') return []
  if (value === '{}') return {}
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try { return JSON.parse(value) } catch { /* fall through */ }
    }
    return value.slice(1, -1).replace(/''/g, "'")
  }
  // Strip an unquoted trailing comment when preceded by whitespace.
  return value.replace(/\s+#.*$/, '')
}

