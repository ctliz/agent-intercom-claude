// Durable per-session inbox used by the live TUI mode (`cci --tui`).
//
// In TUI mode a single live `claude` session owns the broker identity (via the
// intercom MCP server). That MCP server appends each inbound message to this
// JSONL inbox file, and a plugin monitor tails the file and injects new lines
// into the live session. This keeps one broker connection per identity while
// still delivering unprompted wakes into an interactive session.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getIntercomDirPath, INTERCOM_RUNTIME_FILE_MODE } from "../broker/paths.ts";
import type { Message, SessionInfo } from "../types.ts";

export interface InboxEntry {
  ts: number;
  fromId: string;
  fromName?: string;
  messageId: string;
  team?: string;
  replyTo?: string;
  expectsReply: boolean;
  text: string;
}

export function sanitizeInboxSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "session";
}

export function defaultInboxPath(sessionId: string, intercomDir: string = getIntercomDirPath()): string {
  return join(intercomDir, `inbox-${sanitizeInboxSegment(sessionId)}.jsonl`);
}

// `attachmentText` is the pre-formatted attachment block, so Monitor delivery
// carries the same agent-visible body as Pi's inline message.
export function toInboxEntry(from: SessionInfo, message: Message, now: number = Date.now(), attachmentText = ""): InboxEntry {
  return {
    ts: now,
    fromId: from.id,
    ...(from.name ? { fromName: from.name } : {}),
    messageId: message.id,
    ...(message.content.team ? { team: message.content.team } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    expectsReply: Boolean(message.expectsReply),
    text: `${message.content.text}${attachmentText}`,
  };
}

export function appendInboxMessage(path: string, from: SessionInfo, message: Message, attachmentText = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(toInboxEntry(from, message, Date.now(), attachmentText))}\n`, {
    encoding: "utf-8",
    mode: INTERCOM_RUNTIME_FILE_MODE,
  });
}

// Bound one Monitor event; the full text stays available via intercom_pending.
export const MAX_INBOX_BODY_CHARS = 8000;

/**
 * Human/Claude-facing block the monitor emits for a new inbound message.
 * Single-line bodies stay on the header line. Multi-line bodies keep their
 * line structure (code, lists) and are indented so peer text cannot forge
 * another "Intercom message from" header.
 */
export function formatInboxLine(entry: InboxEntry): string {
  const who = entry.fromName ? `${entry.fromName} (${entry.fromId.slice(0, 8)})` : entry.fromId;
  const kind = entry.expectsReply ? " [asking — awaiting your reply]" : "";
  const header = `Intercom message from ${who}${entry.team ? ` [Team: ${entry.team}]` : ""}${kind}`;
  let body = entry.text.replace(/\r\n?/g, "\n").replace(/^\s*\n|\s+$/g, "");
  let truncated = false;
  if (body.length > MAX_INBOX_BODY_CHARS) {
    body = body.slice(0, MAX_INBOX_BODY_CHARS);
    truncated = true;
  }
  const lines = body.split("\n");
  const formatted = lines.length === 1 && !truncated
    ? `${header}: ${lines[0]!.trim()}`
    : `${header}:\n${lines.map((line) => `  ${line}`).join("\n")}${truncated ? "\n  … (truncated; call intercom_pending for the full text)" : ""}`;
  return `${formatted}\nReply with intercom_reply({ contextId: "ctx-${entry.messageId}", message: "..." }); inherit the original team.`;
}

/** One Monitor event for a burst of inbound messages (Pi-style batch). */
export function formatInboxBatch(entries: InboxEntry[]): string {
  if (entries.length === 1) return formatInboxLine(entries[0]!);
  return `Intercom batch (${entries.length} messages)\n\n${entries
    .map((entry, index) => `[${index + 1}/${entries.length}] ${formatInboxLine(entry)}`)
    .join("\n\n")}`;
}

/**
 * Pure monitor helper: given full inbox file contents and how many lines were
 * already emitted, return the new entries plus the updated line count. Resets
 * when the file shrank (truncation/rotation).
 */
export function inboxBatchFrom(content: string, alreadyEmitted: number): { entries: InboxEntry[]; total: number } {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  const total = lines.length;
  const start = alreadyEmitted <= total ? alreadyEmitted : 0;
  const entries: InboxEntry[] = [];
  for (let index = start; index < total; index += 1) {
    try {
      entries.push(JSON.parse(lines[index]) as InboxEntry);
    } catch {
      // Skip a torn/partial line; it will be complete on the next poll.
    }
  }
  return { entries, total };
}
