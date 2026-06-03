import {
  resolveAccount,
  resolveRecipient,
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
  type ThreadView,
} from "@codebolt/agent-message-core";

interface RobotomailMailbox {
  id?: string;
  fullAddress?: string;
  address?: string;
  displayName?: string;
  name?: string;
}

interface RobotomailMessage {
  id?: string;
  messageId?: string;
  threadId?: string;
  direction?: string;
  fromAddress?: string;
  from?: string;
  toAddresses?: unknown;
  to?: unknown;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  text?: string;
  status?: string;
  createdAt?: string;
  receivedAt?: string;
  sentAt?: string;
  inReplyTo?: string;
}

interface RobotomailThread {
  id?: string;
  threadId?: string;
  subject?: string;
  messages?: RobotomailMessage[];
  messageIds?: string[];
  participants?: unknown;
  createdAt?: string;
  updatedAt?: string;
  lastMessageAt?: string;
}

function baseUrl(context: ProviderContext): string {
  const configured = context.providerConfig.settings?.baseUrl ?? context.providerConfig.settings?.url;
  return (typeof configured === "string" && configured.length > 0
    ? configured
    : "https://api.robotomail.com").replace(/\/$/, "");
}

function apiKey(context: ProviderContext, account?: AccountConfig): string {
  const envName = typeof account?.auth?.apiKeyEnv === "string"
    ? account.auth.apiKeyEnv
    : typeof context.providerConfig.auth?.apiKeyEnv === "string"
    ? context.providerConfig.auth.apiKeyEnv
    : "ROBOTOMAIL_API_KEY";
  const value = process.env[envName];
  if (!value) throw new Error(`Missing Robotomail API key env var '${envName}'.`);
  return value;
}

