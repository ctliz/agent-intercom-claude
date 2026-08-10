// Native Claude Code cross-session protocol, adapted from pi-claude-link's MIT implementation.
// The protocol is intentionally isolated from the broker so compatibility can be version-gated.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const DEFAULT_CLAUDE_SESSION_REGISTRY = join(homedir(), ".claude", "sessions");
export const MAX_NATIVE_FRAME_LINE = 1024 * 1024;

export interface NativeClaudePeer {
  pid?: number;
  sessionId?: string;
  name: string;
  cwd: string;
  status: string;
  kind?: string;
  startedAt?: number;
  socketPath: string;
  live?: boolean;
}

export interface NativeClaudeUserFrame {
  msgV: 1;
  msg_id: string;
  type: "user";
  priority: string;
  from?: string;
  session_id?: string;
  message: { role: "user"; content: string };
  [key: string]: unknown;
}

export interface NativeProtocolPaths {
  registryDir?: string;
  socketDir?: string;
}

export function claudeNativeSocketDir(paths: NativeProtocolPaths = {}): string {
  if (paths.socketDir) return paths.socketDir;
  const registryDir = paths.registryDir ?? DEFAULT_CLAUDE_SESSION_REGISTRY;
  try {
    for (const file of readdirSync(registryDir)) {
      if (!/^\d+\.json$/.test(file)) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(readFileSync(join(registryDir, file), "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof entry.messagingSocketPath === "string" && entry.messagingSocketPath.endsWith(".sock")) {
        return dirname(entry.messagingSocketPath);
      }
    }
  } catch {
    // Registry may not exist before the first Claude process starts.
  }
  return join(process.env.XDG_RUNTIME_DIR || "/tmp", "cc-socks");
}

export function nativeSocketLive(socketPath: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    if (!socketPath) return resolve(false);
    const socket = connect({ path: socketPath });
    let settled = false;
    const done = (live: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

export async function listNativeClaudeSessions(options: NativeProtocolPaths & { excludeSocket?: string } = {}): Promise<NativeClaudePeer[]> {
  const registryDir = options.registryDir ?? DEFAULT_CLAUDE_SESSION_REGISTRY;
  let files: string[];
  try {
    files = await readdir(registryDir);
  } catch {
    return [];
  }
  const peers: NativeClaudePeer[] = [];
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(await readFile(join(registryDir, file), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const socketPath = typeof entry.messagingSocketPath === "string" ? entry.messagingSocketPath : "";
    if (!socketPath || socketPath === options.excludeSocket) continue;
    peers.push({
      pid: typeof entry.pid === "number" ? entry.pid : undefined,
      sessionId: typeof entry.sessionId === "string" ? entry.sessionId : undefined,
      name: typeof entry.name === "string" ? entry.name : `pid ${String(entry.pid ?? "unknown")}`,
      cwd: typeof entry.cwd === "string" ? entry.cwd : "?",
      status: typeof entry.status === "string" ? entry.status : "unknown",
      kind: typeof entry.kind === "string" ? entry.kind : undefined,
      startedAt: typeof entry.startedAt === "number" ? entry.startedAt : undefined,
      socketPath,
    });
  }
  await Promise.all(peers.map(async (peer) => { peer.live = await nativeSocketLive(peer.socketPath); }));
  return peers.filter((peer) => peer.live).sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
}

export async function waitForNativeClaudePeer(
  pid: number,
  options: NativeProtocolPaths & { timeoutMs?: number; intervalMs?: number } = {},
): Promise<NativeClaudePeer> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  do {
    const peer = (await listNativeClaudeSessions(options)).find((candidate) => candidate.pid === pid);
    if (peer) return peer;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (true);
  throw new Error(`Claude process ${pid} did not publish a live native messaging socket within ${timeoutMs}ms`);
}

export async function resolveNativeClaudeTarget(
  nameOrId: string,
  options: NativeProtocolPaths & { excludeSocket?: string } = {},
): Promise<{ target?: NativeClaudePeer; error?: string; candidates?: string[] }> {
  const peers = await listNativeClaudeSessions(options);
  let target = peers.find((peer) => peer.sessionId === nameOrId) ?? peers.find((peer) => peer.name === nameOrId);
  if (!target) {
    const prefixMatches = peers.filter((peer) => peer.name.startsWith(nameOrId));
    if (prefixMatches.length === 1) target = prefixMatches[0];
    else if (prefixMatches.length > 1) return { error: `ambiguous: ${prefixMatches.map((peer) => peer.name).join(", ")}` };
  }
  if (!target) return { error: `no live Claude session matches "${nameOrId}"`, candidates: peers.map((peer) => peer.name) };
  return { target };
}

const ENVELOPE_TAG = "cross-session-message";
const escapeEnvelopeBody = (body: string) => body.replace(new RegExp(`</(?=${ENVELOPE_TAG}(?:[>\\s/]|$))`, "gi"), "<\\/");
const unescapeEnvelopeBody = (body: string) => body.replace(new RegExp(`<\\\\/(?=${ENVELOPE_TAG}(?:[>\\s/]|$))`, "gi"), "</");

export function buildNativeEnvelope(options: { from?: string; fromName?: string; fromMode?: string; body: string }): string {
  const attributes: string[] = [];
  if (options.from) attributes.push(`from="${options.from}"`);
  if (options.fromName) attributes.push(`from-name="${options.fromName.replace(/["<>]/g, "")}"`);
  if (options.fromMode) attributes.push(`from-mode="${options.fromMode}"`);
  return `<${ENVELOPE_TAG}${attributes.length ? ` ${attributes.join(" ")}` : ""}>\n${escapeEnvelopeBody(options.body)}\n</${ENVELOPE_TAG}>`;
}

export function stripNativeEnvelope(content: unknown): { body: string; from?: string; fromName?: string; fromMode?: string } {
  if (typeof content !== "string") return { body: "" };
  const match = content.match(new RegExp(`^<${ENVELOPE_TAG}((?:\\s+[a-z-]+="[^"]*")*)>\\n([\\s\\S]*)\\n</${ENVELOPE_TAG}>$`));
  if (!match) return { body: content };
  const attributes: Record<string, string> = {};
  for (const attribute of match[1]!.matchAll(/([a-z-]+)="([^"]*)"/g)) attributes[attribute[1]!] = attribute[2]!;
  return {
    body: unescapeEnvelopeBody(match[2]!),
    from: attributes.from,
    fromName: attributes["from-name"],
    fromMode: attributes["from-mode"],
  };
}

export function buildNativeUserFrame(options: { content: string; from?: string; priority?: string; sessionId?: string }): NativeClaudeUserFrame {
  return {
    msgV: 1,
    msg_id: randomUUID(),
    type: "user",
    priority: options.priority || "next",
    ...(options.from ? { from: options.from } : {}),
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    message: { role: "user", content: options.content },
  };
}

export function sendNativeFrame(socketPath: string, frame: unknown, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${socketPath}`));
    });
    socket.once("error", reject);
    socket.once("connect", () => socket.end(`${JSON.stringify(frame)}\n`, () => {
      const id = typeof frame === "object" && frame !== null && "msg_id" in frame ? String(frame.msg_id) : "";
      resolve(id);
    }));
  });
}

export function sendNativeClaudeMessage(options: {
  socketPath: string;
  body: string;
  from?: string;
  fromName?: string;
  priority?: string;
}): Promise<string> {
  const content = buildNativeEnvelope({ from: options.from, fromName: options.fromName, body: options.body });
  return sendNativeFrame(options.socketPath, buildNativeUserFrame({ content, from: options.from, priority: options.priority }));
}

export function buildNativeReceipt(options: { status: string; from?: string; originalMessageId?: string; reason?: string }): Record<string, unknown> {
  return {
    msgV: 1,
    msg_id: randomUUID(),
    type: "control",
    action: "peer_message_status",
    status: options.status,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.from ? { from: options.from } : {}),
    ...(options.originalMessageId ? { orig_msg_id: options.originalMessageId } : {}),
  };
}

export async function bindNativeClaudeSocket(socketPath: string, onFrame: (frame: Record<string, unknown>, connection: Socket) => void): Promise<Server> {
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  await unlink(socketPath).catch(() => undefined);
  const server = createServer((connection) => {
    connection.setEncoding("utf8");
    let buffer = "";
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_NATIVE_FRAME_LINE) {
        buffer = "";
        connection.destroy();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line) as Record<string, unknown>;
          onFrame(frame, connection);
        } catch {
          // Ignore malformed or handler-failing frames, matching Claude's peer behavior.
        }
      }
    });
    connection.on("end", () => connection.end());
    connection.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600).catch(() => undefined);
  return server;
}

function processStart(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
  });
}

export async function registerNativeClaudePeer(options: {
  pid: number;
  sessionId?: string;
  name: string;
  cwd: string;
  socketPath: string;
  status?: string;
  registryDir?: string;
}): Promise<string> {
  const registryDir = options.registryDir ?? DEFAULT_CLAUDE_SESSION_REGISTRY;
  await mkdir(registryDir, { recursive: true, mode: 0o700 });
  const sessionId = options.sessionId || randomUUID();
  const entry = {
    pid: options.pid,
    sessionId,
    cwd: options.cwd || process.cwd(),
    startedAt: Date.now(),
    procStart: await processStart(options.pid),
    version: "agent-intercom-claude",
    peerProtocol: 1,
    kind: "interactive",
    entrypoint: "agent-intercom",
    messagingSocketPath: options.socketPath,
    name: options.name,
    nameSource: "explicit",
    status: options.status || "idle",
  };
  await writeFile(join(registryDir, `${options.pid}.json`), `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  return sessionId;
}

export async function updateNativeClaudePeer(pid: number, patch: Record<string, unknown>, registryDir = DEFAULT_CLAUDE_SESSION_REGISTRY): Promise<void> {
  const path = join(registryDir, `${pid}.json`);
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  await writeFile(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, { mode: 0o600 });
}

export async function deregisterNativeClaudePeer(pid: number, socketPath?: string, registryDir = DEFAULT_CLAUDE_SESSION_REGISTRY): Promise<void> {
  await unlink(join(registryDir, `${pid}.json`)).catch(() => undefined);
  if (socketPath) await unlink(socketPath).catch(() => undefined);
}

export function nativePeerNameBySocket(socketPath: string, registryDir = DEFAULT_CLAUDE_SESSION_REGISTRY): string | undefined {
  if (!socketPath) return undefined;
  try {
    for (const file of readdirSync(registryDir)) {
      if (!/^\d+\.json$/.test(file)) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(readFileSync(join(registryDir, file), "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.messagingSocketPath === socketPath && typeof entry.name === "string") return entry.name;
    }
  } catch {
    // Missing registry has no matching peer.
  }
  return undefined;
}

export function nativeSlugFromCwd(cwd: string): string {
  return (basename(cwd || "claude") || "claude").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32);
}
