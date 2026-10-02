import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Server } from "node:net";
import type { Message, SessionInfo } from "../types.ts";
import { NativeClaudeBrokerBridge } from "./native-bridge.ts";
import {
  bindNativeClaudeSocket,
  buildNativeEnvelope,
  buildNativeUserFrame,
  sendNativeFrame,
  nativePeerNameBySocket,
} from "./native-protocol.ts";

class FakeClient extends EventEmitter {
  sessionId: string | null = null;
  acknowledgements: string[] = [];
  sends: Array<{ to: string; message: { text: string; replyTo?: string } }> = [];
  statuses: string[] = [];
  names: string[] = [];

  async connect(_registration: unknown, sessionId?: string): Promise<void> { this.sessionId = sessionId ?? "bridge"; }
  async disconnect(): Promise<void> { this.sessionId = null; }
  acknowledgeMessage(id: string): void { this.acknowledgements.push(id); }
  updatePresence(update: { name?: string; status?: string }): void {
    if (update.status) this.statuses.push(update.status);
    if (update.name) this.names.push(update.name);
  }
  async send(to: string, message: { text: string; replyTo?: string }): Promise<{ delivered: boolean }> {
    this.sends.push({ to, message });
    this.emit("sent");
    return { delivered: true };
  }
}

const sender: SessionInfo = {
  id: "pi-manager",
  name: "Pi manager",
  cwd: "/workspace",
  model: "pi",
  pid: 10,
  startedAt: 1,
  lastActivity: 1,
};

const ask: Message = {
  id: "ask-1",
  timestamp: 1,
  expectsReply: true,
  content: { text: "Inspect the failing test" },
};

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("native bridge injects broker messages and correlates Claude replies", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-native-bridge-"));
  const registryDir = join(root, "sessions");
  const socketDir = join(root, "sockets");
  const targetSocket = join(socketDir, "claude.sock");
  const client = new FakeClient();
  let injected = "";
  let target: Server | undefined;
  const bridge = new NativeClaudeBrokerBridge(
    { id: "claude-worker", name: "Claude worker", cwd: "/workspace", pid: 910001 },
    {
      client: client as any,
      prepareConnection: async () => {},
      registryDir,
      socketDir,
      socketPath: join(socketDir, "bridge.sock"),
    },
  );

  try {
    target = await bindNativeClaudeSocket(targetSocket, (frame) => {
      const message = frame.message as { content?: string };
      injected = message.content ?? "";
      const from = typeof frame.from === "string" ? frame.from : "";
      if (!from.startsWith("uds:")) return;
      void sendNativeFrame(from.slice(4), buildNativeUserFrame({
        content: buildNativeEnvelope({ body: "The retry assertion is stale.", from: `uds:${targetSocket}` }),
        from: `uds:${targetSocket}`,
      }));
    });
    await bridge.start(targetSocket);
    await bridge.syncName("Renamed worker");
    await bridge.syncName("Renamed worker");
    await bridge.syncName(" ");
    assert.deepEqual(client.names, ["Renamed worker"]);
    assert.equal(client.sessionId, "claude-worker");
    assert.equal(nativePeerNameBySocket(bridge.nativeSocketPath, registryDir), "Renamed worker bridge");
    client.emit("message", sender, ask, "delivery-1");
    await once(client, "sent");

    assert.match(injected, /Intercom message from Pi manager/);
    assert.match(injected, /Inspect the failing test/);
    assert.match(injected, /built-in SendMessage tool/);
    assert.match(injected, /normal assistant response stays local/);
    assert.deepEqual(client.acknowledgements, ["delivery-1"]);
    assert.deepEqual(client.sends, [{
      to: sender.id,
      message: { text: "The retry assertion is stale.", replyTo: ask.id },
    }]);
    assert.deepEqual(client.statuses, ["active", "idle"]);
  } finally {
    await bridge.stop();
    if (target) await closeServer(target);
    await rm(root, { recursive: true, force: true });
  }
});

test("native replies require exact selectors across teams and retain the source team", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-native-teams-"));
  const client = new FakeClient();
  const bridge = new NativeClaudeBrokerBridge(
    { id: "claude-worker", name: "Claude worker", cwd: root, pid: 910003 },
    { client: client as any, prepareConnection: async () => {}, registryDir: join(root, "sessions"), socketDir: join(root, "sockets"), socketPath: join(root, "bridge.sock"), sendNative: async () => "native-delivery" },
  );
  try {
    await bridge.start(join(root, "unused.sock"));
    client.emit("message", sender, { ...ask, content: { ...ask.content, team: "alpha" } }, "delivery-alpha");
    client.emit("message", sender, { ...ask, id: "ask-2", content: { ...ask.content, team: "beta" } }, "delivery-beta");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = (body: string) => (bridge as any).handleNativeFrame(buildNativeUserFrame({ content: buildNativeEnvelope({ body }) }));
    reply("ambiguous answer");
    assert.equal(client.sends.length, 0);
    const sentBeta = once(client, "sent");
    reply("[intercom-context:ctx-ask-2] answer beta");
    await sentBeta;
    assert.deepEqual(client.sends[0], { to: sender.id, message: { text: "answer beta", replyTo: "ask-2", team: "beta" } });
    const sentAlpha = once(client, "sent");
    reply("[intercom-context:ctx-ask-1] answer alpha");
    await sentAlpha;
    assert.deepEqual(client.sends[1], { to: sender.id, message: { text: "answer alpha", replyTo: "ask-1", team: "alpha" } });
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("native bridge reports injection failure to a blocking asker", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-native-bridge-failure-"));
  const client = new FakeClient();
  const bridge = new NativeClaudeBrokerBridge(
    { id: "claude-worker", name: "Claude worker", cwd: "/workspace", pid: 910002 },
    {
      client: client as any,
      prepareConnection: async () => {},
      registryDir: join(root, "sessions"),
      socketDir: join(root, "sockets"),
      socketPath: join(root, "sockets", "bridge.sock"),
      sendNative: async () => { throw new Error("target socket closed"); },
    },
  );
  try {
    await bridge.start(join(root, "missing.sock"));
    client.emit("message", sender, ask, "delivery-2");
    await once(client, "sent");
    assert.deepEqual(client.acknowledgements, []);
    assert.deepEqual(client.sends, [{
      to: sender.id,
      message: { text: "Native Claude delivery failed: target socket closed", replyTo: ask.id },
    }]);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});
