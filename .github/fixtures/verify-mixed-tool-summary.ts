import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const action = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "mixed-summary-"));
const repo = join(temp, "repo");
const bare = join(temp, "origin.git");
const originalUrl = "https://example.invalid/fixture/original.git";
const header = "http.https://example.invalid/.extraheader";
const include = join(temp, "checkout credentials.config");
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

git(temp, "init", "--initial-branch=main", repo);
git(temp, "init", "--bare", "--initial-branch=main", bare);
git(repo, "config", "user.name", "Workflow User");
git(repo, "config", "user.email", "workflow@example.invalid");
git(repo, "remote", "add", "origin", originalUrl);
git(repo, "config", "url." + pathToFileURL(bare).href + ".insteadOf", originalUrl);
git(repo, "config", "--local", "--add", header, "AUTHORIZATION: basic fixture-direct");
git(repo, "config", "--file", include, "--add", header, "AUTHORIZATION: basic fixture-include");
git(repo, "config", "--local", "--add", "include.path", include);
git(repo, "commit", "--allow-empty", "-m", "Workflow base");

const event = join(temp, "event.json");
writeFileSync(event, JSON.stringify({ repository: { full_name: "fixture/repo", default_branch: "main" } }));
const cli = join(temp, "claude-fixture");
writeFileSync(cli, `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { createInterface } = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  }
  if (message.type !== "user") return;
  const blocks = [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture-image-payload" } },
    { type: "text", text: "Preview generated." },
    { type: "text", text: "Saved to preview.png." },
  ];
  send({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "preview", name: "make_preview", input: {} }] }
  });
  send({
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: "preview",
      content: process.env.FIXTURE_ENCODING === "array" ? blocks : JSON.stringify(blocks)
    }] }
  });
  send({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done." });
});
`);
chmodSync(cli, 0o700);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/users/reviewer") return Response.json({ type: "User" });
    return Response.json({ message: "Unexpected fixture request" }, { status: 404 });
  },
});

try {
  const output = join(temp, "outputs");
  writeFileSync(output, "");
  for (const encoding of ["array", "json"]) {
    const summary = join(temp, "summary-" + encoding);
    const result = Bun.spawn({
      cmd: ["bun", "run", join(action, "src/entrypoints/run.ts")],
      cwd: repo,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env, GITHUB_ACTION_PATH: action, GITHUB_WORKSPACE: repo,
        GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: event,
        GITHUB_REPOSITORY: "fixture/repo", GITHUB_ACTOR: "reviewer", GITHUB_RUN_ID: "123",
        GITHUB_API_URL: server.url.origin, GITHUB_SERVER_URL: "https://example.invalid",
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: temp, PROMPT: "Review this checkout.",
        OVERRIDE_GITHUB_TOKEN: "fixture-action-token", ANTHROPIC_API_KEY: "fixture-key",
        PATH_TO_CLAUDE_CODE_EXECUTABLE: cli, FIXTURE_ENCODING: encoding,
      },
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(await result.exited, 0);
    const report = readFileSync(summary, "utf8");
    assert.match(report, /Preview generated\.\nSaved to preview\.png\./);
    assert.doesNotMatch(report, /fixture-image-payload|\[object Object\]/);

  }
  console.log("Verified the action step summary for native and JSON-encoded tool result blocks.");
} finally {
  await server.stop(true);
  rmSync(temp, { recursive: true, force: true });
}
