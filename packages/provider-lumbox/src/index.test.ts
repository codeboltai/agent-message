import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlEventStore, type AgentMessageConfig, type LoadedConfig } from "@codebolt/agent-message-core";
import { lumboxProvider } from "./index.js";

const requests: Array<{ method: string; path: string; body: unknown; authorization?: string; apiKey?: string }> = [];

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
    lumbox: { id: "lumbox", type: "lumbox", kind: "email", auth: { apiKeyEnv: "LUMBOX_TEST_API_KEY" }, settings: {} },
  },
  accounts: {
    "alice-lumbox": {
      id: "alice-lumbox",
      provider: "lumbox",
      address: "alice@lumbox.co",
      agents: ["alice"],
      settings: { inboxId: "lum_alice" },
    },
  },
  contacts: {
    bob: {
      id: "bob",
      displayName: "Bob",
      handles: [{ id: "bob-lumbox", provider: "lumbox", address: "bob@example.com", primary: true }],
    },
  },
};

function context() {
  return {
    loadedConfig: { path: "agent-message.yaml", config, stateDir: "." } satisfies LoadedConfig,
    store: new JsonlEventStore("."),
    providerConfig: config.providers.lumbox,
  };
}

beforeAll(async () => {
  process.env.LUMBOX_TEST_API_KEY = "test-key";
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requestBody = await body(request);
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      body: requestBody,
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"]?.toString(),
    });

    if (request.method === "POST" && url.pathname === "/v1/inboxes") {
      json(response, 200, { inbox: { id: "lum_created", email: "created@lumbox.co", name: "Created Agent" } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/inboxes/lum_alice/send") {
      json(response, 200, { message: { id: "msg_sent", threadId: "thr_sent" } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/inboxes/lum_alice/messages") {
      json(response, 200, {
        messages: [{ id: "msg_received", threadId: "thr_received", from: "bob@example.com", to: ["alice@lumbox.co"], subject: "Re", text: "Hi" }],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/inboxes/lum_alice/messages/msg_received") {
      json(response, 200, { message: { id: "msg_received", threadId: "thr_received", from: "bob@example.com", to: ["alice@lumbox.co"] } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/inboxes/lum_alice/threads") {
      json(response, 200, { threads: [{ id: "thr_received", subject: "Re", messages: [{ id: "msg_received" }] }] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/threads/thr_received") {
      json(response, 200, {
        thread: {
          id: "thr_received",
          messages: [{ id: "msg_received", threadId: "thr_received", from: "bob@example.com", to: ["alice@lumbox.co"], subject: "Re" }],
        },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/inboxes/lum_alice/reply") {
      json(response, 200, { message: { id: "msg_reply", threadId: "thr_received" } });
      return;
    }
    json(response, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  config.providers.lumbox.settings = { baseUrl: `http://127.0.0.1:${address.port}` };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  delete process.env.LUMBOX_TEST_API_KEY;
});

describe("lumboxProvider", () => {
  it("creates a Lumbox inbox account", async () => {
    const account = await lumboxProvider.createAccount!({ agentId: "alice", name: "Created Agent", address: "created@lumbox.co" }, context());

    expect(account).toMatchObject({ id: "lum_created", provider: "lumbox", address: "created@lumbox.co", settings: { inboxId: "lum_created" } });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/inboxes",
      authorization: "Bearer test-key",
      apiKey: "test-key",
      body: { username: "created", name: "Created Agent" },
    });
  });

  it("handles the standard message and thread operations", async () => {
    await expect(
      lumboxProvider.sendMessage({ agentId: "alice", accountId: "alice-lumbox", to: "bob", subject: "Hello", text: "Hi Bob" }, context()),
    ).resolves.toMatchObject({ id: "msg_sent", threadId: "thr_sent", direction: "sent" });

    await expect(
      lumboxProvider.listMailbox({ agentId: "alice", accountId: "alice-lumbox", limit: 5 }, context()),
    ).resolves.toMatchObject([{ id: "msg_received", threadId: "thr_received", direction: "received" }]);

    await expect(
      lumboxProvider.readMessage("msg_received", { agentId: "alice", accountId: "alice-lumbox" }, context()),
    ).resolves.toMatchObject({ id: "msg_received", threadId: "thr_received" });

    await expect(
      lumboxProvider.listThreads({ agentId: "alice", accountId: "alice-lumbox" }, context()),
    ).resolves.toMatchObject([{ id: "thr_received", messageIds: ["msg_received"] }]);

    await expect(
      lumboxProvider.readThread("thr_received", { agentId: "alice", accountId: "alice-lumbox" }, context()),
    ).resolves.toMatchObject([{ id: "msg_received", threadId: "thr_received" }]);

    await expect(
      lumboxProvider.replyToThread({ agentId: "alice", accountId: "alice-lumbox", threadId: "thr_received", text: "Reply" }, context()),
    ).resolves.toMatchObject({ id: "msg_reply", threadId: "thr_received", direction: "sent" });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/inboxes/lum_alice/reply",
      body: { messageId: "msg_received", threadId: "thr_received", text: "Reply" },
    });
  });
});
