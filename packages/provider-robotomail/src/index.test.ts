import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlEventStore, type AgentMessageConfig, type LoadedConfig } from "@codebolt/agent-message-core";
import { robotomailProvider } from "./index.js";

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
    robotomail: {
      id: "robotomail",
      type: "robotomail",
      kind: "email",
      auth: { apiKeyEnv: "ROBOTOMAIL_TEST_API_KEY" },
      settings: {},
    },
  },
  accounts: {
    "alice-robotomail": {
      id: "alice-robotomail",
      provider: "robotomail",
      address: "alice@robotomail.co",
      agents: ["alice"],
      settings: { mailboxId: "mbx_alice" },
    },
  },
  contacts: {
    bob: {
      id: "bob",
      displayName: "Bob",
      handles: [{ id: "bob-robotomail", provider: "robotomail", address: "bob@example.com", primary: true }],
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
    providerConfig: config.providers.robotomail,
  };
}

beforeAll(async () => {
  process.env.ROBOTOMAIL_TEST_API_KEY = "test-key";
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requestBody = await body(request);
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      body: requestBody,
      authorization: request.headers.authorization,
    });

    if (request.method === "POST" && url.pathname === "/v1/mailboxes") {
      json(response, 201, { mailbox: { id: "mbx_created", fullAddress: "created@robotomail.co" } });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/mailboxes/mbx_alice/messages") {
      json(response, 201, {
        message: {
          id: "msg_sent",
          direction: "OUTBOUND",
          fromAddress: "alice@robotomail.co",
          toAddresses: ["bob@example.com"],
          subject: "Hello",
          bodyText: "Hi Bob",
          threadId: "thr_sent",
          createdAt: "2026-01-01T00:00:00Z",
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/mailboxes/mbx_alice/messages") {
      json(response, 200, {
        messages: [{
          id: "msg_received",
          messageId: "<msg_received@example.com>",
          direction: "INBOUND",
          fromAddress: "bob@example.com",
          toAddresses: ["alice@robotomail.co"],
          subject: "Re: Hello",
          bodyText: "Hi Alice",
          threadId: "thr_received",
          createdAt: "2026-01-01T00:01:00Z",
        }],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/mailboxes/mbx_alice/threads") {
      json(response, 200, { threads: [{ id: "thr_received", subject: "Re: Hello", messageIds: ["msg_received"] }] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/mailboxes/mbx_alice/threads/thr_received") {
      json(response, 200, {
        thread: {
          id: "thr_received",
          messages: [{
            id: "msg_received",
            messageId: "<msg_received@example.com>",
            fromAddress: "bob@example.com",
            toAddresses: ["alice@robotomail.co"],
            threadId: "thr_received",
            subject: "Re: Hello",
          }],
        },
      });
      return;
    }

    json(response, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  baseUrl = `http://127.0.0.1:${address.port}`;
  config.providers.robotomail.settings = { baseUrl };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  delete process.env.ROBOTOMAIL_TEST_API_KEY;
});

describe("robotomailProvider", () => {
  it("creates a Robotomail mailbox account", async () => {
    const account = await robotomailProvider.createAccount!(
      { agentId: "alice", name: "Created Agent", address: "created@robotomail.co" },
      context(),
    );

    expect(account).toMatchObject({
      id: "mbx_created",
      provider: "robotomail",
      address: "created@robotomail.co",
      settings: { mailboxId: "mbx_created" },
    });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/mailboxes",
      authorization: "Bearer test-key",
      body: { address: "created", domainId: "dom_platform" },
    });
  });

  it("sends, lists, reads threads, and replies", async () => {
    await expect(
      robotomailProvider.sendMessage({ agentId: "alice", accountId: "alice-robotomail", to: "bob", subject: "Hello", text: "Hi Bob" }, context()),
    ).resolves.toMatchObject({ id: "msg_sent", threadId: "thr_sent", direction: "sent" });

    await expect(
      robotomailProvider.listMailbox({ agentId: "alice", accountId: "alice-robotomail", limit: 5 }, context()),
    ).resolves.toMatchObject([{ id: "msg_received", direction: "received" }]);

    await expect(
      robotomailProvider.listThreads({ agentId: "alice", accountId: "alice-robotomail" }, context()),
    ).resolves.toMatchObject([{ id: "thr_received", messageIds: ["msg_received"] }]);

    await expect(
      robotomailProvider.readThread("thr_received", { agentId: "alice", accountId: "alice-robotomail" }, context()),
    ).resolves.toMatchObject([{ id: "msg_received", threadId: "thr_received" }]);

    await expect(
      robotomailProvider.replyToThread({ agentId: "alice", accountId: "alice-robotomail", threadId: "thr_received", text: "Reply" }, context()),
    ).resolves.toMatchObject({ id: "msg_sent", threadId: "thr_sent" });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/mailboxes/mbx_alice/messages",
      body: {
        to: ["bob@example.com"],
        subject: "Re: Hello",
        bodyText: "Reply",
        inReplyTo: "<msg_received@example.com>",
      },
    });
  });
});
