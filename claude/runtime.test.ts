import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  ClaudeIntercomRuntime,
  buildClaudeRuntimeIdentity,
  detectGitRoot,
  formatSessionDisplay,
  formatSessionList,
  resolveSessionTarget,
  selectPendingAsk,
  type PendingInboundMessage,
} from "./runtime.ts";
import type { IntercomClient } from "../broker/client.ts";
import type { SessionInfo } from "../types.ts";

class FakeIntercomClient extends EventEmitter {
  connected = false;
  connectCount = 0;
  acknowledgements: string[] = [];
  sessionId: string | null = null;

  isConnected(): boolean { return this.connected; }
  async connect(_registration: unknown, sessionId?: string): Promise<void> {
    this.connected = true;
    this.connectCount += 1;
    this.sessionId = sessionId ?? "fake-session";
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.sessionId = null;
  }
  acknowledgeMessage(deliveryId: string): void { this.acknowledgements.push(deliveryId); }
  drop(): void {
    this.connected = false;
    this.sessionId = null;
    this.emit("disconnected", new Error("broker restarted"));
  }
}

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: "session-a",
    name: "alpha",
    cwd: "/repo",
    model: "claude",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    status: "idle",
    ...overrides,
  };
}

test("buildClaudeRuntimeIdentity uses explicit environment overrides", () => {
  const identity = buildClaudeRuntimeIdentity({
    CLAUDE_INTERCOM_SESSION_ID: "claude-fixed",
    CLAUDE_INTERCOM_NAME: "planner",
    CLAUDE_INTERCOM_MODEL: "sonnet-test",
    PWD: "/tmp/repo",
  }, "/ignored", 123);

  assert.equal(identity.sessionId, "claude-fixed");
  assert.equal(identity.name, "planner");
  assert.equal(identity.cwd, "/ignored");
  assert.equal(identity.model, "sonnet-test");
});

test("buildClaudeRuntimeIdentity supports generic AGENT_INTERCOM_SESSION_ID and NAME", () => {
  const identity = buildClaudeRuntimeIdentity({
    AGENT_INTERCOM_SESSION_ID: "tmuxdeck-1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6",
    AGENT_INTERCOM_SESSION_NAME: "workspace · Claude 01",
    PWD: "/tmp/repo",
  }, "/ignored", 123);

  assert.equal(identity.sessionId, "tmuxdeck-1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6");
  assert.equal(identity.name, "workspace · Claude 01");
});

test("buildClaudeRuntimeIdentity prefers harness-specific ID/name over generic", () => {
  const identity = buildClaudeRuntimeIdentity({
    CLAUDE_INTERCOM_SESSION_ID: "claude-specific-id",
    CLAUDE_INTERCOM_NAME: "claude-specific-name",
    AGENT_INTERCOM_SESSION_ID: "invalid generic id with spaces",
    AGENT_INTERCOM_SESSION_NAME: "generic-name",
    PWD: "/tmp/repo",
  }, "/ignored", 123);

  assert.equal(identity.sessionId, "claude-specific-id");
  assert.equal(identity.name, "claude-specific-name");
});

test("buildClaudeRuntimeIdentity treats whitespace-only generic ID and name as absent", () => {
  for (const empty of ["", "   ", "\t\n"]) {
    const identity = buildClaudeRuntimeIdentity({
      AGENT_INTERCOM_SESSION_ID: empty,
      AGENT_INTERCOM_SESSION_NAME: empty,
      PWD: "/tmp/project",
    }, "/tmp/project", 42);

    assert.match(identity.sessionId, /^claude-42-[0-9a-f]{8}$/);
    assert.equal(identity.name, "claude-project-42");
  }
});

