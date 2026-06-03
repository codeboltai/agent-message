import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlEventStore, type AgentMessageConfig, type LoadedConfig } from "@codebolt/agent-message-core";
import { agmailProvider } from "./index.js";

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

const config: AgentMessageConfig = {
  defaultAgent: "alice",
  agents: { alice: { id: "alice", name: "Alice" } },
  providers: {
    agmail: { id: "agmail", type: "agmail", kind: "email", auth: { apiKeyEnv: "AGMAIL_TEST_API_KEY" }, settings: {} },
  },
  accounts: {
    "alice-agmail": {
      id: "alice-agmail",
      provider: "agmail",
      address: "alice@agmail.ai",
      agents: ["alice"],
      settings: { inboxId: "inb_alice" },
    },
  },
  contacts: {
    bob: {
      id: "bob",
      displayName: "Bob",
      handles: [{ id: "bob-agmail", provider: "agmail", address: "bob@example.com", primary: true }],
    },
  },
};

function context() {
  return {
    loadedConfig: { path: "agent-message.yaml", config, stateDir: "." } satisfies LoadedConfig,
    store: new JsonlEventStore("."),
    providerConfig: config.providers.agmail,
  };
}

beforeAll(async () => {
  process.env.AGMAIL_TEST_API_KEY = "test-key";
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requestBody = await body(request);
    requests.push({ method: request.method ?? "GET", path: url.pathname, body: requestBody, authorization: request.headers.authorization });

    if (request.method === "POST" && url.pathname === "/v1/inboxes") {
      json(response, 201, { id: "inb_created", email: "created@agmail.ai", display_name: "Created Agent" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/inboxes/inb_alice/messages") {
      json(response, 201, { id: "msg_sent", thread_id: "thr_sent", status: "sent" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/inboxes/inb_alice/messages") {
      json(response, 200, {
        messages: [{ id: "msg_received", thread_id: "thr_received", from: "bob@example.com", to: ["alice@agmail.ai"], subject: "Re: Hello", body: "Hi" }],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/messages/msg_received") {
      json(response, 200, { message: { id: "msg_received", thread_id: "thr_received", from: "bob@example.com", to: ["alice@agmail.ai"] } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/threads/thr_received") {
      json(response, 200, {
        thread: {
          id: "thr_received",
          messages: [{ id: "msg_received", thread_id: "thr_received", from: "bob@example.com", to: ["alice@agmail.ai"], subject: "Re: Hello" }],
        },
      });
      return;
    }
    json(response, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  config.providers.agmail.settings = { baseUrl: `http://127.0.0.1:${address.port}` };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  delete process.env.AGMAIL_TEST_API_KEY;
});

describe("agmailProvider", () => {
  it("creates an AGMail inbox account", async () => {
    const account = await agmailProvider.createAccount!({ agentId: "alice", name: "Created Agent", address: "created@agmail.ai" }, context());

    expect(account).toMatchObject({ id: "inb_created", provider: "agmail", address: "created@agmail.ai", settings: { inboxId: "inb_created" } });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/inboxes",
      authorization: "Bearer test-key",
      body: { username: "created", display_name: "Created Agent" },
    });
  });

  it("handles the standard message and thread operations", async () => {
    await expect(
      agmailProvider.sendMessage({ agentId: "alice", accountId: "alice-agmail", to: "bob", subject: "Hello", text: "Hi Bob" }, context()),
    ).resolves.toMatchObject({ id: "msg_sent", threadId: "thr_sent", direction: "sent" });

    await expect(
      agmailProvider.listMailbox({ agentId: "alice", accountId: "alice-agmail", limit: 5 }, context()),
    ).resolves.toMatchObject([{ id: "msg_received", threadId: "thr_received", direction: "received" }]);

    await expect(
      agmailProvider.readMessage("msg_received", { agentId: "alice", accountId: "alice-agmail" }, context()),
    ).resolves.toMatchObject({ id: "msg_received", threadId: "thr_received" });

    await expect(
      agmailProvider.listThreads({ agentId: "alice", accountId: "alice-agmail" }, context()),
    ).resolves.toMatchObject([{ id: "thr_received", messageIds: ["msg_received"] }]);

    await expect(
      agmailProvider.readThread("thr_received", { agentId: "alice", accountId: "alice-agmail" }, context()),
    ).resolves.toMatchObject([{ id: "msg_received", threadId: "thr_received" }]);

    await expect(
      agmailProvider.replyToThread({ agentId: "alice", accountId: "alice-agmail", threadId: "thr_received", text: "Reply" }, context()),
    ).resolves.toMatchObject({ id: "msg_sent", direction: "sent" });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/inboxes/inb_alice/messages",
      body: { to: "bob@example.com", subject: "Re: Hello", body: "Reply", reply_to_message_id: "msg_received" },
    });
  });
});
