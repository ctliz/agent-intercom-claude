import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeIntercomRuntime } from "../claude/runtime.ts";

const adapters = ["pi", "claude", "opencode", "codex"];
const checkout = (adapter: string) => new URL(`../../agent-intercom-${adapter}/`, import.meta.url);
const available = adapters.every((adapter) => existsSync(new URL("broker/broker.ts", checkout(adapter))));
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for cross-adapter delivery");
}

for (const brokerAdapter of adapters) {
  test(`overlapping task teams across Pi/Claude/OpenCode/Codex through ${brokerAdapter} broker`, { skip: !available }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "intercom-cross-task-"));
    const keys = ["PI_CODING_AGENT_DIR", "AGENT_INTERCOM_SCOPE_ID", "AGENT_INTERCOM_MANAGER_TARGET", "CLAUDE_INTERCOM_INBOX"];
    const previous = keys.map((key) => process.env[key]);
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.CLAUDE_INTERCOM_INBOX = join(dir, "inbox.jsonl");
    delete process.env.AGENT_INTERCOM_SCOPE_ID;
    delete process.env.AGENT_INTERCOM_MANAGER_TARGET;
    const broker = spawn(process.execPath, ["--import", "tsx", "broker/broker.ts"], {
      cwd: fileURLToPath(checkout(brokerAdapter)), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
    });
    const runtimes: Array<{ disconnect(): Promise<void> }> = [];
    let stderr = "";
    broker.stderr.on("data", (chunk) => { stderr += chunk; });
    t.after(async () => {
      await Promise.all(runtimes.map((runtime) => runtime.disconnect()));
      const exited = once(broker, "exit");
      broker.kill("SIGTERM");
      await exited;
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
      rmSync(dir, { recursive: true, force: true });
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Broker startup timeout: ${stderr}`)), 5000);
      broker.stdout.on("data", (chunk) => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timeout); resolve(); } });
      broker.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Broker exited ${code}: ${stderr}`)); });
    });
    const { OpenCodeIntercomRuntime } = await import(fileURLToPath(new URL("opencode/runtime.ts", checkout("opencode"))));
    const { CodexIntercomRuntime } = await import(fileURLToPath(new URL("codex/runtime.ts", checkout("codex"))));
    const { IntercomClient: PiClient } = await import(fileURLToPath(new URL("broker/client.ts", checkout("pi"))));
    const identity = (name: string) => ({ sessionId: `${name}-id`, name, cwd: dir, model: name, startedAt: Date.now() });
    const options = { prepareConnection: async () => {} };
    const claude = new ClaudeIntercomRuntime(identity("claude"), options);
    const opencode = new OpenCodeIntercomRuntime(identity("opencode"), dir, undefined, undefined, options);
    const codex = new CodexIntercomRuntime(identity("codex"), options);
    const pi = new PiClient({ env: {} });
    runtimes.push(claude, opencode, codex, pi);
    const piMessages: any[] = [];
    pi.on("message", (_from: unknown, message: unknown, deliveryId: string) => { piMessages.push(message); pi.acknowledgeMessage(deliveryId); });
    await Promise.all([claude.connect(), opencode.connect(), codex.connect(), pi.connect({ name: "pi", cwd: dir, model: "pi", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() }, "pi-id")]);
    assert.equal((await claude.join("alpha", true, ["pi", "opencode", "codex"], "Alpha work")).isError, undefined);
    assert.equal((await opencode.join("beta", true, ["claude", "codex", "pi"], "Beta work")).isError, undefined);
    assert.equal((await codex.team()).structuredContent.teams.length, 2);
    await assert.rejects(claude.send("codex", "ambiguous"), /Multiple shared teams/);
    await claude.send("codex", "alpha work", undefined, undefined, "alpha");
    await opencode.send("codex", "beta work", undefined, undefined, "beta");
    const incoming = await until(() => codex.pending(), (result) => result.structuredContent.unread_messages.length === 2);
    const messages = incoming.structuredContent.unread_messages;
    for (const entry of messages) {
      assert.equal((await codex.reply(`done ${entry.team}`, undefined, undefined, undefined, entry.contextId)).isError, undefined);
    }
    assert.match((await until(() => claude.pending(), (result) => result.content[0].text.includes("done alpha"))).content[0].text, /\[Team: alpha\]/);
    assert.match((await until(() => opencode.pending(), (result) => result.content[0].text.includes("done beta"))).content[0].text, /\[Team: beta\]/);
    const asking = opencode.ask("codex", "beta question", undefined, 3000, undefined, "beta");
    const asks = await until(() => codex.pending(), (result) => result.structuredContent.pending_asks.length === 1);
    await codex.reply("beta answer", undefined, undefined, asks.structuredContent.pending_asks[0].askId);
    assert.match((await asking).content[0].text, /beta answer/);
    const sent = await pi.send("claude-id", { text: "Pi question", team: "alpha", expectsReply: true, messageId: "pi-ask" });
    assert.equal(sent.delivered, true);
    const piAsk = await until(() => claude.pending(), (result) => result.structuredContent.pending_asks.length === 1);
    await claude.reply("Pi answer", undefined, undefined, piAsk.structuredContent.pending_asks[0].askId);
    await until(async () => piMessages, (messages) => messages.some((message) => message.replyTo === "pi-ask"));
    assert.equal(piMessages.find((message) => message.replyTo === "pi-ask").content.team, "alpha");
  });
}