test("buildClaudeRuntimeIdentity fails closed on invalid non-empty generic AGENT_INTERCOM_SESSION_ID", () => {
  for (const invalid of ["bad session id with spaces", "bad$symbol!", "a".repeat(129)]) {
    assert.throws(
      () => buildClaudeRuntimeIdentity({ AGENT_INTERCOM_SESSION_ID: invalid }, "/tmp", 123),
      (err: any) => {
        assert.equal(err.message, "Invalid AGENT_INTERCOM_SESSION_ID: must match ^[A-Za-z0-9_-]{1,128}$");
        assert.equal(err.message.includes(invalid), false);
        return true;
      },
      `must reject invalid generic session ID: ${invalid}`,
    );
  }
});

test("buildClaudeRuntimeIdentity creates stable-ish fallback identity from cwd and pid", () => {
  const identity = buildClaudeRuntimeIdentity({ PWD: "/tmp/project" }, "/tmp/project", 42);

  assert.match(identity.sessionId, /^claude-42-[0-9a-f]{8}$/);
  assert.equal(identity.name, "claude-project-42");
});

test("resolveSessionTarget resolves exact id, name, and unique id prefix", () => {
  const sessions = [
    session({ id: "abc12345", name: "planner" }),
    session({ id: "def67890", name: "worker" }),
  ];

  assert.equal(resolveSessionTarget(sessions, "abc12345"), "abc12345");
  assert.equal(resolveSessionTarget(sessions, "worker"), "def67890");
  assert.equal(resolveSessionTarget(sessions, "def6"), "def67890");
});

test("resolveSessionTarget rejects duplicate names and ambiguous prefixes", () => {
  const sessions = [
    session({ id: "abc12345", name: "worker" }),
    session({ id: "abc19999", name: "worker" }),
  ];

  assert.throws(() => resolveSessionTarget(sessions, "worker"), /Multiple sessions named/);
  assert.throws(() => resolveSessionTarget(sessions, "abc1"), /Multiple sessions match/);
});

test("formatSessionList marks self and same cwd", () => {
  const output = formatSessionList([
    session({ id: "abc12345", name: "planner", cwd: "/repo", status: "idle" }),
  ], "abc12345", "/repo");

  assert.match(output, /planner \(abc12345\)/);
  assert.match(output, /\[self, same cwd, idle\]/);
});

test("remote session provenance is visible in model-facing labels", () => {
  const remote = session({ origin: "remote", remoteHostId: "ika-dev-v3" });
  assert.equal(formatSessionDisplay(remote), "alpha [remote:ika-dev-v3]");
  assert.match(formatSessionList([remote], null, "/other"), /alpha \[remote:ika-dev-v3\]/);
});

test("selectPendingAsk uses oldest/latest without exposing message IDs", () => {
  const from = session({ id: "sender-1", name: "sender" });
  const pending = (id: string, receivedAt: number): PendingInboundMessage => ({
    from,
    message: { id, timestamp: receivedAt, expectsReply: true, content: { text: id } },
    receivedAt,
    read: false,
  });
  const asks = [pending("ask-1", 10), pending("ask-2", 20)];

  assert.throws(() => selectPendingAsk(asks, "sender"), /specify `which`/);
  assert.equal(selectPendingAsk(asks, "sender", "oldest").message.id, "ask-1");
  assert.equal(selectPendingAsk(asks, "sender", "latest").message.id, "ask-2");
});

test("runtime reconnects automatically after the broker connection drops", async () => {
  const first = new FakeIntercomClient();
  const second = new FakeIntercomClient();
  const clients = [first, second];
  const runtime = new ClaudeIntercomRuntime({
    sessionId: "reconnect-claude",
    name: "reconnect-claude",
    cwd: process.cwd(),
    model: "test",
    startedAt: Date.now(),
  }, {
    clientFactory: () => clients.shift() as unknown as IntercomClient,
    prepareConnection: async () => {},
    reconnectDelays: [1],
  });

  await runtime.connect();
  first.drop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(second.connectCount, 1);
  assert.equal(second.sessionId, "reconnect-claude");
  await runtime.disconnect();
});

test("detectGitRoot finds the current repository root", () => {
  assert.equal(detectGitRoot(process.cwd()), process.cwd());
});
