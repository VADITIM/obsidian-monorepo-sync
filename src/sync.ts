import { execFile } from "child_process";
import { createHash } from "crypto";
import { Stats, promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

export interface SyncConfig {
  vaultPath: string;
  vaultName: string;
  repoUrl: string;
  /** Folder inside the repository that holds this vault, e.g. "Work". */
  folder: string;
  /** Empty means the remote's default branch. */
  branch: string;
  gitPath: string;
  /** Vault-relative path prefixes that are never synced. */
  ignore: string[];
  /** GitHub personal access token for private repos over HTTPS. Empty uses git's own credentials. */
  token: string;
}

export interface SyncResult {
  pushed: boolean;
  pulled: number;
  conflicts: string[];
}

const MARKER = "monorepo-git-sync-initialized";

export function normalizeFolder(folder: string): string {
  return folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** One clone per vault + repo + folder, kept outside the vault so it is never synced itself. */
export function cacheDir(cfg: SyncConfig): string {
  const key = [cfg.vaultPath, cfg.repoUrl, normalizeFolder(cfg.folder), cfg.branch].join("\n");
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 10);
  const name = cfg.vaultName.replace(/[^\w.-]+/g, "_");
  return path.join(os.homedir(), ".obsidian-git-sync", `${name}-${hash}`);
}

type Env = Record<string, string>;

/**
 * Sends the token as an auth header through git's environment config,
 * so it is never written into the remote URL, the clone's config, or a process argument.
 */
function authEnv(cfg: SyncConfig): Env {
  const token = cfg.token.trim();
  const host = /^https?:\/\/(?:[^@/]*@)?([^/]+)/i.exec(cfg.repoUrl.trim())?.[1];
  if (!token || !host) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

function run(cmd: string, args: string[], cwd: string, env: Env): Promise<string>;
function run(cmd: string, args: string[], cwd: string, env: Env, binary: true): Promise<Buffer>;
function run(cmd: string, args: string[], cwd: string, env: Env, binary = false): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        encoding: binary ? "buffer" : "utf8",
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        // Never wait for a username/password prompt that nobody can answer.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
}

async function statOrNull(p: string): Promise<Stats | null> {
  return fs.stat(p).catch(() => null);
}

function same(a: Stats | null | undefined, b: Stats | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.size === b.size && Math.trunc(a.mtimeMs) === Math.trunc(b.mtimeMs);
}

/** Every file below root, keyed by its root-relative path with forward slashes. */
async function walk(root: string, ignored: (rel: string) => boolean): Promise<Map<string, Stats>> {
  const out = new Map<string, Stats>();
  const rec = async (rel: string) => {
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (ignored(r)) continue;
      if (e.isDirectory()) await rec(r);
      else if (e.isFile()) out.set(r, await fs.stat(path.join(root, r)));
    }
  };
  if (await exists(root)) await rec("");
  return out;
}

/** Copies a file and carries its mtime over, so the next pass can compare by stat alone. */
async function copy(src: string, dst: string): Promise<void> {
  const st = await fs.stat(src);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
  await fs.utimes(dst, st.atimeMs / 1000, st.mtimeMs / 1000);
}

async function remove(root: string, rel: string): Promise<void> {
  await fs.rm(path.join(root, rel), { force: true });
  // Drop directories the deletion left empty; rmdir refuses non-empty ones.
  for (let dir = path.dirname(rel); dir !== "." && dir !== ""; dir = path.dirname(dir)) {
    try {
      await fs.rmdir(path.join(root, dir));
    } catch {
      break;
    }
  }
}

function conflictName(rel: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const ext = path.posix.extname(rel);
  return `${rel.slice(0, rel.length - ext.length)}.sync-conflict-${stamp}${ext}`;
}

export class VaultSync {
  private env: Env;

  constructor(private cfg: SyncConfig) {
    this.env = authEnv(cfg);
  }

  private get folder() {
    return normalizeFolder(this.cfg.folder);
  }

  private ignored = (rel: string): boolean =>
    rel === ".git" ||
    rel.startsWith(".git/") ||
    this.cfg.ignore.some((p) => p && (rel === p || rel.startsWith(p + "/")));

  private git(repo: string, ...args: string[]) {
    return run(this.cfg.gitPath, args, repo, this.env);
  }

  private async head(repo: string): Promise<string | null> {
    return this.git(repo, "rev-parse", "-q", "--verify", "HEAD").then((s) => s.trim(), () => null);
  }

  private async clone(repo: string): Promise<void> {
    const tmp = `${repo}.tmp`;
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.mkdir(path.dirname(repo), { recursive: true });
    const branch = this.cfg.branch ? ["-b", this.cfg.branch] : [];
    // Partial, sparse clone: only this vault's folder is ever checked out or downloaded in full.
    await run(this.cfg.gitPath, ["clone", "-q", "--filter=blob:none", "--no-checkout", ...branch, this.cfg.repoUrl, tmp], os.homedir(), this.env);
    await this.git(tmp, "sparse-checkout", "init", "--cone");
    await this.git(tmp, "sparse-checkout", "set", this.folder);
    await this.git(tmp, "checkout", "-q").catch(() => {}); // an empty repository has nothing to check out
    const email = await this.git(tmp, "config", "user.email").catch(() => "");
    if (!email.trim()) {
      await this.git(tmp, "config", "user.name", `Obsidian (${os.hostname()})`);
      await this.git(tmp, "config", "user.email", `obsidian@${os.hostname()}`);
    }
    await fs.rename(tmp, repo);
  }

