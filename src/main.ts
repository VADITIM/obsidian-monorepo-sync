import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
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

const DEFAULTS: Settings = {
  repoUrl: "",
  folder: "",
  branch: "",
  intervalMinutes: 1,
  gitPath: "git",
  ignore: [".trash", ".obsidian/workspace.json", ".obsidian/workspace-mobile.json"].join("\n"),
};

export default class MonorepoGitSync extends Plugin {
  settings: Settings = { ...DEFAULTS };
  private status!: HTMLElement;
  private timer: number | null = null;
  private running = false;

  async onload() {
    this.settings = { ...DEFAULTS, ...(await this.loadData()) };
    this.status = this.addStatusBarItem();
    this.setStatus("idle");
    this.addSettingTab(new SyncSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync(true) });
    this.addRibbonIcon("refresh-cw", "Sync vault with git", () => this.sync(true));
    this.schedule();
    this.app.workspace.onLayoutReady(() => this.sync(false));
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.schedule();
  }

  private schedule() {
    if (this.timer !== null) window.clearInterval(this.timer);
    const minutes = Math.max(0.25, this.settings.intervalMinutes || DEFAULTS.intervalMinutes);
    this.timer = this.registerInterval(window.setInterval(() => this.sync(false), minutes * 60_000));
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
    return this.app.loadLocalStorage(TOKEN_KEY) ?? "";
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

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    const text = (name: string, desc: string, key: "repoUrl" | "folder" | "branch" | "gitPath", placeholder: string) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setPlaceholder(placeholder).setValue(s[key]).onChange(async (v) => {
            s[key] = v;
            await this.plugin.saveSettings();
          }),
        );

    text("Repository", "SSH or HTTPS link of the repository that holds all your vaults.", "repoUrl", "git@github.com:you/Obsidian.git");
    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc("Needed for a private repo over HTTPS. Fine-grained token with Contents: read and write. Stored only on this device, never synced.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("github_pat_…").setValue(this.plugin.token).onChange((v) => (this.plugin.token = v));
      });
    text("Vault folder", "Folder inside that repository this vault lives in. Created on first sync if missing.", "folder", "Work");
    text("Branch", "Leave empty to use the repository's default branch.", "branch", "main");

    new Setting(containerEl)
      .setName("Interval")
      .setDesc("Minutes between syncs.")
      .addText((t) =>
        t.setValue(String(s.intervalMinutes)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            s.intervalMinutes = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Ignore")
      .setDesc("Vault paths that are never synced, one per line. Folders include everything inside them.")
      .addTextArea((t) => {
        t.setValue(s.ignore).onChange(async (v) => {
          s.ignore = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 5;
      });

    text("Git executable", "Path to git if it is not on Obsidian's PATH.", "gitPath", "git");

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc(`Local clone: ${this.plugin.cachePath()}`)
      .addButton((b) => b.setButtonText("Sync").setCta().onClick(() => this.plugin.sync(true)));
  }
}
