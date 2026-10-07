export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
}

/** Plain HTTP, injected so the plugin can use Obsidian's requestUrl (works on mobile, no CORS). */
export type Fetcher = (req: HttpRequest) => Promise<HttpResponse>;

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

/** Accepts https://github.com/o/r(.git), git@github.com:o/r.git or o/r. */
export function parseRepo(url: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim()) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export class GitHub {
  constructor(private fetch: Fetcher, private repo: string, private token: string) {}

  private async send(method: string, path: string, body?: unknown, raw = false): Promise<HttpResponse> {
    const res = await this.fetch({
      method,
      url: `https://api.github.com/repos/${this.repo}${path}`,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status >= 400) {
      let message = res.text;
      try {
        message = (JSON.parse(res.text) as { message?: string }).message ?? message;
      } catch {
        // not JSON, keep the text
      }
      throw new GitHubError(res.status, `GitHub ${res.status}: ${message}`);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return JSON.parse((await this.send(method, path, body)).text) as T;
  }

  async defaultBranch(): Promise<string> {
    return (await this.json<{ default_branch: string }>("GET", "")).default_branch;
  }

  async head(branch: string): Promise<string> {
    return (await this.json<{ object: { sha: string } }>("GET", `/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
  }

  async commitTree(commit: string): Promise<string> {
    return (await this.json<{ tree: { sha: string } }>("GET", `/git/commits/${commit}`)).tree.sha;
  }

  async tree(sha: string, recursive = false): Promise<TreeEntry[]> {
    const t = await this.json<{ tree: TreeEntry[]; truncated: boolean }>("GET", `/git/trees/${sha}${recursive ? "?recursive=1" : ""}`);
    if (t.truncated) throw new Error("This vault folder has too many files for one GitHub tree listing.");
    return t.tree;
  }

  async blob(sha: string): Promise<ArrayBuffer> {
    return (await this.send("GET", `/git/blobs/${sha}`, undefined, true)).arrayBuffer;
  }

  async createBlob(base64: string): Promise<string> {
    return (await this.json<{ sha: string }>("POST", "/git/blobs", { content: base64, encoding: "base64" })).sha;
  }

  /** `sha: null` deletes the path. Paths are full repository paths. */
  async createTree(base: string, entries: { path: string; sha: string | null }[]): Promise<string> {
    const tree = entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.sha }));
    return (await this.json<{ sha: string }>("POST", "/git/trees", { base_tree: base, tree })).sha;
  }

  async createCommit(message: string, tree: string, parent: string): Promise<string> {
    return (await this.json<{ sha: string }>("POST", "/git/commits", { message, tree, parents: [parent] })).sha;
  }

  /** Fast-forward only: fails with 422 if someone else pushed first. */
  async updateHead(branch: string, sha: string): Promise<void> {
    await this.send("PATCH", `/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false });
  }
}
