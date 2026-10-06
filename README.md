# Monorepo Git Sync

Syncs an Obsidian vault with **one folder** of a shared Git repository, so all your vaults
live in a single repo:

```
Obsidian/            ← one GitHub repo (private or public)
├── Work/            ← vault "Work" syncs here
└── Personal/        ← vault "Personal" syncs here
```

Desktop only. Uses the `git` installed on your machine.

## Install

Download `main.js` and `manifest.json` from the
[latest release](https://github.com/VADITIM/obsidian-monorepo-sync/releases/latest) into
`<your vault>/.obsidian/plugins/monorepo-git-sync/`, then enable **Monorepo Git Sync** under
Settings → Community plugins.

Requires Obsidian 1.13.0 or newer.

## Releases

Every push to `master` builds the plugin and publishes a release. The version is the patch after
the newest tag (`1.0.0`, `1.0.1`, …). Bump `manifest.json` by hand to jump a minor or major
version. The workflow commits the new version back to `master`, so pull before your next push.

## Build from source

```bash
npm install
npm run build
```

## Setup

In the plugin settings:

| Field        | Example                            |
| ------------ | ---------------------------------- |
| Repository   | `git@github.com:you/Obsidian.git` or `https://github.com/you/Obsidian.git` |
| Vault folder | `Work`                             |
| Interval     | `1` (minutes)                      |

It syncs on startup, every interval, and from the ribbon icon or the **Sync now** command.

### Authentication

Pick one:

- **SSH**: a key added to GitHub, either without a passphrase or loaded in `ssh-agent`.
- **HTTPS, private repo**: paste a fine-grained GitHub token (Contents: read and write, limited to
  that repo) into **GitHub token**. It is stored only on this device and never synced.
- **HTTPS without a token**: Git Credential Manager (bundled with Git for Windows). Run one
  `git ls-remote <url>` from a terminal first so the credentials are stored.

## How it works

- The plugin keeps a partial, sparse clone in `~/.obsidian-git-sync/<vault>-<hash>/`. Only this
  vault's folder is checked out there, never inside the vault.
- Each run copies vault changes into the clone, commits them, merges `origin`, copies incoming
  changes back into the vault, and pushes.
- Commits only touch this vault's folder, so several vaults can sync to the same repo at once.
- **Conflicts never lose data.** Your local version wins, and the other side is saved next to it
  as `note.sync-conflict-YYYYMMDD-HHMMSS.md`. The same thing happens on the first sync, when the
  vault and the repo folder both already hold the same file with different content.
- `.obsidian/` is synced (plugins, themes, settings) except the paths in **Ignore**, which by
  default leaves out `.trash` and the per-device workspace layout.

## Disclosures

Obsidian's review flags these, and both are how the plugin works:

- **Runs `git`** (via Node's `child_process`) to clone, commit, pull and push. Nothing else is
  executed.
- **Reads and writes files outside the vault API** (via Node's `fs`): the vault folder itself and
  the plugin's own clone in `~/.obsidian-git-sync/`. Nothing else on disk is touched.
- **Network**: only `git` talks to the repository you configure. The plugin makes no other
  requests and collects no telemetry.
