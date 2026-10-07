# Monorepo Git Sync

Syncs an Obsidian vault with **one folder** of a shared GitHub repository, so all your vaults
live in a single repo:

```
Obsidian/            ← one GitHub repo (private or public)
├── Work/            ← vault "Work" syncs here
└── Personal/        ← vault "Personal" syncs here
```

Works on desktop and Android. Talks to GitHub's API directly, so no `git` install is needed.

## Install

Download `main.js` and `manifest.json` from the
[latest release](https://github.com/VADITIM/obsidian-monorepo-sync/releases/latest) into
`<your vault>/.obsidian/plugins/monorepo-git-sync/`, then enable **Monorepo Git Sync** under
Settings → Community plugins.

On Android, the vault folder is wherever you created the vault (often `Documents/<vault>`). Use
a file manager that shows hidden folders to reach `.obsidian`.
[BRAT](https://github.com/TfTHacker/obsidian42-brat) can install it from this repository instead:
add `VADITIM/obsidian-monorepo-sync` as a beta plugin.

Requires Obsidian 1.13.0 or newer.

## Setup

1. Create a **fine-grained token** on GitHub (Settings → Developer settings → Personal access
   tokens → Fine-grained tokens). Repository access: only your vault repository. Permissions:
   **Contents → Read and write**.
2. In the plugin settings:

   | Field        | Example                            |
   | ------------ | ---------------------------------- |
   | Repository   | `https://github.com/you/Obsidian` or `you/Obsidian` |
   | GitHub token | the token from step 1              |
   | Vault folder | `Work`                             |
   | Interval     | `1` (minutes)                      |

The repository needs at least one commit (create it with a README). The plugin syncs on startup,
every interval, and from the ribbon icon or the **Sync now** command.

The token is kept in this device's local storage, never in the synced settings, so enter it once
per device.

## How it works

- Each run reads the branch head. If nothing changed remotely and nothing changed locally, that
  one request is the whole sync.
- Only this vault's folder is read or written. Other vaults in the repo are never downloaded.
- Changes are decided per file against the last synced state: pulled, pushed, or both. All local
  changes go up as one commit. If another device pushed in between, the run starts over.
- **Conflicts never lose data.** Your local version wins, and the other side is saved next to it
  as `note.sync-conflict-YYYYMMDD-HHMMSS.md`. The same happens on the first sync, when the vault
  and the repo folder both hold the same file with different content. Files that differ only in
  line endings (CRLF vs LF) are not conflicts.
- `.obsidian/` is synced (plugins, themes, settings) except the paths in **Ignore**, which by
  default leaves out `.trash` and the per-device workspace layout. The plugin's own `state.json`
  is per device and never synced.

## Disclosures

- **Network**: requests go only to `api.github.com`, for the repository you configure,
  authenticated with your token. No telemetry.
- **Files**: reads and writes only inside this vault, including the config folder.

## Releases

Every push to `master` builds the plugin and publishes a release. The version is the patch after
the newest tag (`1.0.0`, `1.0.1`, …). Bump `manifest.json` by hand to jump a minor or major
version. The workflow commits the new version back to `master`, so pull before your next push.

## Build from source

```bash
npm install
npm run build
```
