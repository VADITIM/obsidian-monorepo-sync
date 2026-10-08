import { App, FuzzySuggestModal, Notice, Platform, Plugin, PluginSettingTab, SettingDefinitionItem, TFolder, requestUrl } from "obsidian";
import { Fetcher, GitHub, parseRepo } from "./github";
import { Local, LocalFile, State, TRASH, VaultSync, normalizeFolder, parseTrash } from "./sync";

interface Settings {
  repoUrl: string;
  folder: string;
  branch: string;
  intervalMinutes: number;
  ignore: string;
  /** Stored in data.json on purpose: it syncs with the vault, so a copied vault needs no re-entry. */
  token: string;
}

// Older versions kept the token in this device's localStorage; adopted into settings on load.
const TOKEN_KEY = "monorepo-git-sync-token";

const fetcher: Fetcher = async (req) => {
  const res = await requestUrl({ ...req, throw: false });
  return { status: res.status, text: res.text, arrayBuffer: res.arrayBuffer };
};

/** Dot paths (the config folder, .trash, …) are outside Obsidian's file index and go through the adapter. */
function hidden(path: string): boolean {
  return path.split("/").some((s) => s.startsWith("."));
}

/** The vault through Obsidian's own APIs, which work the same on desktop and mobile. */
class VaultFiles implements Local {
  constructor(private app: App) {}

  async list(ignored: (path: string) => boolean): Promise<LocalFile[]> {
    const out: LocalFile[] = this.app.vault
      .getFiles()
      .filter((f) => !ignored(f.path))
      .map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
    const adapter = this.app.vault.adapter;
    const walk = async (dir: string) => {
      const { files, folders } = await adapter.list(dir);
      for (const path of files) {
        if (ignored(path)) continue;
        const stat = await adapter.stat(path);
        if (stat) out.push({ path, mtime: stat.mtime, size: stat.size });
      }
      for (const path of folders) if (!ignored(path)) await walk(path);
    };
    const root = await adapter.list("/");
    for (const path of root.files) {
      const stat = hidden(path) && !ignored(path) ? await adapter.stat(path) : null;
      if (stat) out.push({ path, mtime: stat.mtime, size: stat.size });
    }
    for (const path of root.folders) if (hidden(path) && !ignored(path)) await walk(path);
    return out;
  }

  read(path: string): Promise<ArrayBuffer> {
    return this.app.vault.adapter.readBinary(path);
  }

  async write(path: string, data: ArrayBuffer) {
    const { vault } = this.app;
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (hidden(dir)) {
        if (!(await vault.adapter.exists(dir))) await vault.adapter.mkdir(dir);
      } else if (!vault.getFolderByPath(dir)) {
        await vault.createFolder(dir);
      }
    }
    const file = hidden(path) ? null : vault.getFileByPath(path);
    if (hidden(path)) await vault.adapter.writeBinary(path, data);
    else if (file) await vault.modifyBinary(file, data);
    else await vault.createBinary(path, data);
    const stat = await vault.adapter.stat(path);
    return { mtime: stat?.mtime ?? 0, size: stat?.size ?? data.byteLength };
  }

  async remove(path: string) {
    if (hidden(path)) {
      await this.app.vault.adapter.remove(path);
      return;
    }
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    let parent: TFolder | null = file.parent;
    await this.app.fileManager.trashFile(file);
    // Drop folders the deletion left empty, as the other device no longer has them either.
    while (parent && !parent.isRoot() && parent.children.length === 0) {
      const up: TFolder | null = parent.parent;
      await this.app.fileManager.trashFile(parent);
      parent = up;
    }
  }
}

interface Deleted {
  path: string;
  original: string;
  deleted: number;
}

/** Lists the files the sync deleted in the last days and moves the chosen one back. */
class RestoreModal extends FuzzySuggestModal<Deleted> {
  constructor(app: App, private items: Deleted[], private files: VaultFiles) {
    super(app);
    this.setPlaceholder("Restore a deleted file");
  }

  getItems() {
    return this.items;
  }

  getItemText(d: Deleted) {
    return `${d.original}  (deleted ${new Date(d.deleted).toLocaleString()})`;
  }

  onChooseItem(d: Deleted) {
    void this.restore(d);
  }

  private async restore(d: Deleted) {
    const adapter = this.app.vault.adapter;
    let target = d.original;
    if (await adapter.exists(target)) {
      const dot = target.lastIndexOf(".");
      const cut = dot > target.lastIndexOf("/") + 1 ? dot : target.length;
      target = `${target.slice(0, cut)} (restored)${target.slice(cut)}`;
    }
    await this.files.write(target, await adapter.readBinary(d.path));
    await adapter.remove(d.path); // moved, not copied; the next sync drops it from the repository too
    new Notice(`Restored ${target}`);
  }
}

export default class MonorepoGitSync extends Plugin {
  settings!: Settings;
  private status!: HTMLElement;
  private timer: number | null = null;
  private running = false;

