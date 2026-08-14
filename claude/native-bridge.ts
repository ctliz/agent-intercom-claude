import type { Server } from "node:net";
import { join } from "node:path";
import { IntercomClient } from "../broker/client.ts";
import { spawnBrokerIfNeeded } from "../broker/spawn.ts";
import { INTERCOM_SCOPE_ENV, intercomScopeIdFromEnvForRegistration, parseIntercomScopeIdForRegistration } from "../protocol-v4/contract.ts";
import { loadConfig } from "../config.ts";
import type { Message, SessionInfo } from "../types.ts";
import { formatAttachments, formatSessionDisplay } from "./runtime.ts";
import {
  bindNativeClaudeSocket,
  buildNativeReceipt,
  claudeNativeSocketDir,
  deregisterNativeClaudePeer,
  nativePeerNameBySocket,
  registerNativeClaudePeer,
  sendNativeClaudeMessage,
  sendNativeFrame,
  stripNativeEnvelope,
  updateNativeClaudePeer,
  type NativeProtocolPaths,
} from "./native-protocol.ts";

interface NativeBridgeClient {
  sessionId: string | null;
  on(event: "message", listener: (from: SessionInfo, message: Message, deliveryId: string) => void): unknown;
  on(event: "disconnected", listener: (error: Error) => void): unknown;
  connect(registration: {
    name: string;
    cwd: string;
    model: string;
    pid: number;
    startedAt: number;
    lastActivity: number;
    status: string;
  }, sessionId?: string): Promise<void>;
  disconnect(): Promise<void>;
  acknowledgeMessage(deliveryId: string): void;
  send(to: string, message: { text: string; replyTo?: string }): Promise<{ delivered: boolean; reason?: string }>;
  updatePresence(update: { status?: string }): void;
}

export interface NativeClaudeBridgeIdentity {
  id: string;
  name: string;
  cwd: string;
  model?: string;
  pid?: number;
}

export interface NativeClaudeBrokerBridgeOptions extends NativeProtocolPaths {
  client?: NativeBridgeClient;
  prepareConnection?: () => Promise<void>;
  socketPath?: string;
  sendNative?: typeof sendNativeClaudeMessage;
  sendFrame?: typeof sendNativeFrame;
  scopeId?: string;
  env?: NodeJS.ProcessEnv;
}

interface PendingRelay {
  from: SessionInfo;
  message: Message;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function nativePrompt(from: SessionInfo, message: Message): string {
  const reply = message.expectsReply
    ? "\n\nThe sender is blocking. After acting, use Claude's built-in SendMessage tool to reply to this same native peer. A normal assistant response stays local and will not unblock the sender."
    : "\n\nAct if needed. To acknowledge or report a result, use Claude's built-in SendMessage tool to reply to this same native peer; a normal assistant response stays local.";
  return [
    `[Intercom message from ${formatSessionDisplay(from)} (${from.id})]`,
    message.content.text,
    formatAttachments(message.content.attachments),
    reply,
  ].join("\n");
}

/**
 * Broker identity for one live Claude Code process. Broker messages are injected
 * through Claude's native cross-session socket; native replies are relayed back
 * through the broker while preserving blocking ask correlation.
 */
export class NativeClaudeBrokerBridge {
  private readonly client: NativeBridgeClient;
  private readonly prepareConnection: () => Promise<void>;
  private readonly sendNative: typeof sendNativeClaudeMessage;
  private readonly sendFrame: typeof sendNativeFrame;
  private readonly pid: number;
  private readonly socketPath: string;
  private server?: Server;
  private targetSocket = "";
  private pending: PendingRelay[] = [];
  private started = false;

  constructor(
    private readonly identity: NativeClaudeBridgeIdentity,
    private readonly options: NativeClaudeBrokerBridgeOptions = {},
  ) {
    const scopeId = options.scopeId === undefined
      ? intercomScopeIdFromEnvForRegistration(options.env ?? process.env)
      : parseIntercomScopeIdForRegistration(options.scopeId);
    const scopeEnv = scopeId === undefined ? {} : { [INTERCOM_SCOPE_ENV]: scopeId };
    this.client = options.client ?? new IntercomClient({ env: scopeEnv });
    this.prepareConnection = options.prepareConnection ?? (async () => {
      const config = loadConfig();
      await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
    });
    this.sendNative = options.sendNative ?? sendNativeClaudeMessage;
    this.sendFrame = options.sendFrame ?? sendNativeFrame;
    this.pid = identity.pid ?? process.pid;
    this.socketPath = options.socketPath ?? join(claudeNativeSocketDir(options), `agent-intercom-${this.pid}.sock`);
  }

