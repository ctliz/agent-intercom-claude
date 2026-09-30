// Plugin monitor entry point (auto-armed by monitors/monitors.json in TUI mode).
// Tails the session's intercom inbox and prints one line per NEW inbound
// message. Claude Code's Monitor machinery injects each stdout line into the
// live session as an event the model acts on. Pre-existing backlog is skipped
// so only messages that arrive after the session starts wake it.
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { basename } from "node:path";
import { defaultInboxPath, formatInboxLine, inboxBatchFrom } from "./inbox.ts";
import {
  ClaudeSessionReader, claudeIdentityForSession, claudeSessionMetadataPath,
  findClaudeHost, waitForClaudeSession,
} from "./session-lifecycle.ts";

const POLL_MS = 1000;

function readContent(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

type InboxSource = string | (() => { path: string; startedAt?: number });

export async function runInboxMonitor(source: InboxSource, signal?: { aborted: boolean }): Promise<void> {
  let path = "";
  let emitted = 0;
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
    for (const entry of entries) {
      process.stdout.write(`${formatInboxLine(entry)}\n`);
    }
    emitted = total;
    await delay(POLL_MS);
  }
}

async function main(): Promise<void> {
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
    const identity = claudeIdentityForSession(metadata, process.env, host.pid);
    return { path: explicitPath || defaultInboxPath(identity.sessionId), startedAt: metadata?.startedAt };
  });
}

if (process.argv[1] && (basename(process.argv[1]) === "inbox-monitor.ts" || basename(process.argv[1]) === "inbox-monitor.mjs")) {
  void main().catch((error) => {
    process.stderr.write(`inbox-monitor: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
