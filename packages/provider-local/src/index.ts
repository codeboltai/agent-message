import { nanoid } from "nanoid";
import {
  messageEvents,
  resolveAccount,
  resolveRecipient,
  threadMessages,
  threadViews,
  type AccountConfig,
  type AddressRef,
  type CreateAccountInput,
  type MailboxQuery,
  type MessageEnvelope,
  type ProviderAdapter,
  type ProviderContext,
  type ReplyToThreadInput,
  type SendMessageInput,
  type SetupResult,
} from "@codebolt/agent-message-core";

function now(): string {
  return new Date().toISOString();
}

function addressForAccount(account: AccountConfig): AddressRef {
  return {
    provider: account.provider,
    accountId: account.id,
    address: account.address,
    displayName: account.displayName,
  };
}

async function deliverToLocalRecipients(
  message: MessageEnvelope,
  context: ProviderContext,
): Promise<void> {
  for (const recipient of message.to) {
    const account = Object.values(context.loadedConfig.config.accounts).find((candidate) => {
      return candidate.provider === message.provider && candidate.address === recipient.address;
    });
    if (!account) continue;

    await context.store.append<MessageEnvelope>({
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

export const localProvider: ProviderAdapter = {
  id: "local",
  type: "local",
  kind: "local",
  capabilities: [
    "createAccount",
    "sendDirect",
    "listMailbox",
    "readMessage",
    "listThreads",
    "readThread",
    "replyThread",
  ],

  async setup(context: ProviderContext): Promise<SetupResult> {
    return {
      provider: context.providerConfig.id,
      message: "The local provider is configured through agent-message.yaml and stores messages in JSONL state.",
      nextSteps: [
        "Add an account with provider: local and address like local:agent-id.",
        "Add contact handles that point to those local addresses.",
      ],
    };
  },

  async createAccount(
    input: CreateAccountInput,
    context: ProviderContext,
  ): Promise<AccountConfig> {
    const id = input.name ?? `${input.agentId}-local`;
    const account: AccountConfig = {
      id,
      provider: context.providerConfig.id,
      address: input.address ?? `local:${input.agentId}`,
      displayName: input.name ?? input.agentId,
      agents: [input.agentId],
    };
    await context.store.append<AccountConfig>({
      type: "account.created",
      actorAgentId: input.agentId,
      payload: account,
    });
    return account;
  },

  async sendMessage(
    input: SendMessageInput,
    context: ProviderContext,
  ): Promise<MessageEnvelope> {
    const recipient = resolveRecipient(context.loadedConfig.config, input.to, input.via);
    const account = resolveAccount(
      context.loadedConfig.config,
      input.agentId,
      input.accountId,
      recipient.provider,
    );
    const createdAt = now();
    const message: MessageEnvelope = {
      id: nanoid(),
      threadId: nanoid(),
      provider: account.provider,
      accountId: account.id,
      from: addressForAccount(account),
      to: [recipient],
      subject: input.subject,
      text: input.text,
      createdAt,
      direction: "sent",
      metadata: input.metadata,
    };

    await context.store.append<MessageEnvelope>({
      type: "message.sent",
      actorAgentId: input.agentId,
      payload: message,
    });
    await deliverToLocalRecipients(message, context);
    return message;
  },

  async listMailbox(
    query: MailboxQuery,
    context: ProviderContext,
  ): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const events = await context.store.readAll();
    return messageEvents(events, account.id)
      .filter((message) => message.direction === "received")
      .slice(0, query.limit ?? 20);
  },

  async readMessage(
    messageId: string,
    query: MailboxQuery,
    context: ProviderContext,
  ): Promise<MessageEnvelope | undefined> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const events = await context.store.readAll();
    return messageEvents(events, account.id).find((message) => message.id === messageId);
  },

  async listThreads(query: MailboxQuery, context: ProviderContext) {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const events = await context.store.readAll();
    return threadViews(events, account.id).slice(0, query.limit ?? 20);
  },

  async readThread(
    threadId: string,
    query: MailboxQuery,
    context: ProviderContext,
  ): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const events = await context.store.readAll();
    return threadMessages(events, threadId, account.id);
  },

  async replyToThread(
    input: ReplyToThreadInput,
    context: ProviderContext,
  ): Promise<MessageEnvelope> {
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId);
    const events = await context.store.readAll();
    const existing = threadMessages(events, input.threadId, account.id);
    if (existing.length === 0) throw new Error(`Thread '${input.threadId}' was not found.`);

    const participants = new Map<string, AddressRef>();
    for (const message of existing) {
      participants.set(`${message.from.provider}:${message.from.address}`, message.from);
      for (const recipient of message.to) {
        participants.set(`${recipient.provider}:${recipient.address}`, recipient);
      }
    }
    participants.delete(`${account.provider}:${account.address}`);
    const recipients = [...participants.values()];
    if (recipients.length === 0) throw new Error(`Thread '${input.threadId}' has no reply recipient.`);

    const message: MessageEnvelope = {
      id: nanoid(),
      threadId: input.threadId,
      provider: account.provider,
      accountId: account.id,
      from: addressForAccount(account),
      to: recipients,
      text: input.text,
      createdAt: now(),
      direction: "sent",
      metadata: input.metadata,
    };

    await context.store.append<MessageEnvelope>({
      type: "message.sent",
      actorAgentId: input.agentId,
      payload: message,
    });
    await deliverToLocalRecipients(message, context);
    return message;
  },
};
