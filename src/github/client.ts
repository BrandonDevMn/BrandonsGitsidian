// GitHub REST client using the Git Database API. All I/O goes through an injected
// `Http` function; in the plugin that's Obsidian's requestUrl (specs/12-ios-platform.feature).

import type { Logger } from "../core/logger";
import { base64ToBytes, bytesToBase64 } from "../core/blob";

export interface HttpRequest {
  url: string;
  method: "GET" | "POST" | "PATCH" | "PUT";
  headers: Record<string, string>;
  body?: string;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export type ErrorKind =
  | "network"
  | "auth"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "not-fast-forward"
  | "empty-repo"
  | "other";

export class GitHubError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
    public status = 0,
    public retryAfterSec = 0,
  ) {
    super(message);
  }
}

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

export interface RateInfo {
  remaining: number | null;
  resetAt: number | null; // epoch ms
}

export interface ClientOptions {
  owner: string;
  repo: string;
  token: string;
  http: Http;
  log: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between content-creating requests (secondary rate limit). */
  writeGapMs?: number;
}

const API = "https://api.github.com";

export class GitHubClient {
  readonly rate: RateInfo = { remaining: null, resetAt: null };
  requestCount = 0;
  private lastWrite: number | null = null;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private o: ClientOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get repoPath(): string {
    return `/repos/${encodeURIComponent(this.o.owner)}/${encodeURIComponent(this.o.repo)}`;
  }

  private async call<T>(method: HttpRequest["method"], path: string, body?: unknown, write = false): Promise<T> {
    if (write) {
      const gap = this.o.writeGapMs ?? 1000;
      const wait = this.lastWrite === null ? 0 : this.lastWrite + gap - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastWrite = this.now();
    }
    const started = this.now();
    let res: HttpResponse;
    try {
      res = await this.o.http({
        url: API + path,
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.o.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      this.o.log.error(`HTTP ${method} ${path} failed: ${(e as Error).message}`);
      throw new GitHubError("network", "Network request failed");
    }
    this.requestCount++;
    const h = lower(res.headers);
    if (h["x-ratelimit-remaining"] !== undefined) this.rate.remaining = Number(h["x-ratelimit-remaining"]);
    if (h["x-ratelimit-reset"] !== undefined) this.rate.resetAt = Number(h["x-ratelimit-reset"]) * 1000;
    this.o.log.debug(
      `HTTP ${method} ${path} -> ${res.status} in ${this.now() - started} ms (rate left: ${this.rate.remaining ?? "?"})`,
    );

    if (res.status >= 200 && res.status < 300) return (res.text ? JSON.parse(res.text) : {}) as T;

    const message = safeMessage(res.text);
    if (res.status === 401) throw new GitHubError("auth", message, 401);
    if (res.status === 403 || res.status === 429) {
      const retry = Number(h["retry-after"] ?? 0);
      if (retry > 0 || this.rate.remaining === 0 || /rate limit/i.test(message)) {
        const resetIn = this.rate.resetAt ? Math.max(0, Math.ceil((this.rate.resetAt - this.now()) / 1000)) : 60;
        throw new GitHubError("rate-limited", message, res.status, retry > 0 ? retry : resetIn);
      }
      throw new GitHubError("forbidden", message, res.status);
    }
    if (res.status === 404) throw new GitHubError("not-found", message, 404);
    if (res.status === 409 && /empty/i.test(message)) throw new GitHubError("empty-repo", message, 409);
    if (res.status === 422 && /fast.?forward/i.test(message)) throw new GitHubError("not-fast-forward", message, 422);
    throw new GitHubError("other", `${res.status}: ${message}`, res.status);
  }

  /** Retries once after a secondary rate limit with a short retry-after (specs/09). */
  private async callWithRetry<T>(method: HttpRequest["method"], path: string, body?: unknown, write = false): Promise<T> {
    try {
      return await this.call<T>(method, path, body, write);
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "rate-limited" && e.retryAfterSec > 0 && e.retryAfterSec <= 120) {
        this.o.log.warn(`Rate limited; waiting ${e.retryAfterSec}s before retrying ${method} ${path}`);
        await this.sleep(e.retryAfterSec * 1000);
        return this.call<T>(method, path, body, write);
      }
      throw e;
    }
  }

  async repoInfo(): Promise<{ canPush: boolean; defaultBranch: string; isPrivate: boolean }> {
    const r = await this.callWithRetry<{ permissions?: { push?: boolean }; default_branch: string; private: boolean }>(
      "GET",
      this.repoPath,
    );
    return { canPush: !!r.permissions?.push, defaultBranch: r.default_branch, isPrivate: r.private };
  }

  /** Head commit SHA of a branch, null if the branch doesn't exist, "empty" if the repo has no commits. */
  async branchHead(branch: string): Promise<string | null | "empty"> {
    try {
      const r = await this.callWithRetry<{ object: { sha: string } }>(
        "GET",
        `${this.repoPath}/git/ref/heads/${encodePath(branch)}`,
      );
      return r.object.sha;
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "empty-repo") return "empty";
      if (e instanceof GitHubError && e.kind === "not-found") {
        // An empty repo also 404s/409s here; distinguish by listing refs.
        try {
          await this.call("GET", `${this.repoPath}/git/refs`);
        } catch (e2) {
          if (e2 instanceof GitHubError && (e2.kind === "empty-repo" || e2.kind === "not-found")) return "empty";
          throw e2;
        }
        return null;
      }
      throw e;
    }
  }

