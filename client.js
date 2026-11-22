/**
 * Browser half of dsh-plugin-your-preference.
 *
 * Adds one entry to the left sidebar's foot. Activating it opens a modal
 * dialog with three capabilities:
 *   1. Inventory - product version, enabled default plugins, external plugins,
 *      installed skills and the raw user skills under ~/.dsh/skills.
 *   2. Git - status of this plugin's own checkout and a commit action.
 *   3. Export/Import - download a ZIP (YAML manifest + every user skill) or
 *      import one, installing plugins and copying skills without overwrites.
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

    const INVENTORY_URL = '/api/dsh-pref/inventory'
    const GIT_URL = '/api/dsh-pref/git'
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
        'export': 'Export ZIP',
        'import': 'Import ZIP',
        'loading': 'Loading…',
        'readInventory': 'Reading DeepSeek Harness…',
        'section.default': 'Default plugins enabled',
        'section.external': 'External installed plugins',
        'section.skills': 'Skills installed',
        'section.userSkills': 'User skills (~/.dsh/skills)',
        'section.git': 'Git repository',
        'none': 'None',
        'loadError': 'Could not load inventory: {0}',
        'retry': 'Retry',
        'exportDone': 'Exported dsh-preference.zip',
        'exportFailed': 'Export failed: {0}',
        'importDone': 'Imported: {0} plugin change(s), {1} skill file(s) copied.',
        'importProblems': 'Import completed with {0} issue(s).',
        'importFailed': 'Import failed: {0}',
        'badge.default': 'Default',
        'badge.bundled': 'Bundled',
        'badge.installed': 'Installed',
        'badge.missing': 'Missing',
        'badge.enabled': 'Enabled',
        'badge.disabled': 'Disabled',
        'git.branch': 'Branch',
        'git.commit': 'Commit',
        'git.clean': 'Clean',
        'git.dirty': '{0} change(s)',
        'git.lastCommit': 'Last commit',
        'git.refresh': 'Refresh',
        'git.commitAction': 'Commit changes',
        'git.commitPrompt': 'Commit message',
        'git.commitPlaceholder': 'Describe your changes…',
        'git.confirm': 'Commit',
        'git.cancel': 'Cancel',
        'git.committed': 'Committed as {0}',
        'git.nothing': 'Nothing to commit; working tree is clean.',
        'git.error': 'Git error: {0}',
        'git.unavailable': 'Git is not available for this plugin.',
        'git.remote': 'Remote',
        'conflicts.title': 'Skipped {0} conflicting skill file(s) (not overwritten):',
        'note.export': 'The exported ZIP contains manifest.yaml (plugin and skill information) plus every user skill from ~/.dsh/skills.',
        'note.import': 'On import, plugins are installed and skill files are copied into ~/.dsh/skills. Existing files are never overwritten; conflicts are reported above.',
        'files': '{0} file(s)',
      },
      zh: {
        'sidebar.label': '个性化管理',
        'dialog.label': '个性化管理',
        'version': '版本 {0}',
        'close': '关闭',
        'export': '导出 ZIP',
        'import': '导入 ZIP',
        'loading': '加载中…',
        'readInventory': '正在读取 DeepSeek Harness…',
        'section.default': '已启用的默认插件',
        'section.external': '外部安装的插件',
        'section.skills': '已安装的技能',
        'section.userSkills': '用户技能（~/.dsh/skills）',
        'section.git': 'Git 仓库',
        'none': '无',
        'loadError': '无法读取清单：{0}',
        'retry': '重试',
        'exportDone': '已导出 dsh-preference.zip',
        'exportFailed': '导出失败：{0}',
        'importDone': '已导入：{0} 项插件变更，复制了 {1} 个技能文件。',
        'importProblems': '导入完成，但有 {0} 个问题。',
        'importFailed': '导入失败：{0}',
        'badge.default': '默认',
        'badge.bundled': '内置',
        'badge.installed': '已安装',
        'badge.missing': '缺失',
        'badge.enabled': '已启用',
        'badge.disabled': '已禁用',
        'git.branch': '分支',
        'git.commit': '提交',
        'git.clean': '干净',
        'git.dirty': '{0} 项变更',
        'git.lastCommit': '最近提交',
        'git.refresh': '刷新',
        'git.commitAction': '提交变更',
        'git.commitPrompt': '提交信息',
        'git.commitPlaceholder': '描述你的变更…',
        'git.confirm': '提交',
        'git.cancel': '取消',
        'git.committed': '已提交为 {0}',
        'git.nothing': '没有可提交的内容；工作区干净。',
        'git.error': 'Git 错误：{0}',
        'git.unavailable': '此插件的 Git 功能不可用。',
        'git.remote': '远程仓库',
        'conflicts.title': '已跳过 {0} 个冲突的技能文件（未覆盖）：',
        'note.export': '导出的 ZIP 包含 manifest.yaml（插件与技能信息），以及 ~/.dsh/skills 下的所有用户技能。',
        'note.import': '导入时会安装插件并将技能文件复制到 ~/.dsh/skills。已有文件不会被覆盖；冲突会在上方提示。',
        'files': '{0} 个文件',
      },
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

    function SkillRow({ item, t }) {
      const count = Array.isArray(item.files) ? item.files.length : 0
      return h('li', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 2,
          padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
        },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
          h('span', { style: { fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' } }, item.name),
          h('span', { style: { fontSize: 11, opacity: 0.7, flexShrink: 0 } },
            item.source || item.provider || (count ? t('files', { 0: String(count) }) : '')),
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

    // ---- git panel ---------------------------------------------------
    function GitPanel({ git, refresh, commit, busy, t }) {
      const [message, setMessage] = useState('')
      const [showInput, setShowInput] = useState(false)
      if (!git || git.ok === false) {
        return h('div', { style: { fontSize: 12, opacity: 0.75, padding: '6px 0' } }, t('git.unavailable'))
      }
      const doCommit = async () => {
        const text = message.trim()
        if (!text) return
        const ok = await commit(text)
        if (ok) { setMessage(''); setShowInput(false) }
      }
      return h('div', {
        style: {
          padding: '10px 12px', borderRadius: 8, marginTop: 6,
          background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.06))',
          border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
        },
      },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12 } },
          h('span', {}, `${t('git.branch')}: `, h('code', {}, git.branch || '—')),
          h('span', {}, `${t('git.commit')}: `, h('code', {}, git.commit || '—')),
          h('span', {
            style: {
              color: git.clean
                ? 'var(--dsw-alias-state-success-primary, #2f855a)'
                : 'var(--dsw-alias-state-warning-primary, #b7791f)',
            },
          }, git.clean ? t('git.clean') : t('git.dirty', { 0: String(git.changedCount ?? git.changed?.length ?? 0) })),
        ),
        git.lastCommit ? h('div', { style: { fontSize: 12, opacity: 0.7, marginTop: 4 } },
          `${t('git.lastCommit')}: ${git.lastCommit}`) : null,
        git.remote ? h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 4, overflowWrap: 'anywhere' } },
          `${t('git.remote')}: ${git.remote}`) : null,
        git.changed && git.changed.length > 0
          ? h('ul', { style: { margin: '6px 0 0', paddingLeft: 18, fontSize: 11, opacity: 0.7 } },
              git.changed.slice(0, 12).map((line, index) => h('li', { key: index }, line)))
          : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: () => void refresh(), disabled: busy, style: buttonStyle() },
            busy === 'git-refresh' ? h(Spinner) : null, t('git.refresh')),
          h('button', {
            type: 'button', onClick: () => setShowInput(v => !v), disabled: busy || git.clean,
            style: buttonStyle(),
          }, t('git.commitAction')),
        ),
        showInput && !git.clean
          ? h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              h('input', {
                type: 'text', value: message, autoFocus: true,
                placeholder: t('git.commitPlaceholder'), 'aria-label': t('git.commitPrompt'),
                onChange: (event) => setMessage(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') void doCommit() },
                style: {
                  flex: 1, minWidth: 180, padding: '6px 8px', fontSize: 13,
                  color: 'inherit', background: 'var(--dsw-alias-bg-layer-1, transparent)',
                  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', borderRadius: 6,
                },
              }),
              h('button', { type: 'button', onClick: () => void doCommit(), disabled: busy || !message.trim(), style: buttonStyle() },
                busy === 'git-commit' ? h(Spinner) : null, t('git.confirm')),
              h('button', { type: 'button', onClick: () => { setShowInput(false); setMessage('') }, disabled: busy, style: buttonStyle() }, t('git.cancel')),
            )
          : null,
      )
    }

    // ---- the dialog ---------------------------------------------------
    function PreferenceDialog({ useOpen, close, t }) {
      const open = useOpen(current => current)
      const [state, setState] = useState({ status: 'idle', data: null, error: null, action: null, actionResult: null })
      const [git, setGit] = useState(null)
      const fileRef = useRef(null)
      const closeRef = useRef(null)
      const dialogRef = useRef(null)

      const loadGit = useCallback(async () => {
        try {
          const response = await fetch(GIT_URL)
          const data = await response.json()
          setGit(data)
        } catch (error) {
          setGit({ ok: false, error: String(error) })
        }
      }, [])

      const load = useCallback(async () => {
        setState({ status: 'loading', data: null, error: null, action: null, actionResult: null })
        try {
          const response = await fetch(INVENTORY_URL, { headers: { Accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (!data || data.ok !== true) throw new Error(data?.error ?? 'unsupported inventory')
          setState({ status: 'ready', data, error: null, action: null, actionResult: null })
        } catch (error) {
          setState({ status: 'error', data: null, error: String(error), action: null, actionResult: null })
        }
        void loadGit()
      }, [loadGit])

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
          link.download = 'dsh-preference.zip'
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
          const response = await fetch(IMPORT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
            body: await file.arrayBuffer(),
          })
          const result = await response.json()
          if (!response.ok && !result) throw new Error(`HTTP ${response.status}`)
          if (result.error) throw new Error(result.error)
          const pluginActions = (result.plugins ?? []).filter(item => item.result || item.error)
          const copied = (result.skills ?? []).filter(item => item.action === 'installed')
          const conflicts = result.conflicts ?? []
          const problems = [
            ...(result.plugins ?? []).filter(item => item.error).map(item => `${item.name}: ${item.error}`),
            ...(result.skills ?? []).filter(item => item.error).map(item => `${item.path}: ${item.error}`),
          ]
          const ok = problems.length === 0 && result.ok !== false
          const summary = conflicts.length > 0 || problems.length > 0
            ? t('importProblems', { 0: String(problems.length + conflicts.length) })
            : t('importDone', { 0: String(pluginActions.length), 1: String(copied.length) })
          setState(current => ({
            ...current, action: null,
            actionResult: { ok, text: summary, problems, conflicts, notes: result.notes ?? [] },
          }))
          if (pluginActions.length > 0 || copied.length > 0) void load()
        } catch (error) {
          setState(current => ({ ...current, action: null, actionResult: { ok: false, text: t('importFailed', { 0: String(error) }) } }))
        }
      }

      const onCommit = async (message) => {
        setState(current => ({ ...current, action: 'git-commit', actionResult: null }))
        try {
          const response = await fetch(GIT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
          })
          const result = await response.json()
          if (!result.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
          setState(current => ({
            ...current, action: null,
            actionResult: {
              ok: true,
              text: result.committed ? t('git.committed', { 0: result.commit }) : t('git.nothing'),
            },
          }))
          void loadGit()
          return true
        } catch (error) {
          setState(current => ({ ...current, action: null, actionResult: { ok: false, text: t('git.error', { 0: String(error) }) } }))
          return false
        }
      }

      if (!open) return null

      const data = state.data
      const defaultPlugins = data?.plugins?.defaultEnabled ?? []
      const externalPlugins = data?.plugins?.externalInstalled ?? []
      const skills = data?.skills ?? []
      const userSkills = data?.userSkills?.skills ?? []
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
            width: 'min(720px, 100%)', maxHeight: 'min(84vh, 760px)',
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
              ref: fileRef, type: 'file', accept: '.zip,application/zip',
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
              (state.actionResult.conflicts ?? []).length > 0
                ? h('div', {},
                    h('div', { style: { marginTop: 6, fontWeight: 600 } },
                      t('conflicts.title', { 0: String(state.actionResult.conflicts.length) })),
                    h('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } },
                      state.actionResult.conflicts.map((conflict, index) => h('li', { key: index },
                        `${conflict.path} — ${conflict.reason}`))),
                  )
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
                      skills.map((item, index) => h(SkillRow, { key: `s-${index}`, item, t }))),
                    h(Section, { title: t('section.userSkills'), count: userSkills.length, t },
                      userSkills.map((item, index) => h(SkillRow, { key: `u-${index}`, item, t }))),
                    h(Section, { title: t('section.git'), count: 1, t },
                      h(GitPanel, { git, refresh: loadGit, commit: onCommit, busy, t })),
                    h('div', {
                      style: { marginTop: 16, fontSize: 11, opacity: 0.65, lineHeight: 1.5 },
                    }, t('note.export'), h('br'), t('note.import')),
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
