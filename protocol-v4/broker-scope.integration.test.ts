import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { IntercomClient } from "../broker/client.ts";
import { createMessageReader, writeMessage } from "../broker/framing.ts";
import {
  INTERCOM_PROTOCOL_V4_SEMANTICS_HASH,
  INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION,
  parseIntercomScopeId,
} from "./contract.ts";

const root = process.cwd();
const scopeA = "Scope_AAAAAAAAAA";
const scopeB = "Scope_BBBBBBBBBB";
const scopeLeakPattern = /Scope_|AGENT_INTERCOM_SCOPE_ID|scopeId|scope id|invalid-scope|Scope\.AAAAAAAAAA|éAAAAAAAAAAAAAAA|\^\[A-Za-z0-9_-\]\{16,128\}\$|registrationMetadata/i;

function registration(name: string, pid: number) {
  return { name, cwd: root, model: "v4-test", pid, startedAt: pid, lastActivity: Date.now() };
}

async function waitReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(child.stderr?.read()?.toString() || "broker startup timeout")),
      5000,
    );
    child.stdout?.on("data", (chunk) => {
      if (chunk.toString().includes("Intercom broker started")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`broker exited ${code}: ${child.stderr?.read()?.toString() ?? ""}`));
    });
  });
}

async function connect(name: string, id: string, scopeId?: string): Promise<IntercomClient> {
  const client = new IntercomClient(scopeId === undefined ? { env: {} } : { scopeId });
  client.on("message", (_from, _message, deliveryId) => client.acknowledgeMessage(deliveryId));
  await client.connect(registration(name, Math.floor(Math.random() * 1_000_000) + 1), id);
  return client;
}

async function close(...clients: IntercomClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.disconnect().catch(() => undefined)));
}

