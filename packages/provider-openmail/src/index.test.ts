import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlEventStore, type AgentMessageConfig, type LoadedConfig } from "@codebolt/agent-message-core";
import { openMailProvider } from "./index.js";

const requests: Array<{ method: string; path: string; body: unknown; authorization?: string; idempotencyKey?: string }> = [];

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
    openmail: {
      id: "openmail",
      type: "openmail",
      kind: "email",
      auth: { apiKeyEnv: "OPENMAIL_TEST_API_KEY" },
      settings: {},
    },
  },
  accounts: {
    "alice-openmail": {
      id: "alice-openmail",
      provider: "openmail",
      address: "alice@openmail.sh",
      agents: ["alice"],
      settings: { inboxId: "inb_alice" },
    },
  },
  contacts: {
    bob: {
      id: "bob",
      displayName: "Bob",
      handles: [{ id: "bob-openmail", provider: "openmail", address: "bob@example.com", primary: true }],
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
    providerConfig: config.providers.openmail,
  };
}

beforeAll(async () => {
  process.env.OPENMAIL_TEST_API_KEY = "test-key";
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requestBody = await body(request);
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      body: requestBody,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"]?.toString(),
    });

    if (request.method === "POST" && url.pathname === "/v1/inboxes") {
      json(response, 200, { id: "inb_created", email: "created@openmail.sh", mailboxName: "created" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/inboxes/inb_alice/send") {
      json(response, 200, {
        id: "msg_sent",
        threadId: "thr_sent",
        from: "alice@openmail.sh",
        to: ["bob@example.com"],
        subject: "Hello",
        body: "Hi Bob",
        createdAt: "2026-01-01T00:00:00Z",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/inboxes/inb_alice/messages") {
      json(response, 200, {
        messages: [{
          id: "msg_received",
          threadId: "thr_received",
          from: "bob@example.com",
          to: ["alice@openmail.sh"],
          subject: "Re",
          body: "Hi Alice",
          createdAt: "2026-01-01T00:01:00Z",
        }],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/inboxes/inb_alice/threads") {
      json(response, 200, { threads: [{ id: "thr_received", subject: "Re", participants: ["bob@example.com"] }] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/inboxes/inb_alice/threads/thr_received") {
      json(response, 200, {
        id: "thr_received",
        messages: [{ id: "msg_received", threadId: "thr_received", from: "bob@example.com", to: ["alice@openmail.sh"] }],
      });
      return;
    }

    json(response, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  baseUrl = `http://127.0.0.1:${address.port}`;
  config.providers.openmail.settings = { baseUrl };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  delete process.env.OPENMAIL_TEST_API_KEY;
});

describe("openMailProvider", () => {
  it("creates an OpenMail inbox account", async () => {
    const account = await openMailProvider.createAccount!(
      { agentId: "alice", name: "created" },
      context(),
    );

    expect(account).toMatchObject({
      id: "inb_created",
      provider: "openmail",
      address: "created@openmail.sh",
      settings: { inboxId: "inb_created" },
    });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/inboxes",
      authorization: "Bearer test-key",
      body: { mailboxName: "created" },
    });
  });

  it("sends, lists, reads threads, and replies", async () => {
    await expect(
      openMailProvider.sendMessage({ agentId: "alice", accountId: "alice-openmail", to: "bob", subject: "Hello", text: "Hi Bob" }, context()),
    ).resolves.toMatchObject({ id: "msg_sent", threadId: "thr_sent", direction: "sent" });
    expect(requests.at(-1)?.idempotencyKey).toBeTruthy();

    await expect(
      openMailProvider.listMailbox({ agentId: "alice", accountId: "alice-openmail", limit: 5 }, context()),
    ).resolves.toMatchObject([{ id: "msg_received", direction: "received" }]);

    await expect(
      openMailProvider.listThreads({ agentId: "alice", accountId: "alice-openmail" }, context()),
    ).resolves.toMatchObject([{ id: "thr_received" }]);

    await expect(
      openMailProvider.readThread("thr_received", { agentId: "alice", accountId: "alice-openmail" }, context()),
    ).resolves.toMatchObject([{ id: "msg_received", threadId: "thr_received" }]);

    await expect(
      openMailProvider.replyToThread({ agentId: "alice", accountId: "alice-openmail", threadId: "thr_received", text: "Reply" }, context()),
    ).resolves.toMatchObject({ id: "msg_sent", threadId: "thr_sent" });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/inboxes/inb_alice/send",
      body: { threadId: "thr_received", body: "Reply" },
    });
  });
});
