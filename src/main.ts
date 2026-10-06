import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import { VaultSync, cacheDir, normalizeFolder } from "./sync";

interface Settings {
  repoUrl: string;
  folder: string;
  branch: string;
  intervalMinutes: number;
  gitPath: string;
  ignore: string;
}

// Kept in this device's localStorage, never in data.json, because data.json is synced into the repo.
const TOKEN_KEY = "monorepo-git-sync-token";

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
      gitPath: "git",
      ignore: [".trash", `${configDir}/workspace.json`, `${configDir}/workspace-mobile.json`].join("\n"),
    };
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = { ...defaults, ...saved };
    this.status = this.addStatusBarItem();
    this.setStatus("idle");
    this.addSettingTab(new SyncSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.sync(true) });
    this.addRibbonIcon("refresh-cw", "Sync vault with Git", () => void this.sync(true));
    this.schedule();
    this.app.workspace.onLayoutReady(() => void this.sync(false));
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

  private config() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("Only desktop vaults are supported.");
    const s = this.settings;
    return {
      vaultPath: adapter.getBasePath(),
      vaultName: this.app.vault.getName(),
      repoUrl: s.repoUrl.trim(),
      folder: normalizeFolder(s.folder.trim()),
      branch: s.branch.trim(),
      gitPath: s.gitPath.trim() || "git",
      ignore: s.ignore.split("\n").map((l) => normalizeFolder(l.trim())).filter(Boolean),
      token: this.token,
    };
  }

  get token(): string {
    const value: unknown = this.app.loadLocalStorage(TOKEN_KEY);
    return typeof value === "string" ? value : "";
  }

  set token(value: string) {
    this.app.saveLocalStorage(TOKEN_KEY, value.trim() || null);
  }

  cachePath(): string {
    return cacheDir(this.config());
  }

  async sync(manual: boolean) {
    if (this.running) return;
    const cfg = this.config();
    if (!cfg.repoUrl || !cfg.folder) {
      this.setStatus("not configured");
      if (manual) new Notice("Set the repository URL and vault folder in the plugin settings.");
      return;
    }
    this.running = true;
    this.setStatus("syncing…");
    try {
      const r = await new VaultSync(cfg).sync();
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
        desc: "SSH or HTTPS link of the repository that holds all your vaults.",
        control: { type: "text", key: "repoUrl", placeholder: "git@github.com:you/Obsidian.git" },
      },
      {
        name: "GitHub token",
        desc: "Needed for a private repository over HTTPS. Use a fine-grained token with read and write access to its contents. Stored only on this device, never synced.",
        aliases: ["password", "authentication", "private"],
        render: (setting) => {
          setting.addText((t) => {
            t.inputEl.type = "password";
            t.setPlaceholder("Paste token").setValue(this.plugin.token).onChange((v) => (this.plugin.token = v));
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
        name: "Git executable",
        desc: "Path to Git if it is not on Obsidian's PATH.",
        control: { type: "text", key: "gitPath", placeholder: "git" },
      },
      {
        name: "Sync now",
        desc: `Local clone: ${this.plugin.cachePath()}`,
        action: () => void this.plugin.sync(true),
      },
    ];
  }

  async setControlValue(key: string, value: unknown) {
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
  }
}
