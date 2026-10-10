import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { IntercomClient } from "../broker/client.ts";

test("channel stdio delivers startup mail, drains with existing tools, and routes a correlated reply", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-channel-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const env = { ...process.env, CLAUDE_INTERCOM_CHANNEL: "1", CLAUDE_INTERCOM_SESSION_ID: "channel-receiver", CLAUDE_INTERCOM_NAME: "channel-receiver" };
  const broker = spawn(process.execPath, ["dist/broker.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let brokerLog = "";
  broker.stdout.on("data", (chunk) => { brokerLog += chunk; });
  const server = spawn(process.execPath, ["dist/claude-server.mjs"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const output: any[] = [];
  createInterface({ input: server.stdout }).on("line", (line) => output.push(JSON.parse(line)));
  const peer = new IntercomClient();
  const waitFor = async <T>(read: () => T | undefined): Promise<T> => {
    for (let i = 0; i < 100; i++) {
      const value = read();
      if (value !== undefined) return value;
      await delay(50);
    }
    throw new Error("Channel pipeline timed out");
  };
  const call = async (id: number, method: string, params?: unknown) => {
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return waitFor(() => output.find((entry) => entry.id === id));
  };
  try {
    await waitFor(() => brokerLog.includes("broker started") ? true : undefined);
    await peer.connect({ name: "channel-peer", cwd: dir, model: "test", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() }, "channel-peer");
    for (let i = 0; i < 100; i++) {
      if ((await peer.listSessions()).some((session) => session.id === "channel-receiver")) break;
      await delay(50);
    }
    const init = await call(1, "initialize");
    assert.deepEqual(init.result.capabilities.experimental, { "claude/channel": {} });
    const delivery = await peer.send("channel-receiver", { messageId: "channel-ask", text: "Pipeline test", expectsReply: true });
    assert.equal(delivery.delivered, true);
    await delay(550);
    assert.equal(output.filter((entry) => entry.method === "notifications/claude/channel").length, 0);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await waitFor(() => output.find((entry) => entry.method === "notifications/claude/channel"));
    await delay(550);
    assert.equal(output.filter((entry) => entry.method === "notifications/claude/channel").length, 1);
    assert.ok(!JSON.stringify(output).includes("Pipeline test"));
    const pending = await call(2, "tools/call", { name: "intercom_pending", arguments: { mark_read: true } });
    const entry = pending.result.structuredContent.unread_messages[0];
    assert.equal(entry.text, "Pipeline test");
    peer.on("message", (_from, _message, id) => peer.acknowledgeMessage(id));
    const received = once(peer, "message");
    const replied = await call(3, "tools/call", { name: "intercom_reply", arguments: { contextId: entry.contextId, message: "CHANNEL_OK" } });
    assert.ok(!replied.result.isError, JSON.stringify(replied));
    const [, message] = await received;
    assert.equal(message.content.text, "CHANNEL_OK");
    assert.equal(message.replyTo, "channel-ask");
    assert.equal((await peer.listSessions()).filter((session) => session.id === "channel-receiver").length, 1);
  } finally {
    await peer.disconnect();
    const stopped = [server, broker].map(async (child) => {
      if (child.exitCode !== null) return;
      const closed = once(child, "close");
      child.kill();
      await closed;
    });
    await Promise.all(stopped);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
