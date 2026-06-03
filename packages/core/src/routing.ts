import type {
  AccountConfig,
  AddressRef,
  AgentMessageConfig,
  ContactConfig,
  ContactHandle,
} from "./types.js";

export function resolveActiveAgent(config: AgentMessageConfig, explicitAgent?: string): string {
  const agentId = explicitAgent ?? process.env.AGENT_MESSAGE_AGENT_ID ?? config.defaultAgent;
  if (!agentId) throw new Error("No active agent. Pass --agent or set defaultAgent in config.");
  if (!config.agents[agentId]) throw new Error(`Agent '${agentId}' is not configured.`);
  return agentId;
}

export function accountUsableByAgent(account: AccountConfig, agentId: string): boolean {
  return !account.agents || account.agents.length === 0 || account.agents.includes(agentId);
}

export function resolveAccount(
  config: AgentMessageConfig,
  agentId: string,
  accountId?: string,
  provider?: string,
): AccountConfig {
  if (accountId) {
    const account = config.accounts[accountId];
    if (!account) throw new Error(`Account '${accountId}' is not configured.`);
    if (!accountUsableByAgent(account, agentId)) {
      throw new Error(`Agent '${agentId}' cannot use account '${accountId}'.`);
    }
    return account;
  }

  const candidates = Object.values(config.accounts).filter((account) => {
    return accountUsableByAgent(account, agentId) && (!provider || account.provider === provider);
  });

  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) throw new Error(`No usable account found for agent '${agentId}'.`);
  throw new Error(
    `Multiple usable accounts found for agent '${agentId}'. Pass --account. Choices: ${
      candidates.map((account) => account.id).join(", ")
    }`,
  );
}

export function findContact(config: AgentMessageConfig, token: string): ContactConfig | undefined {
  return config.contacts[token] ??
    Object.values(config.contacts).find((contact) => {
      return contact.displayName.toLowerCase() === token.toLowerCase();
    });
}

export function resolveContactHandle(
  contact: ContactConfig,
  via?: string,
): ContactHandle {
  if (via) {
    const match = contact.handles.find((handle) => {
      return handle.id === via || handle.provider === via || `${handle.provider}:${handle.address}` === via;
    });
    if (!match) {
      throw new Error(
        `Contact '${contact.id}' has no handle for '${via}'. Choices: ${
          contact.handles.map((handle) => `${handle.id} (${handle.provider}:${handle.address})`).join(", ")
        }`,
      );
    }
    return match;
  }

  const primary = contact.handles.find((handle) => handle.primary);
  if (primary) return primary;
  if (contact.handles.length === 1) return contact.handles[0]!;
  throw new Error(
    `Contact '${contact.id}' needs --via. Choices: ${
      contact.handles.map((handle) => `${handle.id} (${handle.provider}:${handle.address})`).join(", ")
    }`,
  );
}

export function resolveRecipient(
  config: AgentMessageConfig,
  token: string,
  via?: string,
): AddressRef {
  const contact = findContact(config, token);
  if (contact) {
    const handle = resolveContactHandle(contact, via);
    return {
      provider: handle.provider,
      address: handle.address,
      accountId: handle.accountId,
      contactId: contact.id,
      handleId: handle.id,
      displayName: contact.displayName,
    };
  }

  if (!via) {
    throw new Error(`Raw address '${token}' requires --via <provider>.`);
  }

  return {
    provider: via,
    address: token,
  };
}