  get nativeSocketPath(): string {
    return this.socketPath;
  }

  async start(targetSocket: string): Promise<void> {
    if (this.started) {
      this.targetSocket = targetSocket;
      return;
    }
    this.targetSocket = targetSocket;
    this.server = await bindNativeClaudeSocket(this.socketPath, (frame) => this.handleNativeFrame(frame));
    await registerNativeClaudePeer({
      pid: this.pid,
      sessionId: this.identity.id,
      name: `${this.identity.name} bridge`,
      cwd: this.identity.cwd,
      socketPath: this.socketPath,
      status: "idle",
      registryDir: this.options.registryDir,
    });
    await this.prepareConnection();
    this.client.on("message", (from, message, deliveryId) => {
      void this.handleBrokerMessage(from, message, deliveryId);
    });
    this.client.on("disconnected", () => {
      void updateNativeClaudePeer(this.pid, { status: "broker disconnected" }, this.options.registryDir);
    });
    await this.client.connect({
      name: this.identity.name,
      cwd: this.identity.cwd,
      model: this.identity.model ?? "claude",
      pid: this.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      status: "idle",
    }, this.identity.id);
    this.started = true;
  }

  private async handleBrokerMessage(from: SessionInfo, message: Message, deliveryId: string): Promise<void> {
    try {
      this.client.updatePresence({ status: "active" });
      await this.sendNative({
        socketPath: this.targetSocket,
        body: nativePrompt(from, message),
        from: `uds:${this.socketPath}`,
        fromName: this.identity.name,
      });
      this.pending.push({ from, message });
      this.client.acknowledgeMessage(deliveryId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.client.updatePresence({ status: `native delivery error: ${reason}` });
      if (message.expectsReply) {
        await this.client.send(from.id, { text: `Native Claude delivery failed: ${reason}`, replyTo: message.id }).catch(() => undefined);
      }
    }
  }

  private handleNativeFrame(frame: Record<string, unknown>): void {
    if (frame.type !== "user") return;
    const message = frame.message;
    if (typeof message !== "object" || message === null || !("content" in message)) return;
    const envelope = stripNativeEnvelope((message as { content?: unknown }).content);
    if (!envelope.body) return;
    const relay = this.pending.shift();
    const fromAddress = typeof frame.from === "string" ? frame.from : envelope.from;
    if (fromAddress?.startsWith("uds:")) {
      void this.sendFrame(fromAddress.slice(4), buildNativeReceipt({
        status: "delivered",
        from: `uds:${this.socketPath}`,
        originalMessageId: typeof frame.msg_id === "string" ? frame.msg_id : undefined,
        reason: "Relayed to Agent Intercom.",
      })).catch(() => undefined);
    }
    if (!relay) return;
    void this.client.send(relay.from.id, {
      text: envelope.body,
      ...(relay.message.expectsReply ? { replyTo: relay.message.id } : {}),
    }).then(() => {
      this.client.updatePresence({ status: "idle" });
    }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.pending = [];
    await this.client.disconnect().catch(() => undefined);
    if (this.server) await closeServer(this.server).catch(() => undefined);
    this.server = undefined;
    await deregisterNativeClaudePeer(this.pid, this.socketPath, this.options.registryDir);
  }
}

export function nativeClaudeSenderName(frame: Record<string, unknown>, registryDir?: string): string | undefined {
  const message = frame.message;
  const content = typeof message === "object" && message !== null && "content" in message
    ? (message as { content?: unknown }).content
    : undefined;
  const envelope = stripNativeEnvelope(content);
  const from = typeof frame.from === "string" ? frame.from : envelope.from;
  return from?.startsWith("uds:") ? nativePeerNameBySocket(from.slice(4), registryDir) ?? envelope.fromName : envelope.fromName;
}
