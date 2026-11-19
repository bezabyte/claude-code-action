import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

assert.equal(process.platform, "win32", "Run this reproduction on Windows");
const repoDir = await mkdtemp(join(tmpdir(), "file-modes-smoke-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
const executables = ["build.sh", "build [debug].sh"];
const files = [...executables, "README.md", "new.txt"];
type Entry = { path: string; mode: string; content: string };
let entries: Entry[] = [];
let updated = false;
const baseSha = "a".repeat(40);
const newSha = "b".repeat(40);
const treeSha = "c".repeat(40);
const api = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    const prefix = "/repos/fixture/repo/git";
    if (route === `GET ${prefix}/ref/heads/feature`) return Response.json({ object: { sha: baseSha } });
    if (route === `GET ${prefix}/commits/${baseSha}`) return Response.json({ tree: { sha: treeSha } });
    if (route === `POST ${prefix}/trees`) {
      const body = await request.json();
      assert.equal(body.base_tree, treeSha);
      entries = body.tree;
      return Response.json({ sha: treeSha });
    }
    if (route === `POST ${prefix}/commits`) {
      const body = await request.json();
      assert.deepEqual(body.parents, [baseSha]);
      return Response.json({ sha: newSha, message: body.message, author: { name: "Fixture", date: "2026-11-19T00:00:00Z" } });
    }
    if (route === `PATCH ${prefix}/refs/heads/feature`) {
      const body = await request.json();
      assert.equal(body.sha, newSha);
      assert.equal(body.force, false);
      updated = true;
      return Response.json({ object: { sha: newSha } });
    }
    console.error("Unexpected route", route);
    return Response.json({ message: "Unexpected route" }, { status: 500 });
  },
});

async function commit(serverPath: string) {
  entries = [];
  updated = false;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(serverPath)],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
      REPO_OWNER: "fixture", REPO_NAME: "repo", BRANCH_NAME: "feature", REPO_DIR: repoDir,
      GITHUB_API_URL: `http://127.0.0.1:${api.port}`, GITHUB_TOKEN: "fixture-token",
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "mode-verification", version: "1" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "commit_files", arguments: { files, message: "Update tracked scripts" } });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(updated, true, "The MCP tool must update the branch reference");
    assert.equal(entries.length, files.length);
    for (const entry of entries) assert.match(entry.content, /updated/);
    return Object.fromEntries(entries.map(entry => [entry.path, entry.mode]));
  } finally {
    await client.close();
  }
}

try {
  git("init", "--quiet");
  for (const name of files) {
    await writeFile(join(repoDir, name), "#!/bin/sh\necho updated\n");
    await chmod(join(repoDir, name), 0o644);
    if (name !== "new.txt") git("add", "--", name);
  }
  for (const name of executables) git("update-index", "--chmod=+x", "--", name);
  console.log("Git index:", git("ls-files", "--stage"));
  console.log("Windows stat mode:", (await stat(join(repoDir, "build.sh"))).mode.toString(8));
  const baseline = await commit("src/mcp/verification-baseline-server.ts");
  console.log("Baseline f431ada tree payload:", JSON.stringify(baseline));
  for (const name of files) assert.equal(baseline[name], "100644");
  const fixed = await commit("src/mcp/github-file-ops-server.ts");
  console.log("Fixed tree payload:", JSON.stringify(fixed));
  for (const name of executables) assert.equal(fixed[name], "100755");
  assert.equal(fixed["README.md"], "100644");
  assert.equal(fixed["new.txt"], "100644");
  console.log("PASS: actual commit_files tool preserves executable Git modes on Windows");
} finally {
  api.stop(true);
  await rm(repoDir, { recursive: true, force: true });
}
