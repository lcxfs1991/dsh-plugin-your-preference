/**
 * Browser half of dsh-plugin-your-preference.
 *
 * Adds one entry to the left sidebar's foot. Activating it opens a modal
 * dialog that lists what DeepSeek Harness has: the product itself, the
 * enabled default plugins, externally installed plugins, and installed
 * skills. Export downloads the list as YAML; import sends a YAML file back
 * to the Host, which installs/enables the listed plugins and registers the
 * listed skill bodies.
 *
 * The module deliberately depends only on `react` and the built-in slot
 * services — it does not import Harness Client packages at runtime.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-your-preference',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const EXPORT_URL = '/api/dsh-pref/export'
    const IMPORT_URL = '/api/dsh-pref/import'

    // Visible copy is routed through the Client locale service at apply time;
    // these are the two shipped dictionaries.
    const NS = 'dshPreference'
    const DICTS = {
      en: {
        'sidebar.label': 'Personal Preference',
        'dialog.label': 'Personal Preference',
        'version': 'Version {0}',
        'close': 'Close',
        'export': 'Export YAML',
        'import': 'Import YAML',
        'loading': 'Loading…',
        'readInventory': 'Reading DeepSeek Harness…',
        'section.default': 'Default plugins enabled',
        'section.external': 'External installed plugins',
        'section.skills': 'Skills installed',
        'none': 'None',
        'loadError': 'Could not load inventory: {0}',
        'retry': 'Retry',
        'exportDone': 'Exported dsh-preference.yaml',
        'exportFailed': 'Export failed: {0}',
        'importDone': 'Imported: {0} plugin change(s), {1} skill change(s).',
        'importProblems': 'Import completed with {0} problem(s).',
        'importFailed': 'Import failed: {0}',
        'badge.default': 'Default',
        'badge.bundled': 'Bundled',
        'badge.installed': 'Installed',
        'badge.missing': 'Missing',
        'badge.enabled': 'Enabled',
        'badge.disabled': 'Disabled',
        'note.skills': 'Note: imported skill bodies are runtime-only and need re-import after a restart; provider-backed skills stay available after install.',
      },
      zh: {
        'sidebar.label': '个性化管理',
        'dialog.label': '个性化管理',
        'version': '版本 {0}',
        'close': '关闭',
        'export': '导出 YAML',
        'import': '导入 YAML',
        'loading': '加载中…',
        'readInventory': '正在读取 DeepSeek Harness…',
        'section.default': '已启用的默认插件',
        'section.external': '外部安装的插件',
        'section.skills': '已安装的技能',
        'none': '无',
        'loadError': '无法读取清单：{0}',
        'retry': '重试',
        'exportDone': '已导出 dsh-preference.yaml',
        'exportFailed': '导出失败：{0}',
        'importDone': '已导入：{0} 项插件变更，{1} 项技能变更。',
        'importProblems': '导入完成，但有 {0} 个问题。',
        'importFailed': '导入失败：{0}',
        'badge.default': '默认',
        'badge.bundled': '内置',
        'badge.installed': '已安装',
        'badge.missing': '缺失',
        'badge.enabled': '已启用',
        'badge.disabled': '已禁用',
        'note.skills': '提示：导入的技能正文作为运行时技能生效，重启后需重新导入；由插件或文件系统提供的技能会随安装保留。',
      },
    }

    // ---- minimal YAML reader for our own export format ----------------
    // The export endpoint is the single source of truth; reading it here
    // keeps the dialog in sync with exactly what Export downloads.
    function parseYaml(text) {
      const lines = String(text).replace(/^#.*\n/gm, '').replace(/\r\n?/g, '\n').split('\n')
      const entries = []
      for (const raw of lines) {
        if (raw.trim().length === 0) continue
        const match = /^( *)(.*)$/.exec(raw)
        if (match) entries.push({ indent: match[1].length, content: match[2] })
      }
      if (entries.length === 0) return null
      const parsed = parseBlock(entries, 0, entries[0].indent)
      return parsed.value
    }
    function parseBlock(entries, start, indent) {
      return entries[start].content.startsWith('- ')
        ? parseSequence(entries, start, indent)
        : parseMapping(entries, start, indent)
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
            items.push(parsed.value); i = parsed.next
          } else items.push(null)
        } else if (findColon(rest) >= 0) {
          const colon = findColon(rest)
          const obj = {}
          const key = parseScalar(rest.slice(0, colon).trim())
          if (['__proto__','constructor','prototype'].includes(String(key))) throw new Error(`unsafe YAML key: ${String(key)}`)
          const inline = rest.slice(colon + 1).trim()
          if (inline.length > 0) obj[key] = parseScalar(inline)
          else if (i < entries.length && entries[i].indent > indent) {
            const parsed = parseBlock(entries, i, entries[i].indent)
            obj[key] = parsed.value; i = parsed.next
          } else obj[key] = null
          if (i < entries.length && entries[i].indent > indent) {
            const more = parseMapping(entries, i, entries[i].indent)
            Object.assign(obj, more.value); i = more.next
          }
          items.push(obj)
        } else items.push(parseScalar(rest))
      }
      return { value: items, next: i }
    }
    function parseMapping(entries, start, indent) {
      const obj = {}
      let i = start
      while (i < entries.length && entries[i].indent === indent && !entries[i].content.startsWith('- ')) {
        const line = entries[i].content
        const colon = findColon(line)
        if (colon < 0) throw new Error(`expected ':' in YAML line ${i + 1}`)
        const key = parseScalar(line.slice(0, colon).trim())
        const inline = line.slice(colon + 1).trim()
        i += 1
        if (inline.length === 0) {
          if (i < entries.length && entries[i].indent > indent) {
            const parsed = parseBlock(entries, i, entries[i].indent)
            obj[key] = parsed.value; i = parsed.next
          } else obj[key] = null
        } else obj[key] = parseScalar(inline)
      }
      return { value: obj, next: i }
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
      const value = String(text).trim()
      if (value === 'null' || value === '~') return null
      if (value === 'true') return true
      if (value === 'false') return false
      if (value === '[]') return []
      if (value === '{}') return {}
      if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        if (value.startsWith('"')) { try { return JSON.parse(value) } catch { /* fall through */ } }
        return value.slice(1, -1).replace(/''/g, "'")
      }
      return value.replace(/\s+#.*$/, '')
    }

    // ---- shared open/close state (observable store) ------------------
    function createDialogState() {
      let open = false
      const listeners = new Set()
      const publish = (next) => {
        if (open === next) return
        open = next
        for (const listener of listeners) listener()
      }
      return {
        hooks: {
          open: {
            getSnapshot: () => open,
            subscribe(listener) {
              listeners.add(listener)
              return () => { listeners.delete(listener) }
            },
          },
        },
        open: () => publish(true),
        close: () => publish(false),
      }
    }

    // ---- small UI primitives (host themed) ---------------------------
    function Spinner() {
      return h('span', {
        'aria-hidden': 'true',
        style: {
          display: 'inline-block', width: 13, height: 13, borderRadius: '50%',
          border: '2px solid currentColor', borderRightColor: 'transparent',
          animation: 'dsh-pref-spin 0.7s linear infinite', verticalAlign: '-2px',
        },
      })
    }

    function PluginRow({ item, t }) {
      const badges = []
      if (item.official) badges.push(t('badge.default'))
      else if (item.availability === 'installation') badges.push(t('badge.bundled'))
      if (item.installed) badges.push(t('badge.installed'))
      if (item.availability === 'missing') badges.push(t('badge.missing'))
      badges.push(t(item.enabled ? 'badge.enabled' : 'badge.disabled'))
      return h('li', {
        style: {
          display: 'flex', alignItems: 'baseline', gap: 8,
          padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
        },
      },
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { style: { fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' } }, item.name),
          item.description ? h('div', {
            style: { fontSize: 12, opacity: 0.7, marginTop: 2, overflowWrap: 'anywhere' },
          }, item.description) : null,
        ),
        h('span', {
          style: {
            flexShrink: 0, fontSize: 11, opacity: 0.75,
            color: item.enabled ? 'var(--dsw-alias-state-success-primary, #2f855a)' : 'var(--dsw-alias-label-secondary, inherit)',
          },
        }, badges.join(' · ')),
      )
    }

    function SkillRow({ item }) {
      return h('li', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 2,
          padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
        },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
          h('span', { style: { fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' } }, item.name),
          h('span', { style: { fontSize: 11, opacity: 0.7, flexShrink: 0 } }, item.source || item.provider),
        ),
        item.description ? h('span', { style: { fontSize: 12, opacity: 0.75, overflowWrap: 'anywhere' } }, item.description) : null,
      )
    }

    function Section({ title, count, children, t }) {
      return h('section', { style: { marginTop: 18 } },
        h('h3', {
          style: {
            margin: '0 0 6px', fontSize: 14, fontWeight: 600,
            color: 'var(--dsw-alias-label-primary, inherit)',
          },
        }, `${title} (${count})`),
        count === 0
          ? h('div', { style: { fontSize: 12, opacity: 0.6, padding: '6px 0' } }, t('none'))
          : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } }, children),
      )
    }

    // ---- the dialog ---------------------------------------------------
    function PreferenceDialog({ useOpen, close, t }) {
      const open = useOpen(current => current)
      const [state, setState] = useState({ status: 'idle', data: null, error: null, action: null, actionResult: null })
      const fileRef = useRef(null)
      const closeRef = useRef(null)
      const dialogRef = useRef(null)

      const load = useCallback(async () => {
        setState({ status: 'loading', data: null, error: null, action: null, actionResult: null })
        try {
          const response = await fetch(EXPORT_URL, { headers: { Accept: 'application/yaml' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const manifest = parseYaml(await response.text())
          if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== 1) {
            throw new Error('unsupported manifest schema')
          }
          const data = {
            product: manifest?.product,
            plugins: {
              defaultEnabled: manifest?.plugins?.defaultEnabled ?? [],
              externalInstalled: manifest?.plugins?.externalInstalled ?? [],
            },
            skills: manifest?.skills ?? [],
          }
          setState({ status: 'ready', data, error: null, action: null, actionResult: null })
        } catch (error) {
          setState({ status: 'error', data: null, error: String(error), action: null, actionResult: null })
        }
      }, [])

      useEffect(() => {
        if (open) void load()
      }, [open, load])

      // Escape to close and Tab focus trap, matching host modal behavior;
      // focus moves into the dialog on open and returns to the opener on close.
      useEffect(() => {
        if (!open) return undefined
        const previous = document.activeElement
        const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0)
        const onKey = (event) => {
          if (event.key === 'Escape') { close(); return }
          if (event.key !== 'Tab' || dialogRef.current === null) return
          const focusable = dialogRef.current.querySelectorAll('button:not([disabled]), [href], input:not([disabled])')
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
        window.addEventListener('keydown', onKey, true)
        return () => {
          window.clearTimeout(focusTimer)
          window.removeEventListener('keydown', onKey, true)
          if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
        }
      }, [open, close])

      const onExport = async () => {
        setState(current => ({ ...current, action: 'export', actionResult: null }))
        try {
          const response = await fetch(EXPORT_URL)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const blob = await response.blob()
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = 'dsh-preference.yaml'
          document.body.appendChild(link)
          link.click()
          link.remove()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
          setState(current => ({ ...current, action: null, actionResult: { ok: true, text: t('exportDone') } }))
        } catch (error) {
          setState(current => ({ ...current, action: null, actionResult: { ok: false, text: t('exportFailed', { 0: String(error) }) } }))
        }
      }

      const onImportFile = async (event) => {
        const file = event.target.files?.[0]
        if (!file) return
        event.target.value = ''
        setState(current => ({ ...current, action: 'import', actionResult: null }))
        try {
          const text = await file.text()
          const response = await fetch(IMPORT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/yaml; charset=utf-8' },
            body: text,
          })
          const result = await response.json()
          const pluginActions = (result.plugins ?? []).filter(item => item.result || item.error)
          const skillActions = (result.skills ?? []).filter(item => item.action === 'register' || item.error)
          const problems = [
            ...(result.plugins ?? []).filter(item => item.error).map(item => `${item.name}: ${item.error}`),
            ...(result.skills ?? []).filter(item => item.error).map(item => `${item.name}: ${item.error}`),
            ...(result.error ? [result.error] : []),
          ]
          const summary = problems.length > 0
            ? t('importProblems', { 0: String(problems.length) })
            : t('importDone', { 0: String(pluginActions.length), 1: String(skillActions.length) })
          setState(current => ({
            ...current, action: null,
            actionResult: { ok: problems.length === 0, text: summary, problems, notes: result.notes ?? [] },
          }))
          if (pluginActions.length > 0 || skillActions.length > 0) void load()
        } catch (error) {
          setState(current => ({ ...current, action: null, actionResult: { ok: false, text: t('importFailed', { 0: String(error) }) } }))
        }
      }

      if (!open) return null

      const data = state.data
      const defaultPlugins = data?.plugins?.defaultEnabled ?? []
      const externalPlugins = data?.plugins?.externalInstalled ?? []
      const skills = data?.skills ?? []
      const busy = state.action !== null

      return h('div', {
        role: 'presentation',
        onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) close() },
        style: {
          position: 'fixed', inset: 0, zIndex: 10000,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        },
      },
        h('style', {}, '@keyframes dsh-pref-spin{to{transform:rotate(360deg)}}'),
        h('div', {
          ref: dialogRef,
          role: 'dialog', 'aria-modal': 'true', 'aria-label': t('dialog.label'),
          style: {
            width: 'min(680px, 100%)', maxHeight: 'min(80vh, 720px)',
            display: 'flex', flexDirection: 'column',
            background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #fff))',
            color: 'var(--dsw-alias-label-primary, inherit)',
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
            borderRadius: 12,
            boxShadow: '0 18px 60px rgba(0,0,0,0.3)',
            fontFamily: 'inherit',
          },
        },
          // header
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '16px 20px', borderBottom: '1px solid var(--dsw-alias-line-secondary, rgba(128,128,128,0.18))',
            },
          },
            h('div', {},
              h('h2', { style: { margin: 0, fontSize: 17, fontWeight: 650 } }, 'DeepSeek Harness'),
              data?.product?.version
                ? h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 2 } }, t('version', { 0: data.product.version }))
                : null,
            ),
            h('button', {
              ref: closeRef,
              type: 'button', 'aria-label': t('close'), onClick: close,
              style: {
                border: 0, background: 'transparent', cursor: 'pointer',
                fontSize: 20, lineHeight: 1, padding: '4px 8px', color: 'inherit', opacity: 0.7,
              },
            }, '×'),
          ),

          // actions
          h('div', {
            style: {
              display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
              padding: '12px 20px', borderBottom: '1px solid var(--dsw-alias-line-secondary, rgba(128,128,128,0.18))',
            },
          },
            h('button', {
              type: 'button', onClick: () => void onExport(), disabled: busy,
              style: buttonStyle(),
            }, busy === 'export' ? h(Spinner) : null, t('export')),
            h('button', {
              type: 'button', onClick: () => fileRef.current?.click(), disabled: busy,
              style: buttonStyle(),
            }, busy === 'import' ? h(Spinner) : null, t('import')),
            h('input', {
              ref: fileRef, type: 'file', accept: '.yaml,.yml,text/yaml,application/yaml',
              style: { display: 'none' }, onChange: (event) => void onImportFile(event),
            }),
            state.status === 'loading' ? h('span', { style: { fontSize: 12, opacity: 0.7, marginLeft: 4 } }, h(Spinner), ' ' + t('loading')) : null,
          ),

          // action result
          state.actionResult
            ? h('div', {
              role: 'status',
              style: {
                margin: '12px 20px 0', padding: '8px 12px', borderRadius: 8, fontSize: 12,
                background: state.actionResult.ok
                  ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f855a) 12%, transparent)'
                  : 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 12%, transparent)',
              },
            },
              state.actionResult.text,
              (state.actionResult.problems ?? []).length > 0
                ? h('ul', { style: { margin: '6px 0 0', paddingLeft: 18 } },
                    state.actionResult.problems.map((problem, index) => h('li', { key: index }, problem)))
                : null,
            )
            : null,

          // body
          h('div', {
            style: { padding: '4px 20px 20px', overflowY: 'auto', flex: 1 },
          },
            state.status === 'error'
              ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #c0392b)', fontSize: 13 } },
                  t('loadError', { 0: state.error }),
                  h('button', { type: 'button', onClick: () => void load(), style: { ...buttonStyle(), marginLeft: 8 } }, t('retry')),
                )
              : state.status === 'loading'
                ? h('div', { style: { padding: '24px 0', fontSize: 13, opacity: 0.7 } }, h(Spinner), ' ' + t('readInventory'))
                : h('div', {},
                    h(Section, { title: t('section.default'), count: defaultPlugins.length, t },
                      defaultPlugins.map((item, index) => h(PluginRow, { key: `d-${index}`, item, t }))),
                    h(Section, { title: t('section.external'), count: externalPlugins.length, t },
                      externalPlugins.map((item, index) => h(PluginRow, { key: `e-${index}`, item, t }))),
                    h(Section, { title: t('section.skills'), count: skills.length, t },
                      skills.map((item, index) => h(SkillRow, { key: `s-${index}`, item }))),
                    h('div', {
                      style: { marginTop: 16, fontSize: 11, opacity: 0.65, lineHeight: 1.5 },
                    }, t('note.skills')),
                  ),
          ),
        ),
      )
    }

    function buttonStyle() {
      return {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', fontSize: 13, fontWeight: 550,
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
        borderRadius: 7, cursor: 'pointer',
      }
    }

    // ---- the sidebar foot entry --------------------------------------
    function SidebarEntry({ open, t, wide }) {
      const label = t('sidebar.label')
      const glyph = h('svg', { width: wide ? 16 : 18, height: wide ? 16 : 18, viewBox: '0 0 36 36', 'aria-hidden': 'true', style: { flexShrink: 0 } },
        h('rect', { x: 6, y: 5, width: 16, height: 11, rx: 2.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4 }),
        h('rect', { x: 14, y: 20, width: 16, height: 11, rx: 2.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4 }),
        h('line', { x1: 10, y1: 10.5, x2: 18, y2: 10.5, stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' }),
        h('line', { x1: 18, y1: 25.5, x2: 26, y2: 25.5, stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' }),
      )
      return h('button', {
        type: 'button',
        title: label,
        'aria-label': label,
        onClick: open,
        style: {
          display: 'flex', alignItems: 'center',
          justifyContent: wide ? 'flex-start' : 'center',
          gap: wide ? 10 : 0,
          width: wide ? '100%' : 28, height: 28,
          padding: wide ? '0 8px' : 0, border: 0, borderRadius: 7,
          background: 'transparent', color: 'inherit', cursor: 'pointer',
          opacity: 0.8, fontSize: 13, fontFamily: 'inherit',
        },
      },
        glyph,
        wide ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const state = createDialogState()
        const locale = ctx.locale
        ctx.effect(() => locale.register(NS, {
          en: DICTS.en, zh: DICTS.zh, ja: DICTS.en, es: DICTS.en,
          fr: DICTS.en, de: DICTS.en, ru: DICTS.en, pt: DICTS.en,
        }), 'dsh-plugin-your-preference: locale')
        const t = locale.bind(NS)
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-plugin-your-preference',
          order: 50,
          inject: () => ({ open: state.open, t }),
        }, SidebarEntry))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-plugin-your-preference.dialog',
          inject: () => ({ hooks: { open: state.hooks.open }, close: state.close, t }),
        }, PreferenceDialog))
      },
    }
  },
})