  async commitTree(commitSha: string): Promise<string> {
    const r = await this.callWithRetry<{ tree: { sha: string } }>("GET", `${this.repoPath}/git/commits/${commitSha}`);
    return r.tree.sha;
  }

  /** All blobs in a tree. Handles `truncated` by walking subtrees (specs/03). */
  async listTree(treeSha: string): Promise<TreeEntry[]> {
    type Raw = { tree: { path: string; type: string; sha: string; size?: number }[]; truncated: boolean };
    const r = await this.callWithRetry<Raw>("GET", `${this.repoPath}/git/trees/${treeSha}?recursive=1`);
    if (!r.truncated) {
      return r.tree.filter((e) => e.type === "blob").map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
    }
    this.o.log.info("Remote tree was truncated; walking subtrees one at a time");
    const out: TreeEntry[] = [];
    const walk = async (sha: string, prefix: string) => {
      const t = await this.callWithRetry<Raw>("GET", `${this.repoPath}/git/trees/${sha}`);
      for (const e of t.tree) {
        const p = prefix + e.path;
        if (e.type === "blob") out.push({ path: p, sha: e.sha, size: e.size ?? 0 });
        else if (e.type === "tree") await walk(e.sha, p + "/");
      }
    };
    await walk(treeSha, "");
    return out;
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    const r = await this.callWithRetry<{ content: string; encoding: string }>("GET", `${this.repoPath}/git/blobs/${sha}`);
    if (r.encoding !== "base64") throw new GitHubError("other", `Unexpected blob encoding ${r.encoding}`);
    return base64ToBytes(r.content);
  }

  async createBlob(bytes: Uint8Array): Promise<string> {
    const r = await this.callWithRetry<{ sha: string }>(
      "POST",
      `${this.repoPath}/git/blobs`,
      { content: bytesToBase64(bytes), encoding: "base64" },
      true,
    );
    return r.sha;
  }

  async createTree(baseTree: string, entries: { path: string; sha: string | null }[]): Promise<string> {
    const r = await this.callWithRetry<{ sha: string }>(
      "POST",
      `${this.repoPath}/git/trees`,
      { base_tree: baseTree, tree: entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.sha })) },
      true,
    );
    return r.sha;
  }

  async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    const r = await this.callWithRetry<{ sha: string }>(
      "POST",
      `${this.repoPath}/git/commits`,
      { message, tree, parents },
      true,
    );
    return r.sha;
  }

  /** Moves the branch without force; throws not-fast-forward if someone pushed meanwhile (specs/05). */
  async updateBranch(branch: string, sha: string): Promise<void> {
    await this.callWithRetry("PATCH", `${this.repoPath}/git/refs/heads/${encodePath(branch)}`, { sha, force: false }, true);
  }

  /** Initialises an empty repo with one file via the contents API (specs/02, specs/05). */
  async initEmptyRepo(branch: string, path: string, bytes: Uint8Array, message: string): Promise<string> {
    const r = await this.callWithRetry<{ commit: { sha: string } }>(
      "PUT",
      `${this.repoPath}/contents/${encodePath(path)}`,
      { message, content: bytesToBase64(bytes), branch },
      true,
    );
    return r.commit.sha;
  }

  /** True if `base` is an ancestor of (or equal to) `head`. */
  async isAncestor(base: string, head: string): Promise<boolean> {
    if (base === head) return true;
    try {
      const r = await this.callWithRetry<{ status: string }>("GET", `${this.repoPath}/compare/${base}...${head}`);
      return r.status === "ahead" || r.status === "identical";
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not-found") return false;
      throw e;
    }
  }

  /** Commit messages between base (exclusive) and head, oldest first (specs/10). */
  async commitsBetween(base: string, head: string): Promise<{ sha: string; message: string; author: string }[]> {
    type Raw = { commits: { sha: string; commit: { message: string; author: { name: string } } }[] };
    const r = await this.callWithRetry<Raw>("GET", `${this.repoPath}/compare/${base}...${head}`);
    return r.commits.map((c) => ({ sha: c.sha, message: c.commit.message, author: c.commit.author.name }));
  }
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

function lower(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function safeMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { message?: string };
    return j.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}
