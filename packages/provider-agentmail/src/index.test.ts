import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlEventStore, type AgentMessageConfig, type LoadedConfig } from "@codebolt/agent-message-core";
import { agentMailProvider } from "./index.js";

const requests: Array<{ method: string; path: string; body: unknown; authorization?: string }> = [];

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

let server: ReturnType<typeof createServer>;
let baseUrl: string;

const config: AgentMessageConfig = {
  defaultAgent: "alice",
  agents: {
    alice: { id: "alice", name: "Alice" },
  },
  providers: {
    agentmail: {
      id: "agentmail",
      type: "agentmail",
      kind: "email",
      auth: { apiKeyEnv: "AGENTMAIL_TEST_API_KEY" },
      settings: {},
    },
  },
  accounts: {
    "alice-agentmail": {
      id: "alice-agentmail",
      provider: "agentmail",
      address: "alice@example.com",
      agents: ["alice"],
      settings: { inboxId: "inb_alice" },
    },
  },
  contacts: {
    bob: {
      id: "bob",
      displayName: "Bob",
      handles: [
        {
          id: "bob-email",
          provider: "agentmail",
          address: "bob@example.com",
          primary: true,
        },
      ],
    },
  },
};

function loadedConfig(): LoadedConfig {
  return {
    path: "agent-message.yaml",
    config,
    stateDir: ".",
  };
}

beforeAll(async () => {
  process.env.AGENTMAIL_TEST_API_KEY = "test-key";
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requestBody = await body(request);
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      body: requestBody,
      authorization: request.headers.authorization,
    });

    if (request.method === "POST" && url.pathname === "/v0/inboxes") {
      json(response, 200, {
        inbox_id: "inb_created",
        email: "created@example.com",
        display_name: "Created Agent",
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v0/inboxes/inb_alice/messages/send") {
      json(response, 200, {
        message_id: "msg_sent",
        thread_id: "thr_sent",
        from: "alice@example.com",
        to: ["bob@example.com"],
        subject: "Hello",
        text: "Hi Bob",
        sent_timestamp: "2026-01-01T00:00:00Z",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v0/inboxes/inb_alice/messages") {
      json(response, 200, {
        messages: [
          {
            message_id: "msg_received",
            thread_id: "thr_received",
            from: "bob@example.com",
            to: ["alice@example.com"],
            subject: "Re",
            text: "Hi Alice",
            received_timestamp: "2026-01-01T00:01:00Z",
          },
        ],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v0/inboxes/inb_alice/threads") {
      json(response, 200, {
        threads: [
          {
            thread_id: "thr_received",
            last_message_id: "msg_received",
            message_count: 1,
            senders: ["bob@example.com"],
            recipients: ["alice@example.com"],
            timestamp: "2026-01-01T00:01:00Z",
          },
        ],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v0/inboxes/inb_alice/threads/thr_received") {
      json(response, 200, {
        thread_id: "thr_received",
        messages: [
          {
            message_id: "msg_received",
            thread_id: "thr_received",
            from: "bob@example.com",
            to: ["alice@example.com"],
            text: "Hi Alice",
          },
        ],
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v0/inboxes/inb_alice/messages/msg_received/reply") {
      json(response, 200, {
        message_id: "msg_reply",
        thread_id: "thr_received",
        from: "alice@example.com",
        to: ["bob@example.com"],
        text: "Reply",
      });
      return;
    }

    json(response, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  baseUrl = `http://127.0.0.1:${address.port}`;
  config.providers.agentmail.settings = { baseUrl };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  delete process.env.AGENTMAIL_TEST_API_KEY;
});

describe("agentMailProvider", () => {
  it("creates an AgentMail inbox account", async () => {
    const account = await agentMailProvider.createAccount!(
      { agentId: "alice", name: "Created Agent", address: "created@example.com" },
      {
        loadedConfig: loadedConfig(),
        store: new JsonlEventStore("."),
        providerConfig: config.providers.agentmail,
      },
    );

    expect(account).toMatchObject({
      id: "inb_created",
      provider: "agentmail",
      address: "created@example.com",
      settings: { inboxId: "inb_created" },
    });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v0/inboxes",
      authorization: "Bearer test-key",
    });
  });

  it("sends and maps a message", async () => {
    const message = await agentMailProvider.sendMessage(
      {
        agentId: "alice",
        accountId: "alice-agentmail",
        to: "bob",
        subject: "Hello",
        text: "Hi Bob",
      },
      {
        loadedConfig: loadedConfig(),
        store: new JsonlEventStore("."),
        providerConfig: config.providers.agentmail,
      },
    );

    expect(message).toMatchObject({
      id: "msg_sent",
      threadId: "thr_sent",
      provider: "agentmail",
      accountId: "alice-agentmail",
      direction: "sent",
    });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v0/inboxes/inb_alice/messages/send",
      body: {
        to: ["bob@example.com"],
        subject: "Hello",
        text: "Hi Bob",
      },
    });
  });

  it("lists mailbox messages and threads", async () => {
    const context = {
      loadedConfig: loadedConfig(),
      store: new JsonlEventStore("."),
      providerConfig: config.providers.agentmail,
    };

    await expect(
      agentMailProvider.listMailbox({ agentId: "alice", accountId: "alice-agentmail", limit: 5 }, context),
    ).resolves.toMatchObject([{ id: "msg_received", direction: "received" }]);

    await expect(
      agentMailProvider.listThreads({ agentId: "alice", accountId: "alice-agentmail", limit: 5 }, context),
    ).resolves.toMatchObject([{ id: "thr_received", messageIds: [] }]);
  });

  it("reads and replies to a thread", async () => {
    const context = {
      loadedConfig: loadedConfig(),
      store: new JsonlEventStore("."),
      providerConfig: config.providers.agentmail,
    };

    await expect(
      agentMailProvider.readThread("thr_received", { agentId: "alice", accountId: "alice-agentmail" }, context),
    ).resolves.toMatchObject([{ id: "msg_received", threadId: "thr_received" }]);

    await expect(
      agentMailProvider.replyToThread(
        { agentId: "alice", accountId: "alice-agentmail", threadId: "thr_received", text: "Reply" },
        context,
      ),
    ).resolves.toMatchObject({ id: "msg_reply", threadId: "thr_received" });
  });
});