  async sync(): Promise<SyncResult> {
    const { vaultPath, vaultName } = this.cfg;
    const folder = this.folder;
    if (!this.cfg.repoUrl || !folder) throw new Error("Set the repository URL and vault folder first.");

    const repo = cacheDir(this.cfg);
    if (!(await exists(path.join(repo, ".git")))) await this.clone(repo);
    const work = path.join(repo, ...folder.split("/"));
    const marker = path.join(repo, ".git", MARKER);
    const initialized = await exists(marker);
    const conflicts: string[] = [];

    // 1. Vault -> clone. The vault is the working copy; the clone mirrors it.
    const local = await walk(vaultPath, this.ignored);
    const cached = await walk(work, this.ignored);
    for (const [rel, st] of local) {
      const c = cached.get(rel);
      if (same(st, c)) continue;
      const src = path.join(vaultPath, rel);
      const dst = path.join(work, rel);
      // First sync of a vault into a folder that already has content: never silently drop the remote copy.
      if (!initialized && c && !(await fs.readFile(src)).equals(await fs.readFile(dst))) {
        const name = conflictName(rel);
        await copy(dst, path.join(work, name));
        conflicts.push(name);
      }
      await copy(src, dst);
    }
    if (initialized) {
      for (const rel of cached.keys()) if (!local.has(rel)) await remove(work, rel);
    }

    // 2. Commit whatever changed in this vault's folder, and nothing outside it.
    await this.git(repo, "add", "-A", "--", folder);
    if ((await this.git(repo, "diff", "--cached", "--name-only", "--", folder)).trim()) {
      await this.git(repo, "commit", "-q", "-m", `${vaultName}: ${new Date().toISOString()}`);
    }

    // 3. Bring in the remote. Other vault folders merge cleanly; conflicts can only be in ours.
    const branch = (await this.git(repo, "symbolic-ref", "--short", "HEAD")).trim();
    const upstream = `origin/${branch}`;
    const before = await this.head(repo);
    await this.git(repo, "fetch", "-q", "origin");
    const hasUpstream = await this.git(repo, "rev-parse", "-q", "--verify", upstream).then(() => true, () => false);
    if (hasUpstream) {
      try {
        await this.git(repo, "merge", "-q", "--no-edit", "--allow-unrelated-histories", upstream);
      } catch (err) {
        const copies = await this.resolveConflicts(repo);
        if (!copies) throw err;
        conflicts.push(...copies.map((p) => p.slice(folder.length + 1)));
      }
    }
    const after = await this.head(repo);

    // 4. Clone -> vault, only for paths the merge changed (or everything on the first sync).
    let changed: string[];
    if (!initialized || (!before && after)) {
      changed = [...(await walk(work, this.ignored)).keys()];
    } else if (before && after && before !== after) {
      const out = await this.git(repo, "diff", "--name-only", "-z", before, after, "--", folder);
      changed = out.split("\0").filter(Boolean).map((p) => p.slice(folder.length + 1));
    } else {
      changed = [];
    }
    let pulled = 0;
    for (const rel of changed) {
      if (this.ignored(rel)) continue;
      const src = path.join(work, rel);
      const dst = path.join(vaultPath, rel);
      const [s, d] = await Promise.all([statOrNull(src), statOrNull(dst)]);
      if (same(s, d)) continue;
      // Edited in the vault while this sync ran: keep the edit, park the remote version beside it.
      if (!same(d, local.get(rel))) {
        if (s) {
          const name = conflictName(rel);
          await copy(src, path.join(vaultPath, name));
          conflicts.push(name);
        }
        continue;
      }
      if (s) await copy(src, dst);
      else await remove(vaultPath, rel);
      pulled++;
    }

    // 5. Push if we are ahead. A rejected push is fine: the next run merges and retries.
    let pushed = false;
    if (after) {
      const ahead = hasUpstream ? Number((await this.git(repo, "rev-list", "--count", `${upstream}..HEAD`)).trim()) : 1;
      if (ahead > 0) {
        await this.git(repo, "push", "-q", "-u", "origin", `HEAD:${branch}`);
        pushed = true;
      }
    }

    if (!initialized) await fs.writeFile(marker, "");
    return { pushed, pulled, conflicts };
  }

  /** Keeps the local side of each conflict and commits the remote side next to it as a copy. */
  private async resolveConflicts(repo: string): Promise<string[] | null> {
    const out = await this.git(repo, "ls-files", "-u", "-z");
    const stages = new Map<string, Map<number, string>>();
    for (const entry of out.split("\0").filter(Boolean)) {
      const [meta, file] = entry.split("\t");
      const [, sha, stage] = meta.split(" ");
      if (!stages.has(file)) stages.set(file, new Map());
      stages.get(file)!.set(Number(stage), sha);
    }
    if (!stages.size) return null; // not a conflict, a real failure
    const copies: string[] = [];
    for (const [file, s] of stages) {
      const ours = s.get(2);
      const theirs = s.get(3);
      if (ours) {
        await this.git(repo, "checkout", "--ours", "--", file);
        if (theirs) {
          const name = conflictName(file);
          const blob = await run(this.cfg.gitPath, ["cat-file", "blob", theirs], repo, this.env, true);
          await fs.writeFile(path.join(repo, name), blob);
          copies.push(name);
        }
      } else if (theirs) {
        await this.git(repo, "checkout", "--theirs", "--", file);
      } else {
        await fs.rm(path.join(repo, file), { force: true });
      }
    }
    await this.git(repo, "add", "-A", "--", ...stages.keys(), ...copies);
    await this.git(repo, "commit", "-q", "--no-edit");
    return copies;
  }
}
