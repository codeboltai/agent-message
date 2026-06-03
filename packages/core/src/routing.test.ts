import { describe, expect, it } from "vitest";
import { resolveActiveAgent, resolveRecipient } from "./index.js";
import type { AgentMessageConfig } from "./types.js";

const config: AgentMessageConfig = {
  defaultAgent: "alice",
  agents: {
    alice: { id: "alice", name: "Alice" },
  },
  providers: {
    local: { id: "local", type: "local", kind: "local" },
  },
  accounts: {},
  contacts: {
    bob: {
      id: "bob",
      displayName: "Bob",
      handles: [
        {
          id: "bob-local",
          provider: "local",
          address: "local:bob",
          primary: true,
        },
      ],
    },
  },
};

describe("routing", () => {
  it("resolves the default active agent", () => {
    expect(resolveActiveAgent(config)).toBe("alice");
  });

  it("resolves a contact to its primary handle", () => {
    expect(resolveRecipient(config, "bob")).toMatchObject({
      provider: "local",
      address: "local:bob",
      contactId: "bob",
      handleId: "bob-local",
    });
  });

  it("requires an explicit provider for raw addresses", () => {
    expect(() => resolveRecipient(config, "local:bob")).toThrow("requires --via");
  });
});