async function request<T>(
  context: ProviderContext,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    account?: AccountConfig;
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<T> {
  const url = new URL(`${baseUrl(context)}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${apiKey(context, options.account)}`,
      "content-type": "application/json",
      "user-agent": "agent-message-robotomail-provider/0.1.0",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    throw new Error(`Robotomail request failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as T;
}

function mailboxId(account: AccountConfig): string {
  const configured = account.settings?.mailboxId;
  return typeof configured === "string" && configured.length > 0 ? configured : account.id;
}

function localPart(input: CreateAccountInput): string {
  const address = input.address?.split("@")[0];
  const value = address ?? input.name ?? input.agentId;
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || input.agentId;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstString(value[0]);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return firstString(object.address) ?? firstString(object.email) ?? firstString(object.value);
  }
  return undefined;
}

function addressRef(provider: string, value: unknown): AddressRef {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    return {
      provider,
      address: firstString(object.address) ?? firstString(object.email) ?? "unknown",
      displayName: firstString(object.name),
    };
  }
  return { provider, address: firstString(value) ?? "unknown" };
}

function addressRefs(provider: string, value: unknown): AddressRef[] {
  if (Array.isArray(value)) return value.map((item) => addressRef(provider, item));
  const address = firstString(value);
  return address ? [{ provider, address }] : [];
}

function data<T>(response: unknown, key: string): T {
  if (response && typeof response === "object") {
    const object = response as Record<string, unknown>;
    if (object[key] && typeof object[key] === "object") return object[key] as T;
    if (object.data && typeof object.data === "object") return object.data as T;
  }
  return response as T;
}

function list<T>(response: unknown, keys: string[]): T[] {
  if (Array.isArray(response)) return response as T[];
  if (response && typeof response === "object") {
    const object = response as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(object[key])) return object[key] as T[];
    }
    if (Array.isArray(object.data)) return object.data as T[];
    if (Array.isArray(object.items)) return object.items as T[];
  }
  return [];
}

function messageId(message: RobotomailMessage): string {
  return message.id ?? message.messageId ?? crypto.randomUUID();
}

function mapMessage(provider: string, account: AccountConfig, message: RobotomailMessage): MessageEnvelope {
  const from = message.fromAddress ? { provider, address: message.fromAddress } : addressRef(provider, message.from);
  return {
    id: messageId(message),
    threadId: message.threadId ?? message.inReplyTo ?? messageId(message),
    provider,
    accountId: account.id,
    from,
    to: addressRefs(provider, message.toAddresses ?? message.to),
    subject: message.subject,
    text: message.bodyText ?? message.text,
    createdAt: message.createdAt ?? message.receivedAt ?? message.sentAt ?? new Date().toISOString(),
    direction: message.direction === "OUTBOUND" || from.address === account.address ? "sent" : "received",
    metadata: { robotomail: message },
  };
}

function mapThread(provider: string, account: AccountConfig, thread: RobotomailThread): ThreadView {
  const messages = thread.messages ?? [];
  return {
    id: thread.id ?? thread.threadId ?? crypto.randomUUID(),
    provider,
    accountId: account.id,
    messageIds: thread.messageIds ?? messages.map((message) => messageId(message)),
    participants: addressRefs(provider, thread.participants),
    subject: thread.subject,
    latestAt: thread.lastMessageAt ?? thread.updatedAt ?? thread.createdAt ?? new Date().toISOString(),
  };
}

export const robotomailProvider: ProviderAdapter = {
  id: "robotomail",
  type: "robotomail",
  kind: "email",
  capabilities: ["createAccount", "sendDirect", "listMailbox", "readMessage", "listThreads", "readThread", "replyThread"],

  async setup(context: ProviderContext): Promise<SetupResult> {
    return {
      provider: context.providerConfig.id,
      message: "Robotomail provisions real API-controlled mailboxes for AI agents.",
      nextSteps: [
        "Set ROBOTOMAIL_API_KEY or configure providers.robotomail.auth.apiKeyEnv.",
        "Optionally set providers.robotomail.settings.domainId, defaulting to dom_platform.",
        "Create a mailbox with: agent-message accounts create robotomail --name support-agent.",
      ],
    };
  },

  async createAccount(input: CreateAccountInput, context: ProviderContext): Promise<AccountConfig> {
    const domainId = typeof context.providerConfig.settings?.domainId === "string"
      ? context.providerConfig.settings.domainId
      : "dom_platform";
    const response = await request<unknown>(context, "/v1/mailboxes", {
      method: "POST",
      body: {
        address: localPart(input),
        domainId,
      },
    });
    const mailbox = data<RobotomailMailbox>(response, "mailbox");
    if (!mailbox.id) throw new Error("Robotomail create mailbox response did not include id.");
    return {
      id: mailbox.id,
      provider: context.providerConfig.id,
      address: mailbox.fullAddress ?? mailbox.address ?? input.address ?? mailbox.id,
      displayName: mailbox.displayName ?? mailbox.name ?? input.name,
      agents: [input.agentId],
      settings: { mailboxId: mailbox.id },
    };
  },

  async sendMessage(input: SendMessageInput, context: ProviderContext): Promise<MessageEnvelope> {
    const recipient = resolveRecipient(context.loadedConfig.config, input.to, input.via);
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId, recipient.provider);
    const response = await request<unknown>(context, `/v1/mailboxes/${encodeURIComponent(mailboxId(account))}/messages`, {
      method: "POST",
      account,
      body: {
        to: [recipient.address],
        subject: input.subject,
        bodyText: input.text,
      },
    });
    return mapMessage(context.providerConfig.id, account, data<RobotomailMessage>(response, "message"));
  },

  async listMailbox(query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/v1/mailboxes/${encodeURIComponent(mailboxId(account))}/messages`, {
      account,
      query: { direction: "INBOUND", limit: query.limit ?? 20 },
    });
    return list<RobotomailMessage>(response, ["messages"]).map((message) => {
      return mapMessage(context.providerConfig.id, account, message);
    });
  },

  async readMessage(messageIdValue: string, query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope | undefined> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(
      context,
      `/v1/mailboxes/${encodeURIComponent(mailboxId(account))}/messages/${encodeURIComponent(messageIdValue)}`,
      { account },
    );
    return mapMessage(context.providerConfig.id, account, data<RobotomailMessage>(response, "message"));
  },

  async listThreads(query: MailboxQuery, context: ProviderContext): Promise<ThreadView[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/v1/mailboxes/${encodeURIComponent(mailboxId(account))}/threads`, {
      account,
      query: { limit: query.limit ?? 20 },
    });
    return list<RobotomailThread>(response, ["threads"]).map((thread) => {
      return mapThread(context.providerConfig.id, account, thread);
    });
  },

  async readThread(threadIdValue: string, query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(
      context,
      `/v1/mailboxes/${encodeURIComponent(mailboxId(account))}/threads/${encodeURIComponent(threadIdValue)}`,
      { account },
    );
    const thread = data<RobotomailThread>(response, "thread");
    return (thread.messages ?? []).map((message) => mapMessage(context.providerConfig.id, account, message));
  },

  async replyToThread(input: ReplyToThreadInput, context: ProviderContext): Promise<MessageEnvelope> {
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId);
    const messages = await this.readThread(input.threadId, { agentId: input.agentId, accountId: account.id }, context);
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error(`Thread '${input.threadId}' has no message to reply to.`);
    const response = await request<unknown>(context, `/v1/mailboxes/${encodeURIComponent(mailboxId(account))}/messages`, {
      method: "POST",
      account,
      body: {
        to: lastMessage.from.address === account.address ? lastMessage.to.map((recipient) => recipient.address) : [lastMessage.from.address],
        subject: lastMessage.subject?.startsWith("Re:") ? lastMessage.subject : `Re: ${lastMessage.subject ?? ""}`.trim(),
        bodyText: input.text,
        inReplyTo: lastMessage.metadata?.robotomail &&
          typeof lastMessage.metadata.robotomail === "object" &&
          "messageId" in lastMessage.metadata.robotomail
          ? (lastMessage.metadata.robotomail as RobotomailMessage).messageId
          : lastMessage.id,
      },
    });
    return mapMessage(context.providerConfig.id, account, data<RobotomailMessage>(response, "message"));
  },
};
