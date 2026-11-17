#!/usr/bin/env node
const { createInterface } = require("node:readline");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

assert.equal(process.cwd(), join(process.env.GITHUB_WORKSPACE, "source"));
assert.equal(execFileSync("git", ["rev-parse", "--show-toplevel"], {encoding: "utf8"}).trim(), process.cwd());
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  }
  if (message.type !== "user") return;
  const testCase = process.env.SDK_FIXTURE_CASE;
  if (testCase === "startup-failure") process.exit(2);
  const failed = testCase === "turn-limit";
  send({
    type: "result",
    subtype: failed ? "error_max_turns" : "success",
    is_error: failed,
    errors: failed ? ["Fixture turn limit reached"] : undefined,
    num_turns: 1,
    stop_reason: failed ? null : "max_tokens",
    result: failed ? undefined : "An incomplete response",
  });
});