  async onload() {
    const configDir = this.app.vault.configDir;
    const defaults: Settings = {
      repoUrl: "",
      folder: "",
      branch: "",
      intervalMinutes: 1,
      ignore: [".trash", `${configDir}/workspace.json`, `${configDir}/workspace-mobile.json`].join("\n"),
      token: "",
    };
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = { ...defaults, ...saved };
    if (!this.settings.token) {
      const legacy: unknown = this.app.loadLocalStorage(TOKEN_KEY);
      if (typeof legacy === "string" && legacy) {
        this.settings.token = legacy;
        await this.saveData(this.settings);
      }
    }
    this.status = this.addStatusBarItem();
    this.setStatus("idle");
    this.addSettingTab(new SyncSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.sync(true) });
    this.addCommand({ id: "restore-deleted", name: "Restore deleted file", callback: () => void this.restore() });
    this.addRibbonIcon("refresh-cw", "Sync vault with GitHub", () => void this.sync(true));
    this.schedule();
    this.app.workspace.onLayoutReady(() => void this.sync(false));
  }

  private async restore() {
    const adapter = this.app.vault.adapter;
    const items: Deleted[] = [];
    const walk = async (dir: string) => {
      const { files, folders } = await adapter.list(dir);
      for (const path of files) {
        const t = parseTrash(path);
        if (t) items.push({ path, original: t.original, deleted: t.deleted });
      }
      for (const f of folders) await walk(f);
    };
    if (await adapter.exists(TRASH)) await walk(TRASH);
    if (!items.length) {
      new Notice("Git sync: nothing deleted in the last 2 days.");
      return;
    }
    new RestoreModal(this.app, items.sort((a, b) => b.deleted - a.deleted), new VaultFiles(this.app)).open();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.schedule();
  }

  private schedule() {
    if (this.timer !== null) window.clearInterval(this.timer);
    const minutes = Math.max(0.25, this.settings.intervalMinutes || 1);
    this.timer = this.registerInterval(window.setInterval(() => void this.sync(false), minutes * 60_000));
  }

  private setStatus(text: string) {
    this.status.setText(`Git sync: ${text}`);
  }

  get token(): string {
    return this.settings.token.trim();
  }

  private get statePath() {
    return `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/state.json`;
  }

  async sync(manual: boolean) {
    if (this.running) return;
    const s = this.settings;
    const repo = parseRepo(s.repoUrl);
    const folder = normalizeFolder(s.folder.trim());
    const missing = !repo ? "a GitHub repository" : !folder ? "the vault folder" : !this.token ? "a GitHub token" : null;
    if (missing) {
      this.setStatus("not configured");
      if (manual) new Notice(`Git sync: set ${missing} in the plugin settings.`);
      return;
    }
    this.running = true;
    this.setStatus("syncing…");
    const adapter = this.app.vault.adapter;
    const statePath = this.statePath;
    const device = Platform.isAndroidApp ? "Android" : Platform.isIosApp ? "iOS" : "desktop";
    try {
      const r = await new VaultSync({
        github: new GitHub(fetcher, repo!, this.token),
        key: `${repo}\n${folder}\n${s.branch.trim()}`,
        folder,
        branch: s.branch.trim(),
        ignore: [...s.ignore.split("\n").map((l) => normalizeFolder(l.trim())), statePath].filter(Boolean),
        message: `${this.app.vault.getName()} (${device}): ${new Date().toISOString()}`,
        local: new VaultFiles(this.app),
        store: {
          load: async () => ((await adapter.exists(statePath)) ? (JSON.parse(await adapter.read(statePath)) as State) : null),
          save: (state) => adapter.write(statePath, JSON.stringify(state)),
        },
      }).sync();
      this.setStatus(`synced ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      if (r.conflicts.length) {
        new Notice(`Git sync: kept your version, saved the other side as:\n${r.conflicts.join("\n")}`, 15_000);
      } else if (manual) {
        new Notice(`Git sync: ${r.pulled} file(s) pulled${r.pushed ? ", changes pushed" : ""}.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error");
      console.error("[monorepo-git-sync]", err);
      new Notice(`Git sync failed: ${msg}`, 10_000);
    } finally {
      this.running = false;
    }
  }
}

class SyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MonorepoGitSync) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Repository",
        desc: "GitHub repository that holds all your vaults, as a link or owner/name.",
        control: {
          type: "text",
          key: "repoUrl",
          placeholder: "https://github.com/you/Obsidian",
          validate: (v) => (!v.trim() || parseRepo(v) ? undefined : "Not a GitHub repository link."),
        },
      },
      {
        name: "GitHub token",
        desc: "Fine-grained token with read and write access to the repository's contents. Saved in this plugin's data.json, so it syncs to your other devices. Keep the repository private.",
        aliases: ["password", "authentication", "private"],
        render: (setting) => {
          setting.addText((t) => {
            t.inputEl.type = "password";
            t.setPlaceholder("Paste token").setValue(this.plugin.settings.token).onChange(async (v) => {
              this.plugin.settings.token = v.trim();
              await this.plugin.saveSettings();
            });
          });
        },
      },
      {
        name: "Vault folder",
        desc: "Folder inside that repository this vault lives in. Created on first sync if missing.",
        control: { type: "text", key: "folder", placeholder: "Work" },
      },
      {
        name: "Branch",
        desc: "Leave empty to use the repository's default branch.",
        control: { type: "text", key: "branch", placeholder: "main" },
      },
      {
        name: "Interval",
        desc: "Minutes between syncs.",
        control: {
          type: "number",
          key: "intervalMinutes",
          min: 0.25,
          validate: (v) => (v > 0 ? undefined : "Must be greater than 0."),
        },
      },
      {
        name: "Ignore",
        desc: "Vault paths that are never synced, one per line. Folders include everything inside them.",
        control: { type: "textarea", key: "ignore", rows: 5 },
      },
      {
        name: "Sync now",
        desc: "Sync this vault with GitHub immediately.",
        action: () => void this.plugin.sync(true),
      },
    ];
  }

  async setControlValue(key: string, value: unknown) {
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
  }
}
