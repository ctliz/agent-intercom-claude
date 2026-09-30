import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IntercomClient } from "../broker/client.ts";

const root = resolve(import.meta.dirname, "..");
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await delay(50);
  }
  throw new Error("Timed out waiting for MCP registration");
}

test("plain MCP registers and ACKs before any prompt/tool; duplicate stays offline", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-mcp-eager-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const env = {
    ...process.env, PI_CODING_AGENT_DIR: dir, AGENT_INTERCOM_SCOPE_ID: "",
    CLAUDE_INTERCOM_SESSION_ID: "eager-claude", CLAUDE_INTERCOM_NAME: "eager-reviewer",
    CLAUDE_INTERCOM_INBOX: "",
  };
  const children: ChildProcess[] = [];
  let probe: IntercomClient | undefined;
  try {
    const broker = spawn(process.execPath, ["--import", "tsx", "broker/broker.ts"], { cwd: root, env });
    children.push(broker);
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error("Broker startup timed out")), 5000);
      broker.stdout!.on("data", (data) => {
        if (String(data).includes("Intercom broker started")) { clearTimeout(timer); ready(); }
      });
      broker.once("exit", () => { clearTimeout(timer); reject(new Error("Broker exited early")); });
    });
    probe = new IntercomClient({ env: {} });
    probe.on("error", () => {});
    await probe.connect({ name: "probe", cwd: root, model: "test", pid: process.pid,
      startedAt: Date.now(), lastActivity: Date.now() }, "eager-probe");
    const owner = spawn(process.execPath, ["dist/claude-server.mjs"], { cwd: root, env });
    children.push(owner);
    const sessions = await until(() => probe!.listSessions(), (list) => list.some((s) => s.id === "eager-claude"));
    assert.equal(sessions.find((s) => s.id === "eager-claude")?.name, "eager-reviewer");
    // No MCP initialize or tools/call has been sent to the owner's stdin.
    const ack = await probe.send("eager-claude", { text: "before first prompt" });
    assert.equal(ack.delivered, true);
    const inbox = readFileSync(join(dir, "intercom", "inbox-eager-claude.jsonl"), "utf8");
    assert.match(inbox, /before first prompt/);

    const contender = spawn(process.execPath, ["dist/claude-server.mjs"], {
      cwd: root, env: { ...env, CLAUDE_INTERCOM_NAME: "contender" },
    });
    children.push(contender);
    let errors = "";
    contender.stderr!.on("data", (data) => { errors += data; });
    await until(async () => errors, (value) => /another local runtime/.test(value));
    const response = new Promise<Record<string, any>>((ready, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("MCP status timed out")), 3000);
      contender.stdout!.on("data", (data) => {
        output += data;
        if (output.includes("\n")) { clearTimeout(timer); ready(JSON.parse(output.split("\n")[0]!)); }
      });
    });
    contender.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "intercom_status", arguments: {} } })}\n`);
    const result = (await response).result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.registration_conflict.code, "SESSION_ID_IN_USE");
    assert.equal(result.structuredContent.reconnect_paused, true);
    assert.equal((await probe.listSessions()).find((s) => s.id === "eager-claude")?.name, "eager-reviewer");
    assert.equal((await probe.send("eager-claude", { text: "incumbent still receives" })).delivered, true);
  } finally {
    await probe?.disconnect();
    for (const child of children.reverse()) await stop(child);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