class RawPeer {
  readonly messages: any[] = [];
  constructor(readonly socket: net.Socket) {
    socket.on(
      "data",
      createMessageReader(
        (message) => this.messages.push(message),
        (error) => socket.destroy(error),
      ),
    );
  }
  send(message: unknown): void {
    writeMessage(this.socket, message);
  }
  async waitFor(predicate: (message: any) => boolean, timeoutMs = 2000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out; received ${JSON.stringify(this.messages)}`);
  }
}

async function rawConnect(socketPath: string): Promise<RawPeer> {
  const socket = net.connect(socketPath);
  await once(socket, "connect");
  return new RawPeer(socket);
}

function rawRegistration(name: string, id: string, scopeId?: string, runtimeInstanceId = `runtime-${name}`) {
  return {
    type: "register",
    protocol: "pi-intercom",
    version: 4,
    sessionId: id,
    ...(scopeId === undefined ? {} : { scopeId }),
    session: { ...registration(name, 101), runtimeInstanceId },
  };
}

function rawRemoteRegistration(name: string, id: string, access: unknown, scopeId?: string) {
  return {
    type: "register",
    protocol: "pi-intercom",
    version: 4,
    sessionId: id,
    access,
    ...(scopeId === undefined ? {} : { scopeId }),
    session: registration(name, 101),
  };
}

async function assertNoEvent(peer: RawPeer, predicate: (message: any) => boolean, timeoutMs = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  assert.equal(peer.messages.some(predicate), false);
}

function assertNoScopeLeak(value: unknown): void {
  assert.doesNotMatch(JSON.stringify(value), scopeLeakPattern);
}

function assertNoScopeLeakInPeers(...peers: RawPeer[]): void {
  for (const peer of peers) assertNoScopeLeak(peer.messages);
}

function scanPersistedFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(filePath)) scanPersistedFile(join(filePath, entry));
    return;
  }
  assertNoScopeLeak(readFileSync(filePath, "utf8"));
}

function assertNoTextInPath(path: string, forbidden: readonly string[]): void {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) assertNoTextInPath(join(path, entry), forbidden);
    return;
  }
  const content = readFileSync(path, "utf8");
  for (const token of forbidden) assert.equal(content.includes(token), false);
}

function assertNoPersistedText(home: string, forbidden: readonly string[]): void {
  for (const file of ["broker-audit.jsonl", "broker-asks.json", "broker-access.json", "outbox"]) {
    assertNoTextInPath(join(home, "agent", "intercom", file), forbidden);
  }
}

async function withBroker(run: (socketPath: string, home: string, remoteSocketPath: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "piv4-claude-"));
  const agentDir = join(home, "agent");
  const broker = spawn(process.execPath, ["--import", "tsx", "broker/broker.ts"], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let brokerStdout = "";
  let brokerStderr = "";
  broker.stdout?.on("data", (chunk) => { brokerStdout += chunk.toString(); });
  broker.stderr?.on("data", (chunk) => { brokerStderr += chunk.toString(); });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await waitReady(broker);
    await run(join(agentDir, "intercom", "broker.sock"), home, join(agentDir, "intercom", "remote-gateway.sock"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
    assertNoScopeLeak(brokerStdout);
    assertNoScopeLeak(brokerStderr);
    for (const file of [
      "broker-audit.jsonl",
      "broker-asks.json",
      "broker-access.json",
      "outbox",
    ]) {
      scanPersistedFile(join(agentDir, "intercom", file));
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("Core vector identity and invalid scope classes are pinned", () => {
  assert.equal(INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION, 2);
  assert.equal(
    INTERCOM_PROTOCOL_V4_SEMANTICS_HASH,
    "ef23cae55b3cca7683fee60e5f2421350cde731dc5424c82286a33a8b9cdf6cb",
  );
  for (const invalid of ["short", ` ${scopeA}`, `${scopeA} `, "Scope.AAAAAAAAAA", "éAAAAAAAAAAAAAAA", "A".repeat(129)]) {
    assert.throws(() => parseIntercomScopeId(invalid), /must match/);
  }
});

test("invalid registration metadata and v3 client mismatch fail without private metadata leakage", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const invalidInputs: unknown[] = [
      "short",
      ` ${scopeA}`,
      `${scopeA} `,
      "Scope.AAAAAAAAAA",
      "éAAAAAAAAAAAAAAA",
      "A".repeat(129),
      42,
    ];
    for (let index = 0; index < invalidInputs.length; index += 1) {
      const peer = await rawConnect(socketPath);
      const request = rawRegistration(`invalid-${index}`, `invalid-${index}`, undefined, `runtime-invalid-${index}`) as Record<string, unknown>;
      request.scopeId = invalidInputs[index];
      peer.send(request);
      const error = await peer.waitFor((m) => m.type === "error");
      assert.equal(error.code, "INVALID_REQUEST");
      assert.equal(error.error, "Registration metadata is invalid");
      assertNoScopeLeakInPeers(peer);
      peer.socket.destroy();
    }

    const v3 = await rawConnect(socketPath);
    v3.send({
      ...rawRegistration("v3-client", "v3-client"),
      version: 3,
      scopeId: scopeA,
    });
    const mismatch = await v3.waitFor((m) => m.type === "error");
    assert.equal(mismatch.code, "PROTOCOL_MISMATCH");
    assertNoScopeLeakInPeers(v3);
    v3.socket.destroy();
  });
});

test("v4 broker partitions A/B/unscoped and exact IDs cross scopes", { timeout: 20_000 }, async () => {
  await withBroker(async () => {
    const a1 = await connect("alpha", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", scopeA);
    const a2 = await connect("worker", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", scopeA);
    const b1 = await connect("worker", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", scopeB);
    const u1 = await connect("unscoped-one", "11111111-1111-4111-8111-111111111111");
    const u2 = await connect("unscoped-two", "22222222-2222-4222-8222-222222222222");
    assert.deepEqual(
      (await a1.listSessions()).map((s) => s.id).sort(),
      [a1.sessionId, a2.sessionId].sort(),
    );
    assert.deepEqual(
      (await b1.listSessions()).map((s) => s.id),
      [b1.sessionId],
    );
    assert.deepEqual(
      (await u1.listSessions()).map((s) => s.id).sort(),
      [u1.sessionId, u2.sessionId].sort(),
    );
    assert.equal((await a1.send(b1.sessionId!, { text: "exact cross scope" })).delivered, true);
    assert.equal((await a1.send("worker", { text: "same scope name" })).delivered, true);
    assert.equal((await a1.send("bbbbbb", { text: "hidden prefix" })).code, "SESSION_NOT_FOUND");
    assert.equal((await a1.send("unscoped-one", { text: "hidden unscoped" })).code, "SESSION_NOT_FOUND");
    assert.equal((await u1.send(a1.sessionId!, { text: "unscoped exact" })).delivered, true);
    for (const session of await a1.listSessions()) {
      assert.equal(Object.hasOwn(session as object, "scopeId"), false);
    }
    await close(a1, a2, b1, u1, u2);
  });
});

test("exact-ID cross-scope ask cancel, timeout, and late reply stay threaded without leaks", { timeout: 20_000 }, async () => {
  const previousTimeout = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "50";
  try {
    await withBroker(async (socketPath) => {
      const asker = await rawConnect(socketPath);
      const askerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21";
      asker.send(rawRegistration("asker", askerId, scopeA));
      await asker.waitFor((m) => m.type === "registered");
      const answerer = await rawConnect(socketPath);
      const answererId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb21";
      answerer.send(rawRegistration("answerer", answererId, scopeB));
      await answerer.waitFor((m) => m.type === "registered");

      asker.send({
        type: "send",
        to: answererId,
        message: { id: "ask-cancel", timestamp: Date.now(), expectsReply: true, content: { text: "cancel me" } },
      });
      await asker.waitFor((m) => m.type === "delivery_accepted" && m.messageId === "ask-cancel");
      const askMessage = await answerer.waitFor((m) => m.type === "message" && m.message.id === "ask-cancel");
      answerer.send({ type: "message_received", deliveryId: askMessage.deliveryId });
      await asker.waitFor((m) => m.type === "delivered" && m.messageId === "ask-cancel");
      asker.send({ type: "cancel_ask", requestId: "cancel-1", messageId: "ask-cancel" });
      const cancelResult = await asker.waitFor((m) => m.type === "ask_control_result" && m.requestId === "cancel-1");
      assert.equal(cancelResult.applied, true);
      await answerer.waitFor((m) => m.type === "ask_cancelled" && m.messageId === "ask-cancel" && m.fromSessionId === askerId && m.reason === "cancelled");
      answerer.send({
        type: "send",
        to: askerId,
        message: { id: "late-reply", timestamp: Date.now(), replyTo: "ask-cancel", content: { text: "too late" } },
      });
      const lateFailure = await answerer.waitFor((m) => m.type === "delivery_failed" && m.messageId === "late-reply");
      assert.equal(lateFailure.code, "INVALID_REPLY_TARGET");
      assertNoScopeLeak(lateFailure);

      asker.send({
        type: "send",
        to: answererId,
        message: { id: "ask-timeout", timestamp: Date.now(), expectsReply: true, content: { text: "expire me" } },
      });
      await asker.waitFor((m) => m.type === "delivery_accepted" && m.messageId === "ask-timeout");
      const timeoutMessage = await answerer.waitFor((m) => m.type === "message" && m.message.id === "ask-timeout");
      answerer.send({ type: "message_received", deliveryId: timeoutMessage.deliveryId });
      await asker.waitFor((m) => m.type === "delivered" && m.messageId === "ask-timeout");
      await answerer.waitFor((m) => m.type === "ask_cancelled" && m.messageId === "ask-timeout" && m.reason === "expired", 2000);
      for (const frame of [...asker.messages, ...answerer.messages]) assertNoScopeLeak(frame);
      asker.socket.destroy(); answerer.socket.destroy();
    });
  } finally {
    if (previousTimeout === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
    else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = previousTimeout;
  }
});

test("v4 lifecycle audiences are partitioned across A/B/unscoped for join, left, and presence", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const observerA = await rawConnect(socketPath);
    observerA.send(rawRegistration("observer-a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11", scopeA));
    await observerA.waitFor((m) => m.type === "registered");
    const observerB = await rawConnect(socketPath);
    observerB.send(rawRegistration("observer-b", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb11", scopeB));
    await observerB.waitFor((m) => m.type === "registered");
    const observerU = await rawConnect(socketPath);
    observerU.send(rawRegistration("observer-u", "11111111-1111-4111-8111-111111111110"));
    await observerU.waitFor((m) => m.type === "registered");
    observerA.messages.splice(0); observerB.messages.splice(0); observerU.messages.splice(0);

    const subjectA = await rawConnect(socketPath);
    const subjectAId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12";
    subjectA.send(rawRegistration("subject-a", subjectAId, scopeA));
    await subjectA.waitFor((m) => m.type === "registered");
    await observerA.waitFor((m) => m.type === "session_joined" && m.session.id === subjectAId);
    await assertNoEvent(observerB, (m) => m.type === "session_joined" && m.session?.id === subjectAId);
    await assertNoEvent(observerU, (m) => m.type === "session_joined" && m.session?.id === subjectAId);
    subjectA.send({ type: "presence", name: "subject-a-updated" });
    await observerA.waitFor((m) => m.type === "presence_update" && m.session.id === subjectAId && m.session.name === "subject-a-updated");
    await assertNoEvent(observerB, (m) => m.type === "presence_update" && m.session?.id === subjectAId);
    await assertNoEvent(observerU, (m) => m.type === "presence_update" && m.session?.id === subjectAId);
    subjectA.send({ type: "unregister" });
    await observerA.waitFor((m) => m.type === "session_left" && m.sessionId === subjectAId);
    await assertNoEvent(observerB, (m) => m.type === "session_left" && m.sessionId === subjectAId);
    await assertNoEvent(observerU, (m) => m.type === "session_left" && m.sessionId === subjectAId);

    const subjectB = await rawConnect(socketPath);
    const subjectBId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb12";
    subjectB.send(rawRegistration("subject-b", subjectBId, scopeB));
    await subjectB.waitFor((m) => m.type === "registered");
    await observerB.waitFor((m) => m.type === "session_joined" && m.session.id === subjectBId);
    await assertNoEvent(observerA, (m) => m.type === "session_joined" && m.session?.id === subjectBId);
    await assertNoEvent(observerU, (m) => m.type === "session_joined" && m.session?.id === subjectBId);

    const subjectU = await rawConnect(socketPath);
    const subjectUId = "22222222-2222-4222-8222-222222222220";
    subjectU.send(rawRegistration("subject-u", subjectUId));
    await subjectU.waitFor((m) => m.type === "registered");
    await observerU.waitFor((m) => m.type === "session_joined" && m.session.id === subjectUId);
    await assertNoEvent(observerA, (m) => m.type === "session_joined" && m.session?.id === subjectUId);
    await assertNoEvent(observerB, (m) => m.type === "session_joined" && m.session?.id === subjectUId);

    assertNoScopeLeakInPeers(observerA, observerB, observerU, subjectA, subjectB, subjectU);
    observerA.socket.destroy(); observerB.socket.destroy(); observerU.socket.destroy();
    subjectA.socket.destroy(); subjectB.socket.destroy(); subjectU.socket.destroy();
  });
});

test("remote registration scope intersects with remote authorization and never widens visibility", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath, home, remoteSocketPath) => {
    const root = await rawConnect(socketPath);
    root.send(rawRegistration("root-a", "root-a", scopeA));
    await root.waitFor((m) => m.type === "registered");
    const sameScopeB = await rawConnect(socketPath);
    sameScopeB.send(rawRegistration("local-b", "local-b", scopeB));
    await sameScopeB.waitFor((m) => m.type === "registered");
    const adminToken = JSON.parse(readFileSync(join(home, "agent", "intercom", "broker-admin.json"), "utf8")).adminToken;
    const control = await rawConnect(socketPath);
    control.send({
      type: "access_control",
      requestId: "enroll-remote",
      adminToken,
      action: "issue_enrollment",
      enrollment: {
        name: "remote-b",
        parentSessionId: "root-a",
        rootSessionId: "root-a",
        remoteHostId: "remote-host",
      },
    });
    const enrollment = await control.waitFor((m) => m.type === "access_control_result" && m.action === "issue_enrollment");
    const remote = await rawConnect(remoteSocketPath);
    remote.send(rawRemoteRegistration("ignored-remote-name", "attacker-picked-id", { enrollmentToken: enrollment.enrollmentToken }, scopeB));
    const registered = await remote.waitFor((m) => m.type === "registered");
    assert.equal(registered.access.parentSessionId, "root-a");

    root.send({ type: "list", requestId: "root-list" });
    const rootList = await root.waitFor((m) => m.type === "sessions" && m.requestId === "root-list");
    assert.deepEqual(rootList.sessions.map((session: any) => session.id), ["root-a"]);

    remote.send({ type: "list", requestId: "remote-list" });
    const remoteList = await remote.waitFor((m) => m.type === "sessions" && m.requestId === "remote-list");
    assert.deepEqual(remoteList.sessions.map((session: any) => session.id), [registered.sessionId]);
    assert.equal(remoteList.sessions.some((session: any) => session.id === "local-b"), false);
    assert.equal(remoteList.sessions.some((session: any) => session.id === "root-a"), false);
    assertNoScopeLeakInPeers(root, sameScopeB, control, remote);

    root.socket.destroy(); sameScopeB.socket.destroy(); control.socket.destroy(); remote.socket.destroy();
  });
});

test("remote invalid protocol, scope, or session metadata does not consume enrollment tokens", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath, home, remoteSocketPath) => {
    const rootPeer = await rawConnect(socketPath);
    rootPeer.send(rawRegistration("root", "root-main-test", scopeA));
    await rootPeer.waitFor((m) => m.type === "registered");
    const adminToken = JSON.parse(readFileSync(join(home, "agent", "intercom", "broker-admin.json"), "utf8")).adminToken;
    async function issueEnrollment(name: string): Promise<string> {
      const control = await rawConnect(socketPath);
      control.send({
        type: "access_control",
        requestId: `enroll-${name}`,
        adminToken,
        action: "issue_enrollment",
        enrollment: {
          name,
          parentSessionId: "root-main-test",
          rootSessionId: "root-main-test",
          remoteHostId: "host-main",
        },
      });
      const issued = await control.waitFor((m) => m.type === "access_control_result" && m.action === "issue_enrollment");
      control.socket.destroy();
      return issued.enrollmentToken;
    }

    async function attemptInvalid(token: string, patch: (request: Record<string, unknown>) => void): Promise<void> {
      const peer = await rawConnect(remoteSocketPath);
      const request = rawRemoteRegistration("remote", "attacker", { enrollmentToken: token }, scopeA) as Record<string, unknown>;
      patch(request);
      peer.send(request);
      const error = await peer.waitFor((m) => m.type === "error");
      assertNoScopeLeakInPeers(peer);
      assert.equal(error.type, "error");
      peer.socket.destroy();
    }

    async function validOnce(token: string, name: string): Promise<RawPeer> {
      const peer = await rawConnect(remoteSocketPath);
      peer.send(rawRemoteRegistration(name, `ignored-${name}`, { enrollmentToken: token }, scopeA));
      const registered = await peer.waitFor((m) => m.type === "registered");
      assert.equal(registered.access.parentSessionId, "root-main-test");
      assertNoScopeLeakInPeers(peer);
      return peer;
    }

    const protocolToken = await issueEnrollment("remote-protocol");
    await attemptInvalid(protocolToken, (request) => { request.version = 3; });
    const protocolValid = await validOnce(protocolToken, "remote-protocol-valid");

    const scopeToken = await issueEnrollment("remote-metadata");
    await attemptInvalid(scopeToken, (request) => { request.scopeId = " invalid-scope"; });
    const scopeValid = await validOnce(scopeToken, "remote-metadata-valid");

    const sessionToken = await issueEnrollment("remote-session");
    await attemptInvalid(sessionToken, (request) => { (request.session as Record<string, unknown>).cwd = ""; });
    const sessionValid = await validOnce(sessionToken, "remote-session-valid");

    const reuse = await rawConnect(remoteSocketPath);
    reuse.send(rawRemoteRegistration("reuse", "ignored-reuse", { enrollmentToken: sessionToken }, scopeA));
    const reuseError = await reuse.waitFor((m) => m.type === "error");
    assert.equal(reuseError.code, "ACCESS_DENIED");
    assertNoScopeLeakInPeers(reuse);

    assertNoPersistedText(home, [protocolToken, scopeToken, sessionToken, " invalid-scope"]);
    rootPeer.socket.destroy(); protocolValid.socket.destroy(); scopeValid.socket.destroy(); sessionValid.socket.destroy(); reuse.socket.destroy();
  });
});

test(
  "v4 automatic spawn fails closed against an incompatible broker without terminating or forking",
  { timeout: 20_000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "piv3-claude-"));
    const agentDir = join(home, "agent");
    const serverScript = join(home, "v3-broker.mjs");
    const script = `import net from "node:net"; import {mkdirSync,unlinkSync,writeFileSync} from "node:fs"; import {join} from "node:path"; const dir=${JSON.stringify(join(agentDir, "intercom"))}; mkdirSync(dir,{recursive:true}); const path=join(dir,"broker.sock"); try{unlinkSync(path)}catch{}; const server=net.createServer((socket)=>{let buffer=Buffer.alloc(0);socket.on("data",(data)=>{buffer=Buffer.concat([buffer,data]);if(buffer.length<4)return;const length=buffer.readUInt32BE(0);if(buffer.length<4+length)return;const request=JSON.parse(buffer.subarray(4,4+length));const response={type:"health_ok",requestId:request.requestId,protocol:"pi-intercom",version:3,endpoint:"local"};const payload=Buffer.from(JSON.stringify(response));const header=Buffer.alloc(4);header.writeUInt32BE(payload.length);socket.end(Buffer.concat([header,payload]));});});server.listen(path,()=>writeFileSync(join(dir,"broker.pid"),String(process.pid)));process.on("SIGTERM",()=>server.close(()=>process.exit(0)));`;
    await import("node:fs/promises").then(({ writeFile }) => writeFile(serverScript, script));
    const broker = spawn(process.execPath, [serverScript], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const pidPath = join(agentDir, "intercom", "broker.pid");
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          readFileSync(pidPath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const { spawnBrokerIfNeeded } = await import(`../broker/spawn.ts?mismatch=${Date.now()}`);
      await assert.rejects(spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]), /Incompatible live intercom broker/);
      assert.equal(broker.exitCode, null);
      assert.equal(Number(readFileSync(pidPath, "utf8")), broker.pid);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      broker.kill("SIGTERM");
      await once(broker, "exit").catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "replacement orders old left before new joined and stale socket frames are discarded",
  { timeout: 20_000 },
  async () => {
    await withBroker(async (socketPath) => {
      const observerA = await rawConnect(socketPath);
      observerA.send(rawRegistration("observer-a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10", scopeA));
      await observerA.waitFor((m) => m.type === "registered");
      const observerB = await rawConnect(socketPath);
      observerB.send(rawRegistration("observer-b", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb10", scopeB));
      await observerB.waitFor((m) => m.type === "registered");
      const oldPeer = await rawConnect(socketPath);
      const stableId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      oldPeer.send(rawRegistration("replace-me", stableId, scopeA, "same-runtime"));
      await oldPeer.waitFor((m) => m.type === "registered");
      await observerA.waitFor((m) => m.type === "session_joined" && m.session.id === stableId);
      const newPeer = await rawConnect(socketPath);
      newPeer.send(rawRegistration("replace-me", stableId, scopeB, "same-runtime"));
      await newPeer.waitFor((m) => m.type === "registered");
      await observerA.waitFor((m) => m.type === "session_left" && m.sessionId === stableId);
      await observerB.waitFor((m) => m.type === "session_joined" && m.session.id === stableId);
      const aEvents = observerA.messages
        .filter((m) => m.sessionId === stableId || m.session?.id === stableId)
        .map((m) => m.type);
      assert.deepEqual(aEvents, ["session_joined", "session_left"]);
      assert.equal(
        observerB.messages.some((m) => m.type === "session_left" && m.sessionId === stableId),
        false,
      );
      oldPeer.send({ type: "defer_ask", requestId: "stale-control", messageId: "stale-ask" });
      oldPeer.send({ type: "presence", name: "stale-name" });
      oldPeer.send({ type: "list", requestId: "stale-list" });
      oldPeer.send({
        type: "send",
        to: observerA.messages[0]?.session?.id ?? "missing",
        message: { id: "stale-send", timestamp: Date.now(), content: { text: "stale" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        oldPeer.messages.some((m) =>
          m.requestId === "stale-list"
          || m.requestId === "stale-control"
          || m.messageId === "stale-send"
        ),
        false,
      );
      assert.equal(
        observerB.messages.some((m) => m.type === "presence_update" && m.session.name === "stale-name"),
        false,
      );
      observerA.socket.destroy();
      observerB.socket.destroy();
      oldPeer.socket.destroy();
      newPeer.socket.destroy();
    });
  },
);

test("invalid scope fails before replacing an existing same-ID session", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const stableId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const existing = await rawConnect(socketPath);
    existing.send(rawRegistration("existing", stableId, scopeA, "same-runtime"));
    await existing.waitFor((m) => m.type === "registered");
    const invalid = await rawConnect(socketPath);
    invalid.send(rawRegistration("invalid", stableId, " invalid-scope", "same-runtime"));
    const error = await invalid.waitFor((m) => m.type === "error");
    assert.equal(error.code, "INVALID_REQUEST");
    existing.send({ type: "list", requestId: "still-live" });
    const sessions = await existing.waitFor((m) => m.type === "sessions" && m.requestId === "still-live");
    assert.equal(sessions.sessions.some((session: any) => session.id === stableId), true);
    existing.socket.destroy();
    invalid.socket.destroy();
  });
});

test("contact-copy full-ID output does not omit the session ID", async () => {
  const { formatContactInstruction } = await import("../claude/contact.ts");
  const self = {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    name: "alpha",
    cwd: "/tmp",
    model: "m",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
  };
  const other = { ...self, id: "ffffffff-ffff-4fff-8fff-ffffffffffff", name: "beta" };
  const withUniqueName = formatContactInstruction(self, [self, other]);
  assert.match(withUniqueName, /alpha/);
  assert.match(withUniqueName, new RegExp(self.id));
  const duplicate = { ...other, name: "alpha" };
  const withDuplicate = formatContactInstruction(self, [self, duplicate]);
  assert.match(withDuplicate, new RegExp(self.id));
});
