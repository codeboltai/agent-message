import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { nanoid } from "nanoid";
import {
  JsonlEventStore,
  messageEvents,
  threadMessages,
  threadViews,
  type AccountConfig,
  type AddressRef,
  type EventStore,
  type LoadedConfig,
  type MessageEnvelope,
  type StoreEvent,
} from "@codebolt/agent-message-core";

export interface FederationServerOptions {
  loadedConfig: LoadedConfig;
  store?: EventStore;
  token?: string;
}

export interface StartFederationServerOptions extends FederationServerOptions {
  host: string;
  port: number;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function text(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(value);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

function accountsFromEvents(events: StoreEvent[]): AccountConfig[] {
  return events
    .filter((event) => event.type === "account.created")
    .map((event) => event.payload as AccountConfig);
}

function findAccount(
  loadedConfig: LoadedConfig,
  events: StoreEvent[],
  accountId: string,
): AccountConfig | undefined {
  return loadedConfig.config.accounts[accountId] ??
    accountsFromEvents(events).find((account) => account.id === accountId);
}

async function deliver(message: MessageEnvelope, loadedConfig: LoadedConfig, store: EventStore): Promise<void> {
  const events = await store.readAll();
  const allAccounts = [...Object.values(loadedConfig.config.accounts), ...accountsFromEvents(events)];
  for (const recipient of message.to) {
    const account = allAccounts.find((candidate) => {
      return candidate.provider === message.provider && candidate.address === recipient.address;
    });
    if (!account) continue;
    await store.append<MessageEnvelope>({
      type: "message.received",
      actorAgentId: message.from.contactId,
      payload: {
        ...message,
        accountId: account.id,
        direction: "received",
      },
    });
  }
}

export function createFederationServer(options: FederationServerOptions): Server {
  const store = options.store ?? new JsonlEventStore(options.loadedConfig.stateDir, "federation-events.jsonl");

  return createServer(async (request, response) => {
    try {
      if (options.token) {
        const expected = `Bearer ${options.token}`;
        if (request.headers.authorization !== expected) {
          json(response, 401, { error: "Unauthorized" });
          return;
        }
      }

      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (request.method === "GET" && path === "/health") {
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && path === "/accounts") {
        const events = await store.readAll();
        json(response, 200, [...Object.values(options.loadedConfig.config.accounts), ...accountsFromEvents(events)]);
        return;
      }

      if (request.method === "POST" && path === "/accounts") {
        const body = await readJson(request) as { agentId?: string; name?: string; address?: string };
        if (!body.agentId) throw new Error("agentId is required.");
        const account: AccountConfig = {
          id: body.name ?? `${body.agentId}-federation`,
          provider: "federation",
          address: body.address ?? `federation:${body.agentId}`,
          displayName: body.name ?? body.agentId,
          agents: [body.agentId],
        };
        await store.append<AccountConfig>({
          type: "account.created",
          actorAgentId: body.agentId,
          payload: account,
        });
        json(response, 201, account);
        return;
      }

      if (request.method === "POST" && path === "/messages") {
        const body = await readJson(request) as {
          agentId?: string;
          accountId?: string;
          to?: AddressRef;
          subject?: string;
          text?: string;
          metadata?: Record<string, unknown>;
        };
        if (!body.agentId || !body.accountId || !body.to || !body.text) {
          throw new Error("agentId, accountId, to, and text are required.");
        }
        const events = await store.readAll();
        const account = findAccount(options.loadedConfig, events, body.accountId);
        if (!account) throw new Error(`Unknown account '${body.accountId}'.`);
        const message: MessageEnvelope = {
          id: nanoid(),
          threadId: nanoid(),
          provider: account.provider,
          accountId: account.id,
          from: {
            provider: account.provider,
            accountId: account.id,
            address: account.address,
            displayName: account.displayName,
          },
          to: [body.to],
          subject: body.subject,
          text: body.text,
          createdAt: new Date().toISOString(),
          direction: "sent",
          metadata: body.metadata,
        };
        await store.append<MessageEnvelope>({
          type: "message.sent",
          actorAgentId: body.agentId,
          payload: message,
        });
        await deliver(message, options.loadedConfig, store);
        json(response, 201, message);
        return;
      }

      const mailboxMessagesMatch = path.match(/^\/mailbox\/([^/]+)\/messages$/);
      if (request.method === "GET" && mailboxMessagesMatch) {
        const accountId = decodeURIComponent(mailboxMessagesMatch[1]!);
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const events = await store.readAll();
        json(
          response,
          200,
          messageEvents(events, accountId).filter((message) => message.direction === "received").slice(0, limit),
        );
        return;
      }

      const mailboxThreadsMatch = path.match(/^\/mailbox\/([^/]+)\/threads$/);
      if (request.method === "GET" && mailboxThreadsMatch) {
        const accountId = decodeURIComponent(mailboxThreadsMatch[1]!);
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const events = await store.readAll();
        json(response, 200, threadViews(events, accountId).slice(0, limit));
        return;
      }

      const messageMatch = path.match(/^\/messages\/([^/]+)$/);
      if (request.method === "GET" && messageMatch) {
        const messageId = decodeURIComponent(messageMatch[1]!);
        const events = await store.readAll();
        const message = messageEvents(events).find((candidate) => candidate.id === messageId);
        if (!message) {
          json(response, 404, { error: "Message not found" });
          return;
        }
        json(response, 200, message);
        return;
      }

      const threadMatch = path.match(/^\/threads\/([^/]+)$/);
      if (request.method === "GET" && threadMatch) {
        const threadId = decodeURIComponent(threadMatch[1]!);
        const events = await store.readAll();
        json(response, 200, threadMessages(events, threadId));
        return;
      }

      const replyMatch = path.match(/^\/threads\/([^/]+)\/replies$/);
      if (request.method === "POST" && replyMatch) {
        const threadId = decodeURIComponent(replyMatch[1]!);
        const body = await readJson(request) as {
          agentId?: string;
          accountId?: string;
          text?: string;
          metadata?: Record<string, unknown>;
        };
        if (!body.agentId || !body.accountId || !body.text) {
          throw new Error("agentId, accountId, and text are required.");
        }
        const events = await store.readAll();
        const existing = threadMessages(events, threadId);
        if (existing.length === 0) throw new Error(`Thread '${threadId}' was not found.`);
        const account = findAccount(options.loadedConfig, events, body.accountId);
        if (!account) throw new Error(`Unknown account '${body.accountId}'.`);

        const participants = new Map<string, AddressRef>();
        for (const message of existing) {
          participants.set(`${message.from.provider}:${message.from.address}`, message.from);
          for (const recipient of message.to) {
            participants.set(`${recipient.provider}:${recipient.address}`, recipient);
          }
        }
        participants.delete(`${account.provider}:${account.address}`);

        const message: MessageEnvelope = {
          id: nanoid(),
          threadId,
          provider: account.provider,
          accountId: account.id,
          from: {
            provider: account.provider,
            accountId: account.id,
            address: account.address,
            displayName: account.displayName,
          },
          to: [...participants.values()],
          text: body.text,
          createdAt: new Date().toISOString(),
          direction: "sent",
          metadata: body.metadata,
        };
        await store.append<MessageEnvelope>({
          type: "message.sent",
          actorAgentId: body.agentId,
          payload: message,
        });
        await deliver(message, options.loadedConfig, store);
        json(response, 201, message);
        return;
      }

      text(response, 404, "Not found");
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function startFederationServer(options: StartFederationServerOptions): Promise<Server> {
  const server = createFederationServer(options);
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  return server;
}
