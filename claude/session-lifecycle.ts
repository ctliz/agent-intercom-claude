// Hooks publish metadata only. The MCP server remains the sole broker owner.
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { ensureIntercomRuntimeDir, getIntercomDirPath } from "../broker/paths.ts";
import { buildClaudeRuntimeIdentity, type ClaudeRuntimeIdentity } from "./runtime.ts";

export interface ClaudeHost {
  pid: number;
  startedAt: string;
}

export interface ClaudeSessionMetadata {
  hostStartedAt: string;
  sessionId: string;
  cwd: string;
  name?: string;
  model?: string;
  transcriptPath: string;
  startedAt: number;
  ended: boolean;
}

// Hooks may have a shell parent, while MCP/Monitor processes are direct children.
// Match the nearest actual Claude executable, never another session in the cwd.
export function findClaudeHost(pid = process.ppid): ClaudeHost | undefined {
  for (let depth = 0; pid > 1 && depth < 16; depth++) {
    let parts: string[];
    try {
      parts = execFileSync("ps", ["-p", String(pid), "-o", "ppid=", "-o", "lstart=", "-o", "comm="],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\s+/);
    } catch { return undefined; }
    const command = basename(parts.slice(6).join(" "));
    if (/^claude(?:\.exe)?$/i.test(command)) {
      return { pid, startedAt: parts.slice(1, 6).join(" ") };
    }
    // Do not attach a different harness launched by a Claude Bash tool to
    // that outer Claude's identity. Only traverse hook-launcher shells.
    if (!/^(sh|bash|zsh|dash|fish)$/.test(command)) return undefined;
    pid = Number(parts[0]);
  }
  return undefined;
}

export function claudeSessionMetadataPath(host: ClaudeHost): string {
  return join(getIntercomDirPath(), `claude-host-${host.pid}.json`);
}

export function readClaudeSessionMetadata(path: string, host: ClaudeHost): ClaudeSessionMetadata | undefined {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data.hostStartedAt !== host.startedAt || typeof data.sessionId !== "string"
      || !/^[A-Za-z0-9_-]{1,128}$/.test(data.sessionId) || typeof data.cwd !== "string"
      || typeof data.transcriptPath !== "string" || typeof data.startedAt !== "number"
      || typeof data.ended !== "boolean"
      || (data.name !== undefined && typeof data.name !== "string")
      || (data.model !== undefined && typeof data.model !== "string")) return undefined;
    return data;
  } catch { return undefined; }
}

export function publishClaudeSessionMetadata(input: Record<string, unknown>, host: ClaudeHost,
  env: NodeJS.ProcessEnv = process.env, path = claudeSessionMetadataPath(host)): void {
  if (typeof input.session_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.session_id)) return;
  const previous = readClaudeSessionMetadata(path, host);
  const ended = input.hook_event_name === "SessionEnd";
  // A delayed end for an old conversation must not disconnect its replacement.
  if (ended && previous?.sessionId !== input.session_id) return;
  if (!ended && (typeof input.cwd !== "string" || typeof input.transcript_path !== "string")) return;
  const name = typeof input.session_title === "string" && input.session_title.trim()
    ? input.session_title : buildClaudeRuntimeIdentity(env, input.cwd as string, host.pid).name;
  const data: ClaudeSessionMetadata = ended ? { ...previous!, ended: true } : {
    hostStartedAt: host.startedAt, sessionId: input.session_id,
    cwd: input.cwd as string, transcriptPath: input.transcript_path as string,
    name, ...(typeof input.model === "string" ? { model: input.model } : {}),
    startedAt: Date.now(), ended: false,
  };
  ensureIntercomRuntimeDir(dirname(path));
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function claudeIdentityForSession(metadata: ClaudeSessionMetadata | undefined,
  env: NodeJS.ProcessEnv = process.env, pid = process.pid): ClaudeRuntimeIdentity {
  const identity = buildClaudeRuntimeIdentity(env, metadata?.cwd ?? env.PWD ?? process.cwd(), pid);
  if (!metadata) return identity;
  if (!env.CLAUDE_INTERCOM_SESSION_ID?.trim() && !env.CLAUDE_PEER_ID?.trim() && !env.AGENT_INTERCOM_SESSION_ID?.trim()) {
    identity.sessionId = `claude-${metadata.sessionId}`;
  }
  identity.name = metadata.name?.trim() || identity.name;
  if (!env.CLAUDE_INTERCOM_MODEL?.trim()) identity.model = metadata.model?.trim() || identity.model;
  identity.startedAt = metadata.startedAt;
  return identity;
}

// Incremental transcript tail: /rename writes a custom-title record, even without
// a model turn. Never rescan conversation bodies on every presence poll.
export class ClaudeSessionReader {
  private transcriptPath = "";
  private sessionId = "";
  private offset = 0;
  private partial = "";
  private decoder = new StringDecoder("utf8");
  private name?: string;
  private startedAt = 0;

  constructor(private readonly path: string, private readonly host: ClaudeHost) {}

  read(): ClaudeSessionMetadata | undefined {
    const metadata = readClaudeSessionMetadata(this.path, this.host);
    if (!metadata || metadata.ended) return metadata;
    if (metadata.sessionId !== this.sessionId || metadata.transcriptPath !== this.transcriptPath
      || metadata.startedAt !== this.startedAt) {
      this.sessionId = metadata.sessionId;
      this.transcriptPath = metadata.transcriptPath;
      this.startedAt = metadata.startedAt;
      this.name = undefined;
      this.partial = "";
      this.decoder = new StringDecoder("utf8");
      // A bounded tail also catches renames between the hook and MCP startup.
      try { this.offset = Math.max(0, statSync(this.transcriptPath).size - 64 * 1024); } catch { this.offset = 0; }
    }
    let fd: number | undefined;
    try {
      fd = openSync(this.transcriptPath, "r");
      const size = statSync(this.transcriptPath).size;
      if (size < this.offset) {
        this.offset = 0;
        this.partial = "";
        this.decoder = new StringDecoder("utf8");
      }
      // Bound reads and memory even during large tool-output writes.
      const buffer = Buffer.alloc(Math.min(size - this.offset, 64 * 1024));
      const count = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += count;
      const lines = (this.partial + this.decoder.write(buffer.subarray(0, count))).split("\n");
      this.partial = lines.pop() ?? "";
      if (this.partial.length > 64 * 1024) this.partial = "";
      for (const line of lines) {
        if (!line.includes('"custom-title"')) continue;
        try {
          const record = JSON.parse(line);
          if (record.type === "custom-title" && record.sessionId === metadata.sessionId
            && typeof record.customTitle === "string" && record.customTitle.trim()) this.name = record.customTitle;
        } catch { /* Torn or unrelated transcript records are not presence updates. */ }
      }
    } catch { /* Transcripts are created asynchronously and can be rotated. */ }
    finally { if (fd !== undefined) closeSync(fd); }
    return { ...metadata, name: this.name ?? metadata.name };
  }
}

export async function waitForClaudeSession(reader: ClaudeSessionReader): Promise<ClaudeSessionMetadata | undefined> {
  // SessionStart and MCP/Monitor startup can race. Wait briefly for the hook,
  // but standalone MCP configurations without the plugin must still connect.
  for (let attempt = 0; attempt < 20; attempt++) {
    const metadata = reader.read();
    if (metadata) return metadata;
    await delay(50);
  }
  return reader.read();
}
