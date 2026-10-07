import { GitHub, GitHubError } from "./github";

export interface LocalFile {
  path: string;
  mtime: number;
  size: number;
}

/** The vault, as the engine sees it. Paths are vault-relative with forward slashes. */
export interface Local {
  list(ignored: (path: string) => boolean): Promise<LocalFile[]>;
  read(path: string): Promise<ArrayBuffer>;
  /** Creates parent folders as needed and returns the new stat. */
  write(path: string, data: ArrayBuffer): Promise<{ mtime: number; size: number }>;
  remove(path: string): Promise<void>;
}

/** Per-device sync state. Must never be synced itself. */
export interface State {
  key: string;
  branch: string;
  /** Remote commit the base below belongs to. */
  commit: string | null;
  /** path -> blob sha as of the last sync: the common ancestor for three-way decisions. */
  base: Record<string, string>;
  /** path -> stat and sha, so unchanged files are not re-read and re-hashed every run. */
  hashes: Record<string, { mtime: number; size: number; sha: string }>;
}

export interface Store {
  load(): Promise<State | null>;
  save(state: State): Promise<void>;
}

export interface SyncConfig {
  github: GitHub;
  /** Identifies repo + folder + branch; a change starts over with a fresh first sync. */
  key: string;
  folder: string;
  /** Empty means the repository's default branch. */
  branch: string;
  ignore: string[];
  message: string;
  local: Local;
  store: Store;
}

export interface SyncResult {
  pushed: boolean;
  pulled: number;
  conflicts: string[];
}

/** Another device pushed between our read and our write. Harmless: run again. */
class Raced extends Error {}

