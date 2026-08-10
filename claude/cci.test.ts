import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  buildTuiAppendSystemPrompt,
  createDefaultIdentity,
  nativeClaudeFeatureEnv,
  parseCciArgs,
  resolveIntercomSelection,
  sanitizeSegment,
  waitForChildExit,
  writeDefaultWorkerMcpConfig,
} from "./cci.ts";

test("sanitizeSegment keeps readable safe ids", () => {
  assert.equal(sanitizeSegment("Claude:Repo Main#123"), "claude:repo-main-123");
  assert.equal(sanitizeSegment(""), "claude");
});

test("resolveIntercomSelection accepts only an in-range numbered choice", () => {
  assert.equal(resolveIntercomSelection(" 2 ", 3), 1);
  assert.equal(resolveIntercomSelection("0", 3), null);
  assert.equal(resolveIntercomSelection("4", 3), null);
  assert.equal(resolveIntercomSelection("worker", 3), null);
});

test("createDefaultIdentity derives readable per-process defaults", () => {
  const identity = createDefaultIdentity({
    cwd: "/home/me/src/project",
    pid: 4321,
    gitRoot: "/home/me/src/project",
    branch: "main",
  });
  assert.match(identity.id, /^claude-project-main-[a-f0-9]{8}-4321$/);
  assert.equal(identity.name, "claude:project:main#4321");
});

test("parseCciArgs reads name, id, cwd, instructions, model, and effort", () => {
  const parsed = parseCciArgs([
    "--name", "worker",
    "--id=worker-1",
    "--cwd", "/tmp/project",
    "--instructions", "Stay terse.",
    "--model=opus",
    "--effort", "max",
  ], {});

  assert.equal(parsed.name, "worker");
  assert.equal(parsed.id, "worker-1");
  assert.equal(parsed.cwd, "/tmp/project");
  assert.equal(parsed.instructions, "Stay terse.");
  assert.equal(parsed.model, "opus");
  assert.equal(parsed.effort, "max");
});

test("parseCciArgs tui defaults to false and is enabled by --tui/--live", () => {
  assert.equal(parseCciArgs([], {}).tui, false);
  assert.equal(parseCciArgs(["--tui"], {}).tui, true);
  assert.equal(parseCciArgs(["--live"], {}).tui, true);
});

test("waitForChildExit handles a process that exited before its listener was attached", async () => {
  const child = { exitCode: 7, signalCode: null } as ChildProcess;
  assert.deepEqual(await waitForChildExit(child), [7, null]);
});

