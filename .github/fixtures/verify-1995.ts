import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const action = process.cwd();
const root = mkdtempSync(join(tmpdir(), "pr-history-"));
const source = join(root, "source");
const repo = join(root, "repo");
const remote = join(root, "remote.git");
const pr = "/repos/fixture/repo";
const updatePath = pr + "/issues/comments/123";
const timestamp = "2026-06-01T12:00:00Z";
const marker = "Review the shallow pull request.";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

git(root, "init", "--initial-branch=main", source);
git(source, "config", "user.name", "Fixture");
git(source, "config", "user.email", "fixture@example.invalid");
writeFileSync(join(source, "README.md"), "Base checkout\n");
git(source, "add", ".");
git(source, "commit", "-m", "Base");
const common = git(source, "rev-parse", "HEAD");
git(source, "checkout", "-b", "feature");
for (let i = 1; i <= 21; i++) git(source, "commit", "--allow-empty", "-m", "Feature " + i);
writeFileSync(join(source, "feature.txt"), "PR content\n");
git(source, "add", "feature.txt");
git(source, "commit", "-m", "Feature content");
const head = git(source, "rev-parse", "HEAD");
git(source, "checkout", "main");
writeFileSync(join(source, "base.txt"), "Base-only content\n");
git(source, "add", "base.txt");
git(source, "commit", "-m", "Base update");
const base = git(source, "rev-parse", "HEAD");
git(root, "clone", "--bare", source, remote);
const remoteUrl = pathToFileURL(remote).href;
git(root, "clone", "--depth=1", "--branch=feature", remoteUrl, repo);
git(repo, "config", "url." + remoteUrl + ".insteadOf",
  "https://x-access-token:fixture-token@example.invalid/fixture/repo.git");

const eventPath = join(root, "event.json");
writeFileSync(eventPath, JSON.stringify({
  action: "opened",
  repository: { full_name: "fixture/repo", default_branch: "main" },
  pull_request: {
    number: 42, state: "open", merged: false, head: { sha: head }, base: { ref: "main" },
    title: "Shallow pull request fixture", body: "", user: { id: 1, login: "contributor" },
    created_at: timestamp, updated_at: timestamp,
  },
}));

const cli = join(root, "claude-fixture");
writeFileSync(cli, `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const { execFileSync } = require("node:child_process");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  }
  if (message.type === "user") {
    if (!JSON.stringify(message).includes(${JSON.stringify(marker)})) process.exit(2);
    const diff = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" }).trim();
    const mergeBase = execFileSync("git", ["merge-base", "origin/main", "HEAD"], { encoding: "utf8" }).trim();
    if (diff !== "feature.txt" || mergeBase !== ${JSON.stringify(common)}) process.exit(3);
    send({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Review completed." });
  }
});
`);
chmodSync(cli, 0o700);

let initial = "";
let final = "";
let created = 0;
let updated = 0;
let compared = 0;
const unexpected: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const method = request.method;
    if (path === pr + "/collaborators/reviewer/permission" || path === pr + "/collaborators/contributor/permission") return Response.json({ permission: "write" });
    if (path === "/users/reviewer") return Response.json({ type: "User" });
    if (path === pr) return Response.json({ default_branch: "main" });
    if (path === pr + "/git/ref/heads/main") return Response.json({ object: { sha: base } });
    if (path === pr + "/issues/42/comments" && method === "POST") {
      initial = (await request.json()).body;
      created++;
      return Response.json({ id: 123, body: initial });
    }
    if (path === updatePath && method === "GET") return Response.json({ id: 123, body: initial });
    if (path === updatePath && method === "PATCH") {
      final = (await request.json()).body;
      updated++;
      return Response.json({ id: 123, body: final });
    }
    if (path.startsWith(pr + "/branches/")) return Response.json({ message: "Not Found" }, { status: 404 });
    if (path === pr + "/compare/" + base + "..." + head) {
      assert.equal(new URL(request.url).searchParams.get("per_page"), "1");
      compared++;
      return Response.json({ ahead_by: 22, behind_by: 1 });
    }
    if (path === "/graphql") {
      const { query } = await request.json();
      if (!query.includes("pullRequest(")) return Response.json({ data: { user: { name: "Fixture Reviewer" } } });
      return Response.json({ data: { repository: { pullRequest: {
        title: "Shallow pull request fixture", body: "", author: { login: "contributor", __typename: "User" },
        baseRefName: "main", headRefName: "feature", headRefOid: head, isCrossRepository: false,
        createdAt: timestamp, updatedAt: timestamp, additions: 1, deletions: 0, state: "OPEN",
        labels: { nodes: [] }, commits: { totalCount: 22, nodes: [] }, files: { nodes: [] },
        comments: { nodes: [] }, reviews: { nodes: [] },
      } } } });
    }
    unexpected.push(method + " " + path);
    return Response.json({ message: "Unexpected fixture request" }, { status: 404 });
  },
});

try {
  const outputPath = join(root, "outputs");
  writeFileSync(outputPath, "");
  const api = server.url.origin;
  const result = Bun.spawn({
    cmd: ["bun", "run", resolve(action, "src/entrypoints/run.ts")],
    cwd: repo,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env, GITHUB_ACTION_PATH: action, GITHUB_WORKSPACE: repo,
      GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "fixture/repo", GITHUB_ACTOR: "reviewer", GITHUB_RUN_ID: "123",
      GITHUB_API_URL: api, GITHUB_GRAPHQL_URL: api + "/graphql", GITHUB_SERVER_URL: "https://example.invalid",
      GITHUB_OUTPUT: outputPath, RUNNER_TEMP: root, INPUT_SHOW_FULL_OUTPUT: "false",
      PROMPT: marker, TRACK_PROGRESS: "true", CLASSIFY_INLINE_COMMENTS: "false",
      OVERRIDE_GITHUB_TOKEN: "fixture-token", ANTHROPIC_API_KEY: "fixture-key",
      PATH_TO_CLAUDE_CODE_EXECUTABLE: cli,
    },
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(await result.exited, 0);
  assert.deepEqual(unexpected, []);
  const outputs = readFileSync(outputPath, "utf8");
  assert.match(outputs, /claude_comment_id=123/);
  assert.match(outputs, /conclusion<<[^\n]+\nsuccess\n/);
  assert.equal(created, 1);
  assert.equal(updated, 1);
  assert.equal(compared, 1);
  assert.match(initial, /working/i);
  assert.match(final, /finished/i);
  assert.match(final, /fixture\/repo\/actions\/runs\/123/);
  console.log("Verified the production entry point made the merge base and PR-only diff visible to the Claude subprocess.");
} finally {
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
