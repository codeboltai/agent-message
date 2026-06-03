import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlEventStore, type AgentMessageConfig, type LoadedConfig } from "@codebolt/agent-message-core";
import { localProvider } from "./index.js";

let stateDir: string;

const config: AgentMessageConfig = {
  defaultAgent: "alice",
  agents: {
    alice: { id: "alice", name: "Alice" },
    bob: { id: "bob", name: "Bob" },
  },
  providers: {
    local: { id: "local", type: "local", kind: "local" },
  },
  accounts: {
    "alice-local": {
      id: "alice-local",
      provider: "local",
      address: "local:alice",
      agents: ["alice"],
    },
    "bob-local": {
      id: "bob-local",
      provider: "local",
      address: "local:bob",
      agents: ["bob"],
    },
  },
  contacts: {
    bob: {
      id: "bob",
      displayName: "Bob",
      handles: [
        {
          id: "bob-local-handle",
          provider: "local",
          address: "local:bob",
          primary: true,
        },
      ],
    },
  },
};

function loadedConfig(): LoadedConfig {
  return {
    path: join(stateDir, "agent-message.yaml"),
    config,
    stateDir,
  };
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "agent-message-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("localProvider", () => {
  it("sends, receives, reads, and replies through shared JSONL state", async () => {
    const store = new JsonlEventStore(stateDir);
    const context = {
      loadedConfig: loadedConfig(),
      store,
      providerConfig: config.providers.local,
    };

    const sent = await localProvider.sendMessage(
      {
        agentId: "alice",
        accountId: "alice-local",
        to: "bob",
        text: "hello",
      },
      context,
    );

    const bobMailbox = await localProvider.listMailbox(
      { agentId: "bob", accountId: "bob-local" },
      context,
    );
    expect(bobMailbox).toHaveLength(1);
    expect(bobMailbox[0]?.threadId).toBe(sent.threadId);

    const reply = await localProvider.replyToThread(
      {
        agentId: "bob",
        accountId: "bob-local",
        threadId: sent.threadId,
        text: "hi alice",
      },
      context,
    );

    expect(reply.threadId).toBe(sent.threadId);
    const aliceMailbox = await localProvider.listMailbox(
      { agentId: "alice", accountId: "alice-local" },
      context,
    );
    expect(aliceMailbox).toHaveLength(1);
    expect(aliceMailbox[0]?.text).toBe("hi alice");
  });
});
