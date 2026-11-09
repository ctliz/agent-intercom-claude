// Plugin monitor entry point (auto-armed by monitors/monitors.json in TUI mode).
// Tails the session's intercom inbox and prints one line per NEW inbound
// message. Claude Code's Monitor machinery injects each stdout line into the
// live session as an event the model acts on. Pre-existing backlog is skipped
// so only messages that arrive after the session starts wake it.
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { basename, join } from "node:path";
import { defaultInboxPath, formatInboxBatch, inboxBatchFrom, type InboxEntry } from "./inbox.ts";
import { claudeNativeRegistryDir } from "./native-protocol.ts";
import {
  ClaudeSessionReader, claudeIdentityForSession, claudeSessionMetadataPath,
  findClaudeHost, waitForClaudeSession,
} from "./session-lifecycle.ts";

// Same delivery timing as Pi: combine a burst within a 300 ms quiet window,
// but never delay a steady stream by more than 1 s.
const POLL_MS = 250;
const QUIET_MS = 300;
const MAX_LATENCY_MS = 1000;
// A busy host defers delivery to the next idle boundary (Pi's followUp). If the
// host never reports idle (stale/unknown status), fall back to mid-turn delivery.
const DEFAULT_MAX_HOLD_MS = 10 * 60 * 1000;

function readContent(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

/**
 * Claude Code publishes live session state in its native session registry
 * (`<config>/sessions/<pid>.json`, `status: "busy" | "waiting" | ...`). Only an
 * explicit "busy" defers delivery; a missing or unreadable record never blocks.
 */
export function claudeHostBusyProbe(pid: number, registryDir = claudeNativeRegistryDir()): () => boolean {
  const path = join(registryDir, `${pid}.json`);
  return () => {
    try {
      return (JSON.parse(readFileSync(path, "utf8")) as { status?: unknown }).status === "busy";
    } catch {
      return false;
    }
  };
}

export interface InboxMonitorOptions {
  pollMs?: number;
  quietMs?: number;
  maxLatencyMs?: number;
  maxHoldMs?: number;
  isBusy?: () => boolean;
  now?: () => number;
  write?: (text: string) => void;
}

type InboxSource = string | (() => { path: string; startedAt?: number });

export async function runInboxMonitor(source: InboxSource, signal?: { aborted: boolean }, options: InboxMonitorOptions = {}): Promise<void> {
  const pollMs = options.pollMs ?? POLL_MS;
  const quietMs = options.quietMs ?? QUIET_MS;
  const maxLatencyMs = options.maxLatencyMs ?? MAX_LATENCY_MS;
  const maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const isBusy = options.isBusy ?? (() => false);
  const now = options.now ?? Date.now;
  const write = options.write ?? ((text: string) => { process.stdout.write(text); });
  let path = "";
  let emitted = 0;
  let pending: InboxEntry[] = [];
  let firstQueuedAt = 0;
  let lastQueuedAt = 0;
  for (;;) {
    if (signal?.aborted) return;
    const next = typeof source === "string" ? { path: source } : source();
    const content = readContent(next.path);
    if (path !== next.path) {
      path = next.path;
      const backlog = inboxBatchFrom(content, 0);
      // Skip old history, not messages received after SessionStart but before
      // Monitor startup. A resumed/cleared conversation gets its own cutoff.
      emitted = next.startedAt === undefined ? backlog.total
        : backlog.entries.filter((entry) => entry.ts < next.startedAt!).length;
    }
    const { entries, total } = inboxBatchFrom(content, emitted);
    emitted = total;
    const at = now();
    if (entries.length > 0) {
      if (pending.length === 0) firstQueuedAt = at;
      lastQueuedAt = at;
      pending.push(...entries);
    }
    if (pending.length > 0) {
      const settled = at - lastQueuedAt >= quietMs || at - firstQueuedAt >= maxLatencyMs;
      const deliverable = !isBusy() || at - firstQueuedAt >= maxHoldMs;
      if (settled && deliverable) {
        // One write per batch so Claude Code raises a single Monitor event.
        write(`${formatInboxBatch(pending)}\n`);
        pending = [];
      }
    }
    await delay(pollMs);
  }
}

function maxHoldFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const value = Number(env.CLAUDE_INTERCOM_MONITOR_MAX_HOLD_MS);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function main(): Promise<void> {
  // Channels and Monitor must not both inject the same inbound message.
  if (process.env.CLAUDE_INTERCOM_CHANNEL === "1") return;
  const explicitPath = process.env.CLAUDE_INTERCOM_INBOX || process.argv[2];
  const host = findClaudeHost();
  if (!host) {
    if (!explicitPath) throw new Error("Cannot determine this Claude session's inbox");
    await runInboxMonitor(explicitPath);
    return;
  }
  const reader = new ClaudeSessionReader(claudeSessionMetadataPath(host), host);
  await waitForClaudeSession(reader);
  await runInboxMonitor(() => {
    const metadata = reader.read();
    const identity = claudeIdentityForSession(metadata, process.env, host.pid, true);
    return { path: explicitPath || defaultInboxPath(identity.sessionId), startedAt: metadata?.startedAt };
  }, undefined, { isBusy: claudeHostBusyProbe(host.pid), maxHoldMs: maxHoldFromEnv() });
}

if (process.argv[1] && (basename(process.argv[1]) === "inbox-monitor.ts" || basename(process.argv[1]) === "inbox-monitor.mjs")) {
  void main().catch((error) => {
    process.stderr.write(`inbox-monitor: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
