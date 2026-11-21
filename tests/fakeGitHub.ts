// In-memory fake of the GitHub REST endpoints the plugin uses.
import { createHash } from "node:crypto";
import type { Http, HttpRequest, HttpResponse } from "../src/github/client";

interface Commit {
  tree: Map<string, string>; // path -> blob sha
  parents: string[];
  message: string;
  author: string;
}

export class FakeGitHub {
  blobs = new Map<string, Buffer>();
  commits = new Map<string, Commit>();
  trees = new Map<string, Map<string, string>>();
  refs = new Map<string, string>();
  requests: HttpRequest[] = [];
  canPush = true;
  token = "good-token";
  truncateTrees = false;
  /** Called before a ref PATCH, to simulate someone pushing meanwhile. */
  beforeRefUpdate: (() => void) | null = null;
  rateRemaining = 4999;
  private n = 0;

  constructor(public owner = "BrandonDevMn", public repo = "Claudian") {}

  // ---- helpers for tests -------------------------------------------------
  putBlob(content: Buffer | string): string {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const sha = createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
    this.blobs.set(sha, buf);
    return sha;
  }

  /** Commit files on top of the branch head, as Claude would with git. */
  commitFiles(branch: string, files: Record<string, string | null>, message = "Claude edit", author = "Claude"): string {
    const head = this.refs.get(branch);
    const tree = new Map(head ? this.commits.get(head)!.tree : []);
    for (const [p, c] of Object.entries(files)) {
      if (c === null) tree.delete(p);
      else tree.set(p, this.putBlob(c));
    }
    const sha = this.id("c");
    this.commits.set(sha, { tree, parents: head ? [head] : [], message, author });
    this.refs.set(branch, sha);
    return sha;
  }

  files(branch = "main"): Record<string, string> {
    const head = this.refs.get(branch);
    const out: Record<string, string> = {};
    if (!head) return out;
    for (const [p, s] of this.commits.get(head)!.tree) out[p] = this.blobs.get(s)!.toString();
    return out;
  }

  headMessage(branch = "main"): string {
    return this.commits.get(this.refs.get(branch)!)!.message;
  }

  private id(prefix: string): string {
    return createHash("sha1").update(`${prefix}${this.n++}`).digest("hex");
  }

  private treeId(tree: Map<string, string>): string {
    const id = this.id("t");
    this.trees.set(id, tree);
    return id;
  }

