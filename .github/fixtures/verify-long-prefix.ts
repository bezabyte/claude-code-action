import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const action = process.cwd();
const issueNumber = Number(process.env.FIXTURE_ISSUE);
assert.ok(issueNumber === 123 || issueNumber === 124);
const prefix = "Automation/Customer-Application-Integration-Triage/";
const expectedBranch = "^automation/.*issue-" + issueNumber + "-[0-9]{8}-[0-9]{4}$";
const root = mkdtempSync(join(tmpdir(), "branch-template-"));
const repo = join(root, "repo");
const remote = join(root, "remote.git");
const pr = "/repos/fixture/repo";
const updatePath = pr + "/issues/comments/123";
const timestamp = "2026-06-01T12:00:00Z";
const marker = "Fix the issue described above.";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

git(root, "init", "--initial-branch=main", repo);
writeFileSync(join(repo, "README.md"), "Base checkout\n");
git(repo, "add", ".");
git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Base");
git(root, "clone", "--bare", repo, remote);
const remoteUrl = pathToFileURL(remote).href;
git(repo, "remote", "add", "origin", remoteUrl);
git(repo, "config", "url." + remoteUrl + ".insteadOf",
  "https://x-access-token:fixture-token@example.invalid/fixture/repo.git");
const base = git(repo, "rev-parse", "HEAD");
const eventPath = join(root, "event.json");
writeFileSync(eventPath, JSON.stringify({
  action: "opened",
  repository: { full_name: "fixture/repo", default_branch: "main" },
  issue: {
    number: issueNumber, state: "open", title: "Fix password reset", body: "",
    user: { id: 1, login: "reviewer" }, created_at: timestamp, updated_at: timestamp,
  },
}));

const cli = join(root, "claude-fixture");
writeFileSync(cli, `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { createInterface } = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  }
  if (message.type === "user") {
    const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
    if (!JSON.stringify(message).includes(${JSON.stringify(marker)}) || !new RegExp(${JSON.stringify(expectedBranch)}).test(branch)) {
      console.error("Unexpected branch or missing task:", branch);
      process.exit(2);
    }
    require("node:fs").writeFileSync(${JSON.stringify(join(root, "branch-used"))}, branch);
    send({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Review completed." });
  }
});
`);
chmodSync(cli, 0o700);

let initial = "";
let final = "";
let created = 0;
let updated = 0;
const unexpected: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const method = request.method;
    if (path === pr + "/collaborators/contributor/permission" || path === pr + "/collaborators/reviewer/permission") return Response.json({ permission: "write" });
    if (path === "/users/reviewer") return Response.json({ type: "User" });
    if (path === pr) return Response.json({ default_branch: "main" });
    if (path === pr + "/git/ref/heads/main") return Response.json({ object: { sha: base } });
    if (path === pr + "/issues/" + issueNumber + "/comments" && method === "POST") {
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
    if (path.startsWith(pr + "/compare/")) return Response.json({ total_commits: 0, files: [] });
    if (path === "/graphql") {
      const { query } = await request.json();
      if (!query.includes("issue(")) return Response.json({ data: { user: { name: "Fixture Reviewer" } } });
      return Response.json({ data: { repository: { issue: {
        title: "Fix password reset", body: "", author: { login: "reviewer", __typename: "User" },
        createdAt: timestamp, updatedAt: timestamp, state: "OPEN",
        labels: { nodes: [] }, comments: { nodes: [] },
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
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env, GITHUB_ACTION_PATH: action, GITHUB_WORKSPACE: repo,
      GITHUB_EVENT_NAME: "issues", GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "fixture/repo", GITHUB_ACTOR: "reviewer", GITHUB_RUN_ID: "123",
      GITHUB_API_URL: api, GITHUB_GRAPHQL_URL: api + "/graphql", GITHUB_SERVER_URL: "https://example.invalid",
      GITHUB_OUTPUT: outputPath, RUNNER_TEMP: root, INPUT_SHOW_FULL_OUTPUT: "false",
      USE_COMMIT_SIGNING: "false",
      PROMPT: marker, TRACK_PROGRESS: "true", BRANCH_NAME_TEMPLATE: "", BRANCH_PREFIX: prefix, CLASSIFY_INLINE_COMMENTS: "false",
      OVERRIDE_GITHUB_TOKEN: "fixture-token", ANTHROPIC_API_KEY: "fixture-key",
      PATH_TO_CLAUDE_CODE_EXECUTABLE: cli,
    },
    signal: AbortSignal.timeout(60_000),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    result.exited,
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
  ]);
  const logs = stdout + "\n" + stderr;
  console.log(logs);
  assert.equal(exitCode, 0);
  assert.deepEqual(unexpected, []);
  const outputs = readFileSync(outputPath, "utf8");
  assert.match(outputs, /claude_comment_id=123/);
  assert.match(outputs, /conclusion<<[^\n]+\nsuccess\n/);
  assert.equal(created, 1);
  assert.equal(updated, 1);
  assert.match(initial, /working/i);
  assert.match(final, /finished/i);
  const branchUsed = readFileSync(join(root, "branch-used"), "utf8");
  assert.match(branchUsed, new RegExp(expectedBranch));
  assert.equal(branchUsed.length, 50);
  assert.equal(git(repo, "check-ref-format", "--branch", branchUsed), branchUsed);
  console.log("Verified Claude started on", branchUsed, "for issue", issueNumber);

} finally {
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
