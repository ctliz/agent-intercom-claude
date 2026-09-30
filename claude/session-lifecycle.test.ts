import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeSessionReader, claudeIdentityForSession, publishClaudeSessionMetadata,
  readClaudeSessionMetadata, waitForClaudeSession,
} from "./session-lifecycle.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "claude-lifecycle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "host.json");
  const transcript = join(dir, "session.jsonl");
  const host = { pid: 42, startedAt: "Wed Sep 30 12:34:56 2026" };
  const start = (id = "session-a", title = "reviewer") => publishClaudeSessionMetadata({
    hook_event_name: "SessionStart", session_id: id, session_title: title,
    cwd: dir, transcript_path: transcript, model: "opus",
  }, host, {}, path);
  return { dir, path, transcript, host, start, reader: new ClaudeSessionReader(path, host) };
}

const titleRecord = (title: string, sessionId = "session-a") =>
  JSON.stringify({ type: "custom-title", customTitle: title, sessionId });

test("SessionStart publishes private metadata only, without another broker owner", (t) => {
  const f = fixture(t);
  f.start();
  const metadata = readClaudeSessionMetadata(f.path, f.host)!;
  assert.equal(metadata.name, "reviewer");
  assert.equal(metadata.ended, false);
  assert.deepEqual(readdirSync(f.dir), ["host.json"]);
  if (process.platform !== "win32") {
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.equal(statSync(f.dir).mode & 0o777, 0o700);
  }
  const identity = claudeIdentityForSession(metadata, {}, 42);
  assert.equal(identity.sessionId, "claude-session-a");
  assert.equal(identity.name, "reviewer");
  assert.equal(identity.cwd, f.dir);
  assert.equal(identity.model, "opus");
});

test("launcher IDs retain precedence and are not replaced by native conversation IDs", (t) => {
  const f = fixture(t); f.start();
  const metadata = f.reader.read()!;
  assert.equal(claudeIdentityForSession(metadata, { AGENT_INTERCOM_SESSION_ID: "pane-1" }).sessionId, "pane-1");
  const identity = claudeIdentityForSession(metadata, {
    CLAUDE_INTERCOM_SESSION_ID: "explicit", CLAUDE_PEER_ID: "peer",
    AGENT_INTERCOM_SESSION_ID: "generic", CLAUDE_INTERCOM_MODEL: "proxy-opus",
  });
  assert.equal(identity.sessionId, "explicit");
  assert.equal(identity.model, "proxy-opus");
  assert.throws(() => claudeIdentityForSession(metadata, { AGENT_INTERCOM_SESSION_ID: "invalid id" }));
});

test("metadata rejects malformed records and stale PID reuse", (t) => {
  const f = fixture(t); f.start();
  assert.equal(readClaudeSessionMetadata(f.path, { ...f.host, startedAt: "different process" }), undefined);
  for (const data of [null, {}, { ...f.reader.read(), sessionId: "../bad" }, { ...f.reader.read(), name: 1 }]) {
    writeFileSync(f.path, JSON.stringify(data));
    assert.equal(f.reader.read(), undefined);
  }
});

test("/rename is detected without a prompt, including partial lines and Unicode", (t) => {
  const f = fixture(t); f.start();
  writeFileSync(f.transcript, `${titleRecord("startup")}\n`);
  assert.equal(f.reader.read()?.name, "startup");
  appendFileSync(f.transcript, `${titleRecord("wrong", "other-session")}\n{"type":"user","message":"not a title"}\n`);
  assert.equal(f.reader.read()?.name, "startup");
  const rename = titleRecord("审查助手 🚀");
  appendFileSync(f.transcript, rename.slice(0, -2));
  assert.equal(f.reader.read()?.name, "startup");
  appendFileSync(f.transcript, `${rename.slice(-2)}\n`);
  assert.equal(f.reader.read()?.name, "审查助手 🚀");
  assert.equal(f.reader.read()?.name, "审查助手 🚀");
  assert.equal(claudeIdentityForSession(f.reader.read(), {}, 42).sessionId, "claude-session-a");
});

test("resume/clear switch identity and a delayed SessionEnd cannot end the new conversation", (t) => {
  const f = fixture(t); f.start();
  const original = claudeIdentityForSession(f.reader.read(), {}, 42).sessionId;
  publishClaudeSessionMetadata({ hook_event_name: "SessionEnd", session_id: "session-a" }, f.host, {}, f.path);
  assert.equal(f.reader.read()?.ended, true);
  f.start("session-a", "resumed");
  assert.equal(claudeIdentityForSession(f.reader.read(), {}, 99).sessionId, original);
  f.start("session-b", "cleared");
  publishClaudeSessionMetadata({ hook_event_name: "SessionEnd", session_id: "session-a" }, f.host, {}, f.path);
  assert.equal(f.reader.read()?.ended, false);
  assert.equal(f.reader.read()?.name, "cleared");
  assert.equal(claudeIdentityForSession(f.reader.read(), {}, 42).sessionId, "claude-session-b");
});

test("startup waits for racing hook metadata and transcript creation", async (t) => {
  const f = fixture(t);
  const timer = setTimeout(() => f.start(), 10);
  t.after(() => clearTimeout(timer));
  assert.equal((await waitForClaudeSession(f.reader))?.name, "reviewer");
  writeFileSync(f.transcript, `${titleRecord("new-title")}\n`);
  assert.equal(f.reader.read()?.name, "new-title");
});

test("large transcript history is bounded and truncation does not hide a rename", (t) => {
  const f = fixture(t); f.start();
  writeFileSync(f.transcript, `${"x".repeat(1024 * 1024)}\n${titleRecord("latest")}\n`);
  assert.equal(f.reader.read()?.name, "latest");
  writeFileSync(f.transcript, `${titleRecord("rotated")}\n`);
  assert.equal(f.reader.read()?.name, "rotated");
});
