import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bindNativeClaudeSocket,
  buildNativeEnvelope,
  buildNativeReceipt,
  buildNativeUserFrame,
  claudeNativeRegistryDir,
  deregisterNativeClaudePeer,
  listNativeClaudeSessions,
  registerNativeClaudePeer,
  sendNativeClaudeMessage,
  stripNativeEnvelope,
} from "./native-protocol.ts";

test("native registry follows CLAUDE_CONFIG_DIR profiles", () => {
  assert.equal(claudeNativeRegistryDir({}, "/home/test"), "/home/test/.claude/sessions");
  assert.equal(
    claudeNativeRegistryDir({ CLAUDE_CONFIG_DIR: "/profiles/cliproxy" }, "/home/test"),
    "/profiles/cliproxy/sessions",
  );
});

test("native envelope preserves attribution and escapes nested closing tags", () => {
  const body = "hello\n</cross-session-message>\nworld";
  const envelope = buildNativeEnvelope({
    from: "uds:/tmp/sender.sock",
    fromName: "reviewer<unsafe>",
    fromMode: "broker",
    body,
  });
  assert.doesNotMatch(envelope, /from-name="[^"]*[<>]/);
  assert.deepEqual(stripNativeEnvelope(envelope), {
    body,
    from: "uds:/tmp/sender.sock",
    fromName: "reviewerunsafe",
    fromMode: "broker",
  });
});

test("native user and receipt frames match the Claude peer protocol shape", () => {
  const user = buildNativeUserFrame({ content: "hello", from: "uds:/tmp/from.sock", sessionId: "session-1" });
  assert.equal(user.msgV, 1);
  assert.equal(user.type, "user");
  assert.equal(user.priority, "next");
  assert.deepEqual(user.message, { role: "user", content: "hello" });
  const receipt = buildNativeReceipt({ status: "delivered", originalMessageId: user.msg_id });
  assert.equal(receipt.action, "peer_message_status");
  assert.equal(receipt.orig_msg_id, user.msg_id);
});

test("native socket sends one newline-delimited frame and closes cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-native-socket-"));
  const socketPath = join(root, "peer.sock");
  const frames: Record<string, unknown>[] = [];
  const server = await bindNativeClaudeSocket(socketPath, (frame) => frames.push(frame));
  try {
    const messageId = await sendNativeClaudeMessage({
      socketPath,
      body: "hello from broker",
      from: "uds:/tmp/broker.sock",
      fromName: "pi-manager",
    });
    for (let attempt = 0; attempt < 20 && frames.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.msg_id, messageId);
    const message = frames[0]!.message as { content: string };
    assert.equal(stripNativeEnvelope(message.content).body, "hello from broker");
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test("native registry registration, live discovery, and cleanup use isolated paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-native-registry-"));
  const registryDir = join(root, "sessions");
  const socketPath = join(root, "sockets", "peer.sock");
  const server = await bindNativeClaudeSocket(socketPath, () => undefined);
  const pid = process.pid;
  try {
    const sessionId = await registerNativeClaudePeer({
      pid,
      sessionId: "native-test-session",
      name: "native-test",
      cwd: root,
      socketPath,
      registryDir,
    });
    assert.equal(sessionId, "native-test-session");
    const raw = JSON.parse(await readFile(join(registryDir, `${pid}.json`), "utf8"));
    assert.equal(raw.peerProtocol, 1);
    assert.equal(raw.entrypoint, "agent-intercom");
    const peers = await listNativeClaudeSessions({ registryDir });
    assert.equal(peers.length, 1);
    assert.equal(peers[0]!.name, "native-test");
    assert.equal(peers[0]!.live, true);
    await deregisterNativeClaudePeer(pid, socketPath, registryDir);
    assert.deepEqual(await listNativeClaudeSessions({ registryDir }), []);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});