export function normalizeFolder(folder: string): string {
  return folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Git's blob id: sha1 of "blob <size>\0<content>". Lets local files be compared to remote ones without downloading. */
async function gitSha(data: ArrayBuffer): Promise<string> {
  const header = new TextEncoder().encode(`blob ${data.byteLength}\0`);
  const buf = new Uint8Array(header.length + data.byteLength);
  buf.set(header);
  buf.set(new Uint8Array(data), header.length);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Equal once CRLF is read as LF, so a Windows checkout and the repository count as the same file. */
function sameText(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const strip = (buf: ArrayBuffer) => new Uint8Array(buf).filter((c, i, all) => !(c === 13 && all[i + 1] === 10));
  const x = strip(a);
  const y = strip(b);
  return x.length === y.length && x.every((c, i) => c === y[i]);
}

function conflictName(path: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const cut = dot > slash + 1 ? dot : path.length;
  return `${path.slice(0, cut)}.sync-conflict-${stamp}${path.slice(cut)}`;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

export class VaultSync {
  constructor(private cfg: SyncConfig) {}

  private get folder() {
    return normalizeFolder(this.cfg.folder);
  }

  private ignored = (path: string): boolean =>
    this.cfg.ignore.some((p) => p && (path === p || path.startsWith(p + "/")));

  async sync(): Promise<SyncResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once();
      } catch (err) {
        if (!(err instanceof Raced) || attempt === 3) throw err;
      }
    }
  }

  private async once(): Promise<SyncResult> {
    const { github, local, store } = this.cfg;
    const folder = this.folder;
    const saved = await store.load();
    const st: State =
      saved && saved.key === this.cfg.key ? saved : { key: this.cfg.key, branch: "", commit: null, base: {}, hashes: {} };
    st.branch ||= this.cfg.branch || (await github.defaultBranch());

    // 1. Remote: this folder's files at the branch head. Unchanged head means unchanged files.
    let head: string;
    try {
      head = await github.head(st.branch);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 409) throw new Error("The repository is empty. Add a README on GitHub, then sync again.");
      if (err instanceof GitHubError && err.status === 404) throw new Error(`Repository or branch "${st.branch}" not found, or the token cannot access it.`);
      throw err;
    }
    let rootTree: string | null = null;
    let remote: Map<string, string>;
    if (head === st.commit) {
      remote = new Map(Object.entries(st.base));
    } else {
      rootTree = await github.commitTree(head);
      remote = await this.remoteFiles(rootTree);
    }

    // 2. Local: hash only what changed since the last run.
    const files = new Map<string, string>();
    const hashes: State["hashes"] = {};
    for (const f of await local.list(this.ignored)) {
      if (this.ignored(f.path)) continue;
      const cached = st.hashes[f.path];
      const sha = cached && cached.mtime === f.mtime && cached.size === f.size ? cached.sha : await gitSha(await local.read(f.path));
      hashes[f.path] = { mtime: f.mtime, size: f.size, sha };
      files.set(f.path, sha);
    }
    st.hashes = hashes;

    // 3. Three-way decision per path against the last synced state.
    const pull: string[] = [];
    const remove: string[] = [];
    const push: string[] = [];
    const drop: string[] = [];
    const conflicted: string[] = [];
    for (const p of new Set([...files.keys(), ...remote.keys()])) {
      const l = files.get(p);
      const r = remote.get(p);
      const b = st.base[p];
      if (l === r) continue;
      if (l === b) (r ? pull : remove).push(p);
      else if (r === b) (l ? push : drop).push(p);
      else if (!l) pull.push(p); // deleted here, changed there: keep their edit
      else if (!r) push.push(p); // deleted there, changed here: keep ours
      else conflicted.push(p);
    }

    // 4. Apply remote changes. `next` tracks what the remote folder holds once we are done.
    const next = new Map(remote);
    const write = async (path: string, data: ArrayBuffer, sha: string) => {
      st.hashes[path] = { ...(await local.write(path, data)), sha };
    };
    await pool(pull, 6, async (p) => write(p, await github.blob(remote.get(p)!), remote.get(p)!));
    for (const p of remove) {
      await local.remove(p);
      delete st.hashes[p];
    }
    const copies: string[] = [];
    await pool(conflicted, 6, async (p) => {
      const theirs = await github.blob(remote.get(p)!);
      if (sameText(await local.read(p), theirs)) {
        await write(p, theirs, remote.get(p)!); // only line endings differ: take the repository's bytes
        return;
      }
      // Keep ours, park theirs beside it. Their blob already exists remotely, so it needs no upload.
      const name = conflictName(p);
      await write(name, theirs, remote.get(p)!);
      next.set(name, remote.get(p)!);
      copies.push(name);
      push.push(p);
    });
    st.commit = head;
    st.base = Object.fromEntries(remote);
    await store.save(st);

    // 5. Push local changes as one commit on top of the head we read.
    const changes: { path: string; sha: string | null }[] = copies.map((c) => ({ path: `${folder}/${c}`, sha: next.get(c)! }));
    await pool(push, 4, async (p) => {
      const sha = await github.createBlob(toBase64(await local.read(p)));
      changes.push({ path: `${folder}/${p}`, sha });
      next.set(p, sha);
    });
    for (const p of drop) {
      changes.push({ path: `${folder}/${p}`, sha: null });
      next.delete(p);
    }
    if (changes.length) {
      rootTree ??= await github.commitTree(head);
      const tree = await github.createTree(rootTree, changes);
      const commit = await github.createCommit(this.cfg.message, tree, head);
      try {
        await github.updateHead(st.branch, commit);
      } catch (err) {
        if (err instanceof GitHubError && err.status === 422) throw new Raced();
        throw err;
      }
      st.commit = commit;
      st.base = Object.fromEntries(next);
      await store.save(st);
    }

    return { pushed: changes.length > 0, pulled: pull.length + remove.length, conflicts: copies };
  }

  private async remoteFiles(rootTree: string): Promise<Map<string, string>> {
    const { github } = this.cfg;
    let sha = rootTree;
    for (const segment of this.folder.split("/")) {
      const entry = (await github.tree(sha)).find((e) => e.path === segment && e.type === "tree");
      if (!entry) return new Map(); // folder not created yet
      sha = entry.sha;
    }
    const out = new Map<string, string>();
    for (const e of await github.tree(sha, true)) {
      if (e.type === "blob" && !this.ignored(e.path)) out.set(e.path, e.sha);
    }
    return out;
  }
}
