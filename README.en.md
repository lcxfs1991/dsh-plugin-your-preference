# Personal Preference

A DeepSeek Harness (DSH) plugin that shows your plugin and skill inventory in the Web UI and lets you export/import it as a single ZIP file, so you can migrate your personal setup between machines.

[中文 README](./README.md)

## Features

- **Inventory**: open the "Personal Preference" entry pinned to the bottom of the left sidebar to see the DSH version, enabled default plugins, externally installed plugins, installed skills, and the user skills under `~/.dsh/skills`.
- **One-click export**: click "Export ZIP" to download `dsh-preference.zip`. It contains `manifest.yaml` (plugin and skill metadata) plus every user-skill file under `~/.dsh/skills`, with their original directory structure preserved.
- **Safe import**: click "Import ZIP" and choose a previously exported archive. Plugins are installed/enabled and skill files are copied into `~/.dsh/skills`. **Existing files are never overwritten** — conflicts are reported one by one.

### How it works (and why your data stays yours)

This plugin does only two things: read the inventory and package skill files. The browser only talks to three local endpoints — `/api/dsh-pref/inventory`, `/api/dsh-pref/export`, and `/api/dsh-pref/import` — registered on the Host Connection's shared `/api` channel, guarded by the same **owner-only authentication** used by every other DSH API. Only the local Harness your browser is connected to can reach them. The inventory comes from the very same Host services that power the Plugins page (`pluginManager` and `skills`), plus a direct scan of `~/.dsh/skills`; the export contains nothing but plugin/skill metadata and the skill files themselves. The plugin **never reads or exports your conversations, API keys, credentials, environment variables, or any configuration secrets**, never contacts third-party services, and sends no telemetry. ZIP and YAML handling is implemented inside the plugin with Node built-in modules only — no external packages involved.

Import is hardened too: request bodies are capped at 256 MB; the ZIP reader supports only standard stored/deflate entries and verifies sizes; the YAML parser rejects unsafe keys such as `__proto__`; skill paths are checked against absolute paths and `..` traversal; and writes use the `wx` flag, so an existing file is skipped and reported rather than overwritten.

## Installation

This plugin is a local bundle named `@local/dsh-plugin-your-preference` and requires Node.js ≥ 24.9.0.

- **Option 1 (recommended)**: in the DSH Web UI, go to **Plugins → Add plugin** and select the directory containing this plugin.
- **Option 2**: in a DSH session that has the `plugin_manager` tool, ask to install this plugin and give it the absolute path to this directory (installed via `install_bundle`).

After installation and activation, refresh the page. A "Personal Preference" entry appears at the bottom of the left sidebar.

## Usage

1. **Open the dialog**: click the "Personal Preference" button at the bottom of the left sidebar. It reads the inventory automatically and shows the DeepSeek Harness version plus four sections (default plugins, external plugins, installed skills, user skills). Use "Retry" if loading fails.
2. **Export**: click "Export ZIP" in the dialog. The browser downloads `dsh-preference.zip`; save it for use on another machine.
3. **Import**: on the other machine, open the same dialog, click "Import ZIP", and select the archive. A result banner reports how many plugin changes were applied and how many skill files were copied; any conflicts or errors are listed individually.
4. **Verify**: the inventory is reloaded automatically after a successful import. Reopen the dialog to check it manually.

> The dialog supports `Esc` to close and `Tab` focus trapping; clicking the backdrop also closes it. UI text follows the DSH language setting (Simplified Chinese and English are built in).

## Archive contents

```
dsh-preference.zip
├── manifest.yaml          # Inventory: schemaVersion, product version, plugins, skills
└── skills/                # All user skill files from ~/.dsh/skills (original layout)
```

- `manifest.yaml` is produced by the plugin's own minimal YAML reader/writer, uses schema version `2`, and is only meant for this plugin's export/import flow.
- Directory-style skills (`SKILL.md` + resources) keep their skill folder name; flat skills (a single `.md` file) are placed directly under `skills/`, avoiding name collisions.

## FAQ

- **Skills don't show up right after import?** The filesystem skill provider watches `~/.dsh/skills` and invalidates its catalog automatically, so no manual refresh is needed. If the UI looks stale, reopen the dialog or refresh the page.
- **"Already exists; not overwritten"?** That is intentional and safe: an existing target file is preserved and the conflicting item is skipped. To replace it with a newer version, delete the old file first and import again.
- **Does the ZIP contain sensitive information?** No. It only contains plugin/skill metadata such as names and descriptions, plus the skill files under `~/.dsh/skills` — no conversations, keys, credentials, or environment variables. As a habit, you can still inspect the archive contents before sharing it.

## Project layout

```
index.js          # Host: inventory/export/import API, skill scanning, ZIP/YAML I/O
client.js         # Browser: sidebar entry and dialog UI; depends only on react and built-in slots/locale services
cordis.patch.yml  # Bundle loader patch
locale/           # Display metadata (English and Chinese)
icon.svg          # Plugin icon
package.json      # Package manifest and DSH bundle declaration
```
