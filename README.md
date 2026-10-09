# Monorepo Git Sync

Syncs each Obsidian vault with its own folder in one shared GitHub repository, on desktop and Android, with no Git install needed. Install it by copying `main.js` and `manifest.json` from the [latest release](https://github.com/VADITIM/obsidian-monorepo-sync/releases/latest) into `.obsidian/plugins/monorepo-git-sync/` (or add `VADITIM/obsidian-monorepo-sync` in [BRAT](https://github.com/TfTHacker/obsidian42-brat)) and enable it. In its settings, enter the repository (it needs at least one commit), a [fine-grained token](https://github.com/settings/personal-access-tokens) with **Contents: Read and write** on that repository only, and the folder this vault syncs to.

## Day to day

The plugin syncs when Obsidian starts and then every few minutes on its own. To sync right now,
click the ribbon icon or run **Sync now** from the command palette.

### If two devices edit the same note

You won't lose anything. Your local version stays where it is, and the other version is saved
next to it as `note.sync-conflict-YYYYMMDD-HHMMSS.md`. Compare the two, keep what you want, and
delete the other.

The same thing happens the first time you connect a vault to a folder that already has
different copies of the same files. Notes that differ only in line endings don't count as
conflicts.

### If you delete something by mistake

Deleted files are kept for **2 days**. To get one back, run **Restore deleted file** from the
command palette and pick it from the list. It returns to where it was, or next to it as
`name (restored)` if a file already sits there.

Behind the scenes, the copies live in a hidden `.tmp` folder that syncs between your devices,
so you can restore on a different device from the one you deleted on.

### What gets synced

Your notes and attachments, plus most of `.obsidian/`: plugins, themes and settings. The
**Ignore** setting lists what stays out. By default that's the `.trash` folder and the window
layout, which is different on every device.

## Your token and your privacy

**Keep the repository private.** The token is stored in the plugin's `data.json`, which syncs
along with the vault so you don't have to enter it again on a copied vault. That also means the
token sits in the repository in plain text. Limiting the token to this one repository keeps the
damage small if it ever leaks. Don't add `data.json` to the Ignore list, or other devices won't
get the token.

The plugin only talks to `api.github.com`, only about the repository you configured. There is
no telemetry. It reads and writes files only inside the vault.

## How it works

- Each sync starts with one request to check whether anything changed on GitHub. If nothing
  changed there or locally, that's the whole sync.
- Only this vault's folder is downloaded. Other vaults in the repository are never touched.
- Every file is compared with how it looked after the last sync, so the plugin knows whether to
  download it, upload it, or treat it as a conflict.
- All local changes go up together as one commit. If another device pushed in the meantime,
  the sync starts over.
- Each device keeps its own `state.json` to remember the last sync. It is never synced.

## For developers

Build from source:

```bash
npm install
npm run build
```

Every push to `master` builds the plugin and publishes a release, bumping the patch version
(`1.0.0`, `1.0.1`, …). To jump a minor or major version, edit `manifest.json` by hand. The
release workflow commits the new version back to `master`, so pull before your next push.
