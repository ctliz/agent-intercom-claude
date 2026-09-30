import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { ClaudeIntercomRuntime } from "./runtime.ts";
import { handleMcpRequest } from "./mcp-protocol.ts";
import {
  ClaudeSessionReader, claudeIdentityForSession, claudeSessionMetadataPath,
  findClaudeHost, waitForClaudeSession,
} from "./session-lifecycle.ts";

let shuttingDown = false;
let stopPolling = () => {};
let pendingSync = Promise.resolve();
const report = (error: unknown) => {
  process.stderr.write(`claude-intercom: ${error instanceof Error ? error.message : String(error)}\n`);
};

const runtimeReady = (async () => {
  const host = findClaudeHost();
  const reader = host ? new ClaudeSessionReader(claudeSessionMetadataPath(host), host) : undefined;
  const metadata = reader ? await waitForClaudeSession(reader) : undefined;
  const runtime = new ClaudeIntercomRuntime(claudeIdentityForSession(metadata, process.env, host?.pid));
  // Always register, including ordinary MCP launches. Hook/Monitor processes
  // never connect to the broker, so there is still exactly one owner.
  if (!shuttingDown && !metadata?.ended) void runtime.connect().catch(report);
  if (reader && !shuttingDown) {
    let previous = JSON.stringify(metadata);
    let syncing = false;
    const timer = setInterval(() => {
      if (syncing || shuttingDown) return;
      const next = reader.read();
      const signature = JSON.stringify(next);
      if (!next || signature === previous) return;
      previous = signature;
      syncing = true;
      pendingSync = (async () => {
        if (next.ended) await runtime.disconnect();
        else {
          await runtime.syncSession(claudeIdentityForSession(next, process.env, host!.pid));
          await runtime.connect();
        }
      })().catch(report).finally(() => { syncing = false; });
    }, 250);
    timer.unref();
    stopPolling = () => clearInterval(timer);
  }
  return runtime;
})();

const rl = readline.createInterface({
  input: stdin,
  crlfDelay: Infinity,
});

let pendingRequests = 0;

function writeResponse(response: Record<string, unknown> | undefined): void {
  if (!response) return;
  stdout.write(`${JSON.stringify(response)}\n`);
}

function maybeShutdown(): void {
  if (!shuttingDown || pendingRequests > 0) return;
  stopPolling();
  void runtimeReady.then(async (runtime) => {
    await pendingSync;
    await runtime.disconnect();
  }).finally(() => process.exit(0));
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  pendingRequests += 1;
  void (async () => {
    try {
      const request = JSON.parse(trimmed);
      writeResponse(await handleMcpRequest(request, await runtimeReady));
    } catch (error) {
      writeResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  })().finally(() => {
    pendingRequests -= 1;
    maybeShutdown();
  });
});

const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  rl.close();
  maybeShutdown();
};

rl.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("disconnect", shutdown);