test("buildTuiAppendSystemPrompt names the identity and selected reply protocol", () => {
  const mcpPrompt = buildTuiAppendSystemPrompt("reviewer", "claude-reviewer-1");
  assert.match(mcpPrompt, /reviewer/);
  assert.match(mcpPrompt, /claude-reviewer-1/);
  assert.match(mcpPrompt, /intercom_reply/);
  assert.match(mcpPrompt, /awaiting your reply/);

  const nativePrompt = buildTuiAppendSystemPrompt("reviewer", "claude-reviewer-1", "native");
  assert.match(nativePrompt, /native cross-session channel/);
  assert.match(nativePrompt, /built-in SendMessage tool/);
  assert.match(nativePrompt, /normal assistant response.*does not reach/);
  assert.doesNotMatch(nativePrompt, /intercom_reply\(\{/);
});

test("native TUI launches explicitly enable Claude cross-session messaging", () => {
  assert.deepEqual(nativeClaudeFeatureEnv("native"), { CLAUDE_CODE_HARBOR_KITE: "1" });
  assert.deepEqual(nativeClaudeFeatureEnv("mcp"), {});
});

test("writeDefaultWorkerMcpConfig exposes the packaged intercom server to headless Claude", async () => {
  const temp = await mkdtemp(join(tmpdir(), "claude-cci-mcp-"));
  const root = join(temp, "package");
  const intercomDir = join(temp, "intercom");
  const serverPath = join(root, "dist", "claude-server.mjs");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(serverPath, "// test server\n");
  try {
    const path = writeDefaultWorkerMcpConfig(root, intercomDir);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(parsed, { mcpServers: { "claude-intercom": { command: process.execPath, args: [serverPath] } } });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("parseCciArgs is safe by default when neither --yolo nor --safe is given", () => {
  const parsed = parseCciArgs([], {});
  assert.equal(parsed.dangerouslySkipPermissions, false);
  assert.equal(parsed.permissionMode, "manual");
});

test("parseCciArgs --yolo remains an explicit opt-in", () => {
  const parsed = parseCciArgs(["--yolo"], {});
  assert.equal(parsed.dangerouslySkipPermissions, true);
});

test("parseCciArgs minimal defaults to false and is enabled by --minimal/--bare", () => {
  assert.equal(parseCciArgs([], {}).minimal, false);
  assert.equal(parseCciArgs(["--minimal"], {}).minimal, true);
  assert.equal(parseCciArgs(["--bare"], {}).minimal, true);
});

test("parseCciArgs --dangerously-skip-permissions behaves like --yolo", () => {
  const parsed = parseCciArgs(["--dangerously-skip-permissions"], {});
  assert.equal(parsed.dangerouslySkipPermissions, true);
});

test("parseCciArgs --safe opts out of yolo and sets permission-mode manual", () => {
  const parsed = parseCciArgs(["--safe"], {});
  assert.equal(parsed.dangerouslySkipPermissions, false);
  assert.equal(parsed.permissionMode, "manual");
});

test("parseCciArgs --safe respects an explicit --permission-mode", () => {
  const parsed = parseCciArgs(["--permission-mode", "plan", "--safe"], {});
  assert.equal(parsed.dangerouslySkipPermissions, false);
  assert.equal(parsed.permissionMode, "plan");
});

test("parseCciArgs rejects unknown explicit permission modes", () => {
  assert.throws(() => parseCciArgs(["--permission-mode", "anything-goes"], {}), /must be one of/);
});

test("parseCciArgs last of --yolo/--safe wins when both are given", () => {
  const safeThenYolo = parseCciArgs(["--safe", "--yolo"], {});
  assert.equal(safeThenYolo.dangerouslySkipPermissions, true);

  const yoloThenSafe = parseCciArgs(["--yolo", "--safe"], {});
  assert.equal(yoloThenSafe.dangerouslySkipPermissions, false);
});

test("parseCciArgs collects repeatable --add-dir flags", () => {
  const parsed = parseCciArgs(["--add-dir", "/a", "--add-dir=/b"], {});
  assert.deepEqual(parsed.addDirs, [resolve("/a"), resolve("/b")]);
});

test("parseCciArgs falls back to env vars, then defaults", () => {
  const parsed = parseCciArgs([], {
    CLAUDE_INTERCOM_NAME: "env-name",
    CLAUDE_INTERCOM_SESSION_ID: "env-id",
    CLAUDE_INTERCOM_CLAUDE_COMMAND: "claude-custom",
    CLAUDE_INTERCOM_EFFORT: "high",
  });
  assert.equal(parsed.name, "env-name");
  assert.equal(parsed.id, "env-id");
  assert.equal(parsed.claudeCommand, "claude-custom");
  assert.equal(parsed.effort, "high");
});

test("parseCciArgs defaults claudeCommand to \"claude\"", () => {
  const parsed = parseCciArgs([], {});
  assert.equal(parsed.claudeCommand, "claude");
});

test("parseCciArgs reads native transport selection from CLI before environment", () => {
  assert.equal(parseCciArgs([], {}).transport, "auto");
  assert.equal(parseCciArgs([], { CLAUDE_INTERCOM_TRANSPORT: "mcp" }).transport, "mcp");
  assert.equal(parseCciArgs(["--transport", "native"], { CLAUDE_INTERCOM_TRANSPORT: "mcp" }).transport, "native");
  assert.equal(parseCciArgs(["--transport=mcp"], {}).transport, "mcp");
  assert.throws(() => parseCciArgs(["--transport", "legacy"], {}), /auto, native, or mcp/);
});
