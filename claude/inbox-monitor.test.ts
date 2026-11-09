import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHostBusyProbe, runInboxMonitor } from "./inbox-monitor.ts";

const entry = (text: string, ts: number) => JSON.stringify({ ts, text, fromId: "peer", messageId: text, expectsReply: false });
const fast = { pollMs: 5, quietMs: 20, maxLatencyMs: 60 };

function withDir(run: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-monitor-"));
    try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Monitor keeps startup-race messages, skips old history, and switches conversation inboxes", { timeout: 7000 }, withDir(async (dir) => {
  const first = join(dir, "first.jsonl");
  const second = join(dir, "second.jsonl");
  writeFileSync(first, `${entry("old history", 1)}\n${entry("arrived during startup", 10)}\n`);
  writeFileSync(second, `${entry("old resume history", 1)}\n${entry("new conversation", 20)}\n`);
  const signal = { aborted: false };
  let output = "";
  let reads = 0;
  const done = runInboxMonitor(() => (++reads === 1
    ? { path: first, startedAt: 10 }
    : { path: second, startedAt: 20 }), signal, { ...fast, write: (text) => { output += text; } });
  await until(() => /arrived during startup/.test(output) && /new conversation/.test(output));
  signal.aborted = true;
  await done;
  assert.doesNotMatch(output, /old history|old resume history/);
}));

test("Monitor combines a burst into one write", { timeout: 7000 }, withDir(async (dir) => {
  const inbox = join(dir, "inbox.jsonl");
  writeFileSync(inbox, "");
  const signal = { aborted: false };
  const writes: string[] = [];
  const done = runInboxMonitor(inbox, signal, { ...fast, quietMs: 80, maxLatencyMs: 1000, write: (text) => { writes.push(text); } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  appendFileSync(inbox, `${entry("one", 1)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  appendFileSync(inbox, `${entry("two", 2)}\n${entry("three", 3)}\n`);
  await until(() => writes.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 150));
  signal.aborted = true;
  await done;
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /^Intercom batch \(3 messages\)/);
  assert.match(writes[0]!, /\[1\/3\][^\n]*: one[\s\S]*\[2\/3\][^\n]*: two[\s\S]*\[3\/3\][^\n]*: three/);
}));

test("Monitor defers delivery while the host is busy and flushes at the idle boundary", { timeout: 7000 }, withDir(async (dir) => {
  const inbox = join(dir, "inbox.jsonl");
  writeFileSync(inbox, "");
  const signal = { aborted: false };
  let busy = true;
  let output = "";
  const done = runInboxMonitor(inbox, signal, { ...fast, isBusy: () => busy, write: (text) => { output += text; } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  appendFileSync(inbox, `${entry("while busy", 1)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(output, "");
  busy = false;
  await until(() => /while busy/.test(output));
  signal.aborted = true;
  await done;
}));

test("Monitor stops holding after maxHoldMs so a stale busy status cannot strand messages", { timeout: 7000 }, withDir(async (dir) => {
  const inbox = join(dir, "inbox.jsonl");
  writeFileSync(inbox, "");
  const signal = { aborted: false };
  let output = "";
  const done = runInboxMonitor(inbox, signal, { ...fast, maxHoldMs: 100, isBusy: () => true, write: (text) => { output += text; } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  appendFileSync(inbox, `${entry("stale busy", 1)}\n`);
  await until(() => /stale busy/.test(output));
  signal.aborted = true;
  await done;
}));

test("claudeHostBusyProbe reads only an explicit busy status from the native registry", withDir(async (dir) => {
  const probe = claudeHostBusyProbe(4242, dir);
  assert.equal(probe(), false); // missing record never blocks
  writeFileSync(join(dir, "4242.json"), JSON.stringify({ status: "busy" }));
  assert.equal(probe(), true);
  writeFileSync(join(dir, "4242.json"), JSON.stringify({ status: "waiting" }));
  assert.equal(probe(), false);
  writeFileSync(join(dir, "4242.json"), "{torn");
  assert.equal(probe(), false);
}));
