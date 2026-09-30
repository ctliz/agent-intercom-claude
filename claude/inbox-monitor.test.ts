import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const entry = (text: string, ts: number) => JSON.stringify({ ts, text, fromId: "peer", messageId: text, expectsReply: false });

test("Monitor keeps startup-race messages, skips old history, and switches conversation inboxes", { timeout: 7000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-monitor-"));
  const first = join(dir, "first.jsonl");
  const second = join(dir, "second.jsonl");
  writeFileSync(first, `${entry("old history", 1)}\n${entry("arrived during startup", 10)}\n`);
  writeFileSync(second, `${entry("old resume history", 1)}\n${entry("new conversation", 20)}\n`);
  const code = `
    import { runInboxMonitor } from './claude/inbox-monitor.ts';
    const signal = { aborted: false };
    const write = process.stdout.write.bind(process.stdout);
    let emitted = 0;
    process.stdout.write = (text) => { write(text); if (++emitted === 2) signal.aborted = true; return true; };
    let reads = 0;
    await runInboxMonitor(() => (++reads === 1 ?
      { path: ${JSON.stringify(first)}, startedAt: 10 } :
      { path: ${JSON.stringify(second)}, startedAt: 20 }), signal);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: root });
  let output = "";
  let errors = "";
  child.stdout!.on("data", (data) => { output += data; });
  child.stderr!.on("data", (data) => { errors += data; });
  try {
    const [exit] = await once(child, "exit");
    assert.equal(exit, 0, errors);
    assert.match(output, /arrived during startup/);
    assert.match(output, /new conversation/);
    assert.doesNotMatch(output, /old history|old resume history/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});
