import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlEventStore, type AgentMessageConfig, type LoadedConfig } from "@codebolt/agent-message-core";
import { nuntlyProvider } from "./index.js";

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
    nuntly: {
      id: "nuntly",
      type: "nuntly",
      kind: "email",
      auth: { apiKeyEnv: "NUNTLY_TEST_API_KEY" },
      settings: {},
    },
  },
  accounts: {
    "alice-nuntly": {
      id: "alice-nuntly",
      provider: "nuntly",
      address: "alice@example.com",
      agents: ["alice"],
      settings: { inboxId: "ibx_alice" },
    },
  },
  contacts: {
    bob: {
      id: "bob",
      displayName: "Bob",
      handles: [{ id: "bob-nuntly", provider: "nuntly", address: "bob@example.com", primary: true }],
    },
  },
};

function context() {
  return {
    loadedConfig: {
      path: "agent-message.yaml",
      config,
      stateDir: ".",
    } satisfies LoadedConfig,
    store: new JsonlEventStore("."),
    providerConfig: config.providers.nuntly,
  };
}

beforeAll(async () => {
  process.env.NUNTLY_TEST_API_KEY = "test-key";
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requestBody = await body(request);
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      body: requestBody,
      authorization: request.headers.authorization,
    });

    if (request.method === "POST" && url.pathname === "/inboxes") {
      json(response, 200, { data: { id: "ibx_created", address: "created", domainName: "example.com", name: "Created" } });
      return;
    }

    if (request.method === "POST" && url.pathname === "/inboxes/ibx_alice/send") {
      json(response, 200, { data: { id: "imsg_sent", threadId: "thr_sent", messageId: "<imsg_sent@example.com>" } });
      return;
    }

    if (request.method === "GET" && url.pathname === "/messages") {
      json(response, 200, {
        data: [{
          id: "imsg_received",
          inboxId: "ibx_alice",
          threadId: "thr_received",
          from: "bob@example.com",
          to: ["alice@example.com"],
          subject: "Re",
          text: "Hi Alice",
          receivedAt: "2026-01-01T00:01:00Z",
        }],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/messages/imsg_received") {
      json(response, 200, {
        data: {
          id: "imsg_received",
          inboxId: "ibx_alice",
          threadId: "thr_received",
          from: "bob@example.com",
          to: ["alice@example.com"],
          subject: "Re",
          text: "Hi Alice",
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/inboxes/ibx_alice/threads") {
      json(response, 200, { data: [{ id: "thr_received", subject: "Re", messageCount: 1 }] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/threads/thr_received/messages") {
      json(response, 200, {
        data: [{
          id: "imsg_received",
          threadId: "thr_received",
          from: "bob@example.com",
          to: ["alice@example.com"],
          subject: "Re",
          text: "Hi Alice",
        }],
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/messages/imsg_received/reply") {
      json(response, 200, { data: { id: "imsg_reply", threadId: "thr_received", messageId: "<imsg_reply@example.com>" } });
      return;
    }

    json(response, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  baseUrl = `http://127.0.0.1:${address.port}`;
  config.providers.nuntly.settings = { baseUrl };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  delete process.env.NUNTLY_TEST_API_KEY;
});

describe("nuntlyProvider", () => {
  it("creates a Nuntly inbox account", async () => {
    const account = await nuntlyProvider.createAccount!(
      { agentId: "alice", name: "Created", address: "created@example.com" },
      context(),
    );

    expect(account).toMatchObject({
      id: "ibx_created",
      provider: "nuntly",
      address: "created@example.com",
      settings: { inboxId: "ibx_created" },
    });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/inboxes",
      authorization: "Bearer test-key",
      body: { address: "created", agentId: "alice", name: "Created" },
    });
  });

  it("sends, lists, reads messages and threads, and replies", async () => {
    await expect(
      nuntlyProvider.sendMessage({ agentId: "alice", accountId: "alice-nuntly", to: "bob", subject: "Hello", text: "Hi Bob" }, context()),
    ).resolves.toMatchObject({ id: "imsg_sent", threadId: "thr_sent", direction: "sent" });
    expect(requests.at(-1)).toMatchObject({
      path: "/inboxes/ibx_alice/send",
      body: { to: [{ address: "bob@example.com" }], subject: "Hello", text: "Hi Bob" },
    });

    await expect(
      nuntlyProvider.listMailbox({ agentId: "alice", accountId: "alice-nuntly", limit: 5 }, context()),
    ).resolves.toMatchObject([{ id: "imsg_received", direction: "received" }]);

    await expect(
      nuntlyProvider.readMessage("imsg_received", { agentId: "alice", accountId: "alice-nuntly" }, context()),
    ).resolves.toMatchObject({ id: "imsg_received", threadId: "thr_received" });

    await expect(
      nuntlyProvider.listThreads({ agentId: "alice", accountId: "alice-nuntly" }, context()),
    ).resolves.toMatchObject([{ id: "thr_received" }]);

    await expect(
      nuntlyProvider.readThread("thr_received", { agentId: "alice", accountId: "alice-nuntly" }, context()),
    ).resolves.toMatchObject([{ id: "imsg_received", threadId: "thr_received" }]);

    await expect(
      nuntlyProvider.replyToThread({ agentId: "alice", accountId: "alice-nuntly", threadId: "thr_received", text: "Reply" }, context()),
    ).resolves.toMatchObject({ id: "imsg_reply", threadId: "thr_received", direction: "sent" });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/messages/imsg_received/reply",
      body: { text: "Reply", replyAll: true },
    });
  });
});
