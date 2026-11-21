import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError, type Http } from "../src/github/client";
import { Logger, formatLog } from "../src/core/logger";
import { FakeGitHub } from "./fakeGitHub";

const make = (gh: FakeGitHub, token = "good-token", http?: Http) => {
  const log = new Logger();
  const client = new GitHubClient({
    owner: "BrandonDevMn",
    repo: "Claudian",
    token,
    http: http ?? gh.http,
    log,
    sleep: async () => {},
    writeGapMs: 0,
  });
  return { client, log };
};

describe("GitHub client", () => {
  it("reports empty repos and missing branches", async () => {
    const gh = new FakeGitHub();
    const { client } = make(gh);
    expect(await client.branchHead("main")).toBe("empty");
    gh.commitFiles("main", { "a.md": "a" });
    expect(await client.branchHead("dev")).toBe(null);
    expect(typeof (await client.branchHead("main"))).toBe("string");
  });

  it("reads trees and blobs, including truncated trees", async () => {
    const gh = new FakeGitHub();
    const head = gh.commitFiles("main", { "a.md": "A", "games/x/b.md": "B", "games/x/y/c.md": "C" });
    const { client } = make(gh);
    const tree = await client.commitTree(head);
    gh.truncateTrees = true;
    const entries = await client.listTree(tree);
    expect(entries.map((e) => e.path).sort()).toEqual(["a.md", "games/x/b.md", "games/x/y/c.md"]);
    const b = entries.find((e) => e.path === "games/x/b.md")!;
    expect(new TextDecoder().decode(await client.getBlob(b.sha))).toBe("B");
  });

  it("creates a commit and refuses non-fast-forward updates", async () => {
    const gh = new FakeGitHub();
    const head = gh.commitFiles("main", { "a.md": "A" });
    const { client } = make(gh);
    const blob = await client.createBlob(new TextEncoder().encode("A2"));
    const tree = await client.createTree(await client.commitTree(head), [{ path: "a.md", sha: blob }]);
    const commit = await client.createCommit("msg", tree, [head]);
    gh.beforeRefUpdate = () => gh.commitFiles("main", { "z.md": "z" });
    await expect(client.updateBranch("main", commit)).rejects.toMatchObject({ kind: "not-fast-forward" });
  });

  it("maps bad tokens to an auth error and never logs the token", async () => {
    const gh = new FakeGitHub();
    const { client, log } = make(gh, "github_pat_SECRETSECRETSECRETSECRET");
    await expect(client.repoInfo()).rejects.toBeInstanceOf(GitHubError);
    await expect(client.repoInfo()).rejects.toMatchObject({ kind: "auth" });
    expect(formatLog(log.all())).not.toContain("SECRETSECRET");
  });

  it("waits and retries once on a secondary rate limit", async () => {
    const gh = new FakeGitHub();
    gh.commitFiles("main", { "a.md": "A" });
    let calls = 0;
    const slept: number[] = [];
    const http: Http = async (req) => {
      calls++;
      if (calls === 1) return { status: 403, headers: { "retry-after": "60" }, text: '{"message":"secondary rate limit"}' };
      return gh.http(req);
    };
    const log = new Logger();
    const client = new GitHubClient({ owner: "BrandonDevMn", repo: "Claudian", token: "good-token", http, log, sleep: async (ms) => { slept.push(ms); }, writeGapMs: 0 });
    await client.repoInfo();
    expect(slept).toEqual([60000]);
    expect(log.list("warn")[0]?.msg).toContain("Rate limited");
  });

  it("logs each request with method, path, status and time", async () => {
    const gh = new FakeGitHub();
    const { client, log } = make(gh);
    await client.repoInfo();
    expect(log.list()[0]?.msg).toMatch(/^HTTP GET \/repos\/BrandonDevMn\/Claudian -> 200 in \d+ ms/);
  });

  it("spaces out content-creating requests", async () => {
    const gh = new FakeGitHub();
    gh.commitFiles("main", { "a.md": "A" });
    let t = 0;
    const slept: number[] = [];
    const client = new GitHubClient({
      owner: "BrandonDevMn", repo: "Claudian", token: "good-token", http: gh.http, log: new Logger(),
      now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, writeGapMs: 1000,
    });
    await client.createBlob(new Uint8Array([1]));
    await client.createBlob(new Uint8Array([2]));
    expect(slept).toEqual([1000]);
  });
});