  // ---- Http implementation ----------------------------------------------
  http: Http = async (req) => {
    this.requests.push(req);
    if (req.headers.Authorization !== `Bearer ${this.token}`) return res(401, { message: "Bad credentials" });
    this.rateRemaining--;
    const url = new URL(req.url);
    const base = `/repos/${this.owner}/${this.repo}`;
    const path = decodeURIComponent(url.pathname);
    if (!path.startsWith(base)) return res(404, { message: "Not Found" });
    const rest = path.slice(base.length);
    const body = req.body ? JSON.parse(req.body) : undefined;
    const empty = this.refs.size === 0;
    const r = (status: number, json: unknown) => res(status, json, this.rateRemaining);

    if (rest === "" && req.method === "GET")
      return r(200, { permissions: { push: this.canPush }, default_branch: "main", private: true });

    if (rest === "/git/refs" && req.method === "GET") {
      if (empty) return r(409, { message: "Git Repository is empty." });
      return r(200, [...this.refs.keys()].map((b) => ({ ref: `refs/heads/${b}` })));
    }
    let m = rest.match(/^\/git\/refs?\/heads\/(.+)$/);
    if (m) {
      const branch = m[1]!;
      if (req.method === "GET") {
        if (empty) return r(409, { message: "Git Repository is empty." });
        const sha = this.refs.get(branch);
        return sha ? r(200, { object: { sha } }) : r(404, { message: "Not Found" });
      }
      if (req.method === "PATCH") {
        if (!this.canPush) return r(403, { message: "Resource not accessible by personal access token" });
        this.beforeRefUpdate?.();
        this.beforeRefUpdate = null;
        const current = this.refs.get(branch)!;
        const next = this.commits.get(body.sha)!;
        if (!body.force && !next.parents.includes(current)) return r(422, { message: "Update is not a fast forward" });
        this.refs.set(branch, body.sha);
        return r(200, { object: { sha: body.sha } });
      }
    }
    m = rest.match(/^\/git\/commits\/(\w+)$/);
    if (m && req.method === "GET") {
      const c = this.commits.get(m[1]!);
      return c ? r(200, { tree: { sha: this.treeId(c.tree) } }) : r(404, { message: "Not Found" });
    }
    m = rest.match(/^\/git\/trees\/(\w+)$/);
    if (m && req.method === "GET") {
      const tree = this.trees.get(m[1]!);
      if (!tree) return r(404, { message: "Not Found" });
      const recursive = url.searchParams.has("recursive");
      if (recursive && !this.truncateTrees) {
        return r(200, {
          truncated: false,
          tree: [...tree].map(([p, s]) => ({ path: p, type: "blob", sha: s, size: this.blobs.get(s)!.length })),
        });
      }
      if (recursive) return r(200, { truncated: true, tree: [] });
      // non-recursive: one level
      const entries = new Map<string, { type: string; sha: string; size?: number }>();
      for (const [p, s] of tree) {
        const slash = p.indexOf("/");
        if (slash < 0) entries.set(p, { type: "blob", sha: s, size: this.blobs.get(s)!.length });
        else {
          const dir = p.slice(0, slash);
          if (!entries.has(dir)) {
            const sub = new Map<string, string>();
            for (const [p2, s2] of tree) if (p2.startsWith(dir + "/")) sub.set(p2.slice(dir.length + 1), s2);
            entries.set(dir, { type: "tree", sha: this.treeId(sub) });
          }
        }
      }
      return r(200, { truncated: false, tree: [...entries].map(([p, e]) => ({ path: p, ...e })) });
    }
    m = rest.match(/^\/git\/blobs\/(\w+)$/);
    if (m && req.method === "GET") {
      const b = this.blobs.get(m[1]!);
      return b ? r(200, { content: b.toString("base64"), encoding: "base64" }) : r(404, { message: "Not Found" });
    }
    if (rest === "/git/blobs" && req.method === "POST") {
      if (empty) return r(409, { message: "Git Repository is empty." });
      return r(201, { sha: this.putBlob(Buffer.from(body.content, "base64")) });
    }
    if (rest === "/git/trees" && req.method === "POST") {
      const tree = new Map(this.trees.get(body.base_tree) ?? []);
      for (const e of body.tree as { path: string; sha: string | null }[]) {
        if (e.sha === null) {
          if (!tree.has(e.path)) return r(422, { message: `path ${e.path} does not exist` });
          tree.delete(e.path);
        } else tree.set(e.path, e.sha);
      }
      return r(201, { sha: this.treeId(tree) });
    }
    if (rest === "/git/commits" && req.method === "POST") {
      const sha = this.id("c");
      this.commits.set(sha, { tree: this.trees.get(body.tree)!, parents: body.parents, message: body.message, author: "Brandon" });
      return r(201, { sha });
    }
    m = rest.match(/^\/contents\/(.+)$/);
    if (m && req.method === "PUT") {
      const sha = this.commitFiles(body.branch, { [m[1]!]: Buffer.from(body.content, "base64").toString() }, body.message, "Brandon");
      return r(201, { commit: { sha } });
    }
    m = rest.match(/^\/compare\/(\w+)\.\.\.(\w+)$/);
    if (m && req.method === "GET") {
      const [, b, h] = m as unknown as [string, string, string];
      const chain: string[] = [];
      let cur: string | undefined = h;
      while (cur && cur !== b) {
        chain.push(cur);
        cur = this.commits.get(cur)?.parents[0];
      }
      if (cur !== b) return r(200, { status: "diverged", commits: [] });
      return r(200, {
        status: chain.length ? "ahead" : "identical",
        commits: chain.reverse().map((s) => ({ sha: s, commit: { message: this.commits.get(s)!.message, author: { name: this.commits.get(s)!.author } } })),
      });
    }
    return r(404, { message: `Fake has no route for ${req.method} ${rest}` });
  };
}

function res(status: number, json: unknown, remaining = 4999): HttpResponse {
  return {
    status,
    headers: { "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) },
    text: JSON.stringify(json),
  };
}
