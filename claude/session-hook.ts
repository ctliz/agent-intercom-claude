import { readFileSync } from "node:fs";
import { findClaudeHost, publishClaudeSessionMetadata } from "./session-lifecycle.ts";

// Do not connect to the broker here: short-lived hooks must never compete with
// the session's persistent MCP runtime for the same stable ID.
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const host = findClaudeHost();
  if (host && input && typeof input === "object" && !Array.isArray(input)) {
    publishClaudeSessionMetadata(input, host);
  }
} catch (error) {
  process.stderr.write(`claude-intercom hook: ${error instanceof Error ? error.message : String(error)}\n`);
}
