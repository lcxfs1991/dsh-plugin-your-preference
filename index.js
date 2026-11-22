/**
 * Host half of dsh-plugin-your-preference.
 *
 * Exposes an owner-authenticated HTTP API to the browser half through the
 * Host Connection's shared `/api` channel (the same trust + auth fence every
 * other DSH API route uses):
 *   GET  /api/dsh-pref/inventory  -> the current Harness inventory as JSON
 *   GET  /api/dsh-pref/git        -> git state of this plugin's own checkout
 *   POST /api/dsh-pref/git        -> stage/commit the checkout (git capability)
 *   GET  /api/dsh-pref/export     -> a ZIP (YAML manifest + all user skills)
 *   POST /api/dsh-pref/import     -> apply an exported ZIP
 *
 * The inventory is assembled from the same Host services the Plugins page
 * uses (`pluginManager` and `skills`), plus a direct scan of `~/.dsh/skills`
 * so the dialog can show exactly which skills ship in an export.
 */

const INVENTORY_PATH = '/api/dsh-pref/inventory'
const GIT_PATH = '/api/dsh-pref/git'
const EXPORT_PATH = '/api/dsh-pref/export'
const IMPORT_PATH = '/api/dsh-pref/import'
const MAX_BODY_BYTES = 256 * 1024 * 1024

/** Harness product identity, constant for the dialog heading. */
const HARNESS_NAME = 'DeepSeek Harness'
/** Entry name of the YAML document inside the exported archive. */
const MANIFEST_ENTRY = 'manifest.yaml'
/** Prefix for packaged user skills inside the exported archive. */
const SKILLS_PREFIX = 'skills/'
/** Archive schema version; bump when the layout changes incompatibly. */
const ARCHIVE_SCHEMA_VERSION = 2

