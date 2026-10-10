import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_NOTICE, createChannelPump } from "./channel.ts";

test("channel notifies unread bursts once without consuming messages or leaking peer text", async () => {
  let sessionId = "first";
  let entries = [{ contextId: "ctx-a", text: "untrusted peer content" }];
  const notifications: any[] = [];
  const runtime = {
    getIdentity: () => ({ sessionId }),
    pending: async (markRead: boolean) => {
      assert.equal(markRead, false);
      return { structuredContent: { unread_messages: entries } };
    },
  };
  const pump = createChannelPump(runtime as any, (notice) => notifications.push(notice));
  await pump();
  await pump();
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], { jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: CHANNEL_NOTICE } });
  assert.equal(entries.length, 1);
  entries.push({ contextId: "ctx-b", text: "second" });
  await pump();
  assert.equal(notifications.length, 2);
  entries = [];
  await pump();
  assert.equal(notifications.length, 2);
  sessionId = "replacement";
  entries = [{ contextId: "ctx-a", text: "new session" }];
  await pump();
  assert.equal(notifications.length, 3);
});