/** @param ctx - the Host plugin context. */
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
      path: GIT_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: () => jsonResponse(gitStatus(ctx)),
    }),
    connection.fetch.register({
      path: GIT_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: request => gitCommit(ctx, request),
    }),
    connection.fetch.register({
      path: EXPORT_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: () => exportResponse(ctx, pluginManager, skills, readInventory),
    }),
    connection.fetch.register({
      path: IMPORT_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: request => importResponse(ctx, pluginManager, request),
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

/* ------------------------------------------------------------------ *
 * Git capability: report and commit this plugin's own checkout.
 * ------------------------------------------------------------------ */

/** Locate the plugin checkout (this module's directory). */
function pluginDirectory() {
  return nodePath.dirname(fileURLToPath(import.meta.url))
}

/** Run a git command in the checkout, returning trimmed stdout or throwing. */
function runGit(args, options = {}) {
  const { execFileSync } = nodeChildProcess
  return execFileSync('git', args, {
    cwd: pluginDirectory(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

/** Read the current git state of the plugin repository. */
function gitStatus(ctx) {
  try {
    const inside = runGit(['rev-parse', '--is-inside-work-tree'])
    if (inside !== 'true') return { ok: false, error: 'Not inside a git work tree' }
    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
    const commit = runGit(['rev-parse', '--short', 'HEAD'])
    const log = runGit(['log', '-1', '--pretty=format:%s'])
    const porcelain = runGit(['status', '--porcelain=v1', '--untracked-files=all'])
    const changed = porcelain.length > 0 ? porcelain.split('\n').filter(Boolean) : []
    let remote = ''
    try { remote = runGit(['remote', 'get-url', 'origin']) } catch { /* no origin */ }
    return {
      ok: true, repository: pluginDirectory(), branch, commit, lastCommit: log,
      remote: remote || undefined, clean: changed.length === 0,
      changed, changedCount: changed.length,
    }
  } catch (error) {
    ctx.logger.warn('dsh-plugin-your-preference: git status failed', error)
    return { ok: false, error: String(error) }
  }
}

/** Stage the checkout and create a commit with the supplied message. */
async function gitCommit(ctx, request) {
  let body
  try {
    body = JSON.parse(await readBounded(request, 64 * 1024))
  } catch (error) {
    return jsonResponse({ ok: false, error: `Invalid request: ${String(error)}` }, 400)
  }
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  if (message.length === 0) return jsonResponse({ ok: false, error: 'Commit message is required' }, 400)
  try {
    runGit(['add', '-A'])
    const porcelain = runGit(['status', '--porcelain=v1', '--untracked-files=all'])
    if (porcelain.length === 0) {
      return jsonResponse({ ok: true, committed: false, note: 'Nothing to commit; working tree clean.' })
    }
    runGit(['commit', '-m', message])
    const commit = runGit(['rev-parse', '--short', 'HEAD'])
    return jsonResponse({ ok: true, committed: true, commit })
  } catch (error) {
    ctx.logger.warn('dsh-plugin-your-preference: git commit failed', error)
    return jsonResponse({ ok: false, error: String(error) }, 422)
  }
}

/* ------------------------------------------------------------------ *
 * Skill filesystem scan: exactly the skills shipped in `~/.dsh/skills`.
 * ------------------------------------------------------------------ */

/** Resolve the user skills directory (`$DSH_HOME/skills`, default `~/.dsh/skills`). */
function userSkillsDirectory() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? nodePath.resolve(process.env.DSH_HOME)
    : nodePath.join(nodeOs.homedir(), '.dsh')
  return nodePath.join(home, 'skills')
}

/**
 * Scan a skills root. Both layouts DSH understands are supported:
 *   <root>/<name>/SKILL.md + resources   (directory bundle)
 *   <root>/<name>.md                     (flat skill)
 * Returns metadata plus a relative file list used by export.
 */
async function scanUserSkills(ctx) {
  const root = userSkillsDirectory()
  const skillsFound = []
  let entries
  try {
    entries = await nodeFs.promises.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      ctx.logger.warn('dsh-plugin-your-preference: cannot read skills directory', root, error)
    }
    return { root, skills: skillsFound }
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === '.system') continue
    try {
      if (entry.isDirectory()) {
        const skillFile = nodePath.join(root, entry.name, 'SKILL.md')
        const stat = await nodeFs.promises.stat(skillFile).catch(() => undefined)
        if (!stat?.isFile()) continue
        const parsed = parseSkillMarkdown(await nodeFs.promises.readFile(skillFile, 'utf8'))
        const files = await listRelativeFiles(nodePath.join(root, entry.name))
        skillsFound.push({
          name: parsed.name ?? entry.name,
          directory: entry.name,
          description: parsed.description ?? '',
          whenToUse: parsed.whenToUse,
          source: 'user-dsh',
          path: skillFile,
          files,
        })
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const skillFile = nodePath.join(root, entry.name)
        const parsed = parseSkillMarkdown(await nodeFs.promises.readFile(skillFile, 'utf8'))
        skillsFound.push({
          name: parsed.name ?? entry.name.slice(0, -3),
          directory: null,
          file: entry.name,
          description: parsed.description ?? '',
          whenToUse: parsed.whenToUse,
          source: 'user-dsh',
          path: skillFile,
          files: [entry.name],
        })
      }
    } catch (error) {
      ctx.logger.warn('dsh-plugin-your-preference: skipped skill entry', entry.name, error)
    }
  }
  return { root, skills: skillsFound }
}

/** Recursively list files below dir as POSIX relative paths. */
async function listRelativeFiles(dir, prefix = '') {
  const out = []
  const entries = await nodeFs.promises.readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...await listRelativeFiles(nodePath.join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** Parse the minimal YAML frontmatter DSH uses in SKILL.md files. */
function parseSkillMarkdown(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return {}
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return {}
  const frontmatter = normalized.slice(4, end)
  const result = {}
  for (const line of frontmatter.split('\n')) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[match[1]] = value
  }
  return result
}

/* ------------------------------------------------------------------ *
 * Inventory.
 * ------------------------------------------------------------------ */

/** Resolve the running CLI version from the installation manifest. */
function harnessVersion() {
  const candidates = []
  if (typeof process.env.DSH_INSTALL_DIR === 'string' && process.env.DSH_INSTALL_DIR.length > 0) {
    candidates.push(`${process.env.DSH_INSTALL_DIR}/package.json`)
  }
  try {
    const require = createRequire(import.meta.url)
    candidates.push(require.resolve('@deepseek-ai/dsh/package.json'))
  } catch { /* ignore */ }
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

async function buildInventory(pluginManager, skills) {
  const [bundles, pluginEntries, skillSummaries, userSkills] = await Promise.all([
    safe(() => pluginManager.listBundles()),
    safe(() => pluginManager.listPlugins()),
    safe(() => skills.list()),
    safe(() => scanUserSkills({ logger: console })),
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
    userSkills: { root: userSkills?.root ?? userSkillsDirectory(), skills: userSkills?.skills ?? [] },
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

/* ------------------------------------------------------------------ *
 * Export: one ZIP with manifest.yaml + every user-skill file.
 * ------------------------------------------------------------------ */

async function exportResponse(ctx, pluginManager, skills, readInventory) {
  const inventory = await readInventory()
  const document = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    format: 'dsh-preference-zip',
    exportedBy: HARNESS_NAME,
    exportedAt: inventory.collectedAt,
    product: inventory.product,
    plugins: {
      defaultEnabled: inventory.plugins.defaultEnabled,
      externalInstalled: inventory.plugins.externalInstalled,
    },
    skills: (inventory.userSkills?.skills ?? []).map(skill => ({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      source: skill.source,
      files: skill.files,
    })),
  }

  const entries = [{ name: MANIFEST_ENTRY, data: Buffer.from(stringifyYaml(document), 'utf8') }]

  // Package the raw bytes of every user skill so nested resources survive.
  // Keep the skill's own folder prefix so two skills with a SKILL.md (or a
  // references/ directory) cannot collide in the archive.
  const scan = await scanUserSkills(ctx)
  for (const skill of scan.skills) {
    for (const rel of skill.files) {
      const absolute = nodePath.join(scan.root, skill.directory ?? '', rel)
      // Directory bundles keep their folder; flat skills stay flat.
      const archivePath = skill.directory ? `${SKILLS_PREFIX}${skill.directory}/${rel}` : `${SKILLS_PREFIX}${rel}`
      try {
        const data = await nodeFs.promises.readFile(absolute)
        entries.push({ name: archivePath, data })
      } catch (error) {
        ctx.logger.warn('dsh-plugin-your-preference: could not package skill file', rel, error)
      }
    }
  }

  const archive = await createZip(entries)
  return new Response(archive, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="dsh-preference.zip"',
      'cache-control': 'no-store',
    },
  })
}

/* ------------------------------------------------------------------ *
 * Import: read the ZIP, install plugins, copy skills without overwriting.
 * ------------------------------------------------------------------ */

async function importResponse(ctx, pluginManager, request) {
  let bytes
  try {
    bytes = await readBoundedBytes(request, MAX_BODY_BYTES)
  } catch (error) {
    return jsonResponse({ ok: false, error: `Cannot read request body: ${String(error)}` }, 400)
  }

  let files
  try {
    files = await readZip(bytes)
  } catch (error) {
    return jsonResponse({ ok: false, error: `Invalid ZIP archive: ${String(error)}` }, 400)
  }

  const manifestBytes = files.get(MANIFEST_ENTRY)
  if (!manifestBytes) {
    return jsonResponse({ ok: false, error: `Archive is missing ${MANIFEST_ENTRY}` }, 400)
  }

  let manifest
  try {
    manifest = parseYaml(new TextDecoder().decode(manifestBytes))
  } catch (error) {
    return jsonResponse({ ok: false, error: `Invalid manifest YAML: ${String(error)}` }, 400)
  }
  if (manifest?.schemaVersion !== ARCHIVE_SCHEMA_VERSION) {
    return jsonResponse({ ok: false, error: `Unsupported manifest: expected schemaVersion ${ARCHIVE_SCHEMA_VERSION}` }, 400)
  }

  const result = await applyManifest(ctx, pluginManager, manifest, files)
  return jsonResponse(result, result.ok ? 200 : 422)
}

/** Apply an imported manifest. Plugins install/enable; skills copy without overwrites. */
async function applyManifest(ctx, pluginManager, manifest, archiveFiles) {
  const report = {
    ok: true,
    plugins: [], skills: [], conflicts: [], notes: [],
  }

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

  // Copy every packaged skill file into ~/.dsh/skills. On a conflict (a file
  // that already exists) skip it and tell the user; never overwrite.
  const destination = userSkillsDirectory()
  try {
    await nodeFs.promises.mkdir(destination, { recursive: true })
  } catch (error) {
    report.ok = false
    report.notes.push(`Cannot create skills directory ${destination}: ${String(error)}`)
    return report
  }

  const skillEntries = [...archiveFiles.keys()]
    .filter(name => name.startsWith(SKILLS_PREFIX) && !name.endsWith('/'))
    .sort()

  for (const entry of skillEntries) {
    const relative = entry.slice(SKILLS_PREFIX.length)
    if (!isSafeRelativePath(relative)) {
      report.conflicts.push({ path: relative, reason: 'unsafe path in archive' })
      report.ok = false
      continue
    }
    const target = nodePath.join(destination, relative)
    try {
      await nodeFs.promises.mkdir(nodePath.dirname(target), { recursive: true })
      // 'wx' fails with EEXIST instead of clobbering an existing skill.
      await nodeFs.promises.writeFile(target, archiveFiles.get(entry), { flag: 'wx' })
      report.skills.push({ path: relative, action: 'installed' })
    } catch (error) {
      if (error?.code === 'EEXIST') {
        report.conflicts.push({ path: relative, reason: 'already exists; not overwritten' })
      } else {
        report.ok = false
        report.skills.push({ path: relative, action: 'install', error: String(error) })
      }
    }
  }

  // The filesystem skill provider watches ~/.dsh/skills and invalidates its
  // catalog automatically after these writes, so no manual refresh is needed.

  return report
}

function isSafeRelativePath(relative) {
  if (typeof relative !== 'string' || relative.length === 0) return false
  if (nodePath.isAbsolute(relative)) return false
  const normalized = nodePath.normalize(relative)
  if (normalized.startsWith('..') || normalized.includes(`..${nodePath.sep}`)) return false
  return true
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
 * Body readers.
 * ------------------------------------------------------------------ */

async function readBounded(request, limit) {
  const bytes = await readBoundedBytes(request, limit)
  return new TextDecoder().decode(bytes)
}

async function readBoundedBytes(request, limit) {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > limit) throw new Error('body too large')
  const chunks = []
  let total = 0
  for await (const chunk of request.body ?? []) {
    total += chunk.byteLength ?? chunk.length
    if (total > limit) throw new Error('body too large')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, total)
}

/* ------------------------------------------------------------------ *
 * Minimal ZIP writer/reader (stored + deflate), no external packages.
 * ------------------------------------------------------------------ */

const CRC_TABLE = buildCrcTable()
function buildCrcTable() {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
}
function crc32(buffer) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** Build a ZIP archive from [{ name, data: Buffer }] using raw deflate. */
async function createZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  const zlib = await import('node:zlib')

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const compressed = zlib.deflateRawSync(data, { level: 6 })
    const useDeflate = compressed.length < data.length
    const payload = useDeflate ? compressed : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)
    const dosTime = 0
    const dosDate = 0x0021 // 1980-01-01

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)        // version needed
    local.writeUInt16LE(0, 6)         // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBytes, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)      // version made by
    central.writeUInt16LE(20, 6)      // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)      // extra
    central.writeUInt16LE(0, 32)      // comment
    central.writeUInt16LE(0, 34)      // disk
    central.writeUInt16LE(0, 36)      // internal attrs
    central.writeUInt32LE(0, 38)      // external attrs
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)

    offset += local.length + nameBytes.length + payload.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, ...centralParts, end])
}

/** Read a ZIP into a Map<name, Buffer>, supporting stored + deflate entries. */
async function readZip(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const zlib = await import('node:zlib')
  const files = new Map()

  // Locate the end-of-central-directory record.
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('end of central directory not found')

  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central directory header')
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local file header')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)

    let data
    if (method === 0) data = Buffer.from(compressed)
    else if (method === 8) data = zlib.inflateRawSync(compressed)
    else throw new Error(`unsupported ZIP compression method ${method}`)
    if (data.length !== uncompressedSize) throw new Error(`size mismatch for ${name}`)

    files.set(name, data)
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return files
}

/* ------------------------------------------------------------------ *
 * Minimal YAML subset: block mappings, sequences and scalars.
 * ------------------------------------------------------------------ */

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
  return value.replace(/\s+#.*$/, '')
}

/* ------------------------------------------------------------------ *
 * Node built-ins.
 * ------------------------------------------------------------------ */

const nodeFs = await import('node:fs')
const nodePath = await import('node:path')
const nodeOs = await import('node:os')
const nodeChildProcess = await import('node:child_process')
const { fileURLToPath, createRequire } = await import('node:url')
