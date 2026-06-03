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

interface AgmailInbox {
  id?: string;
  email?: string;
  address?: string;
  display_name?: string;
  domain?: string;
}

interface AgmailMessage {
  id?: string;
  message_id?: string;
  thread_id?: string;
  from?: string | { address?: string; name?: string };
  from_address?: string;
  to?: unknown;
  subject?: string;
  body?: string;
  text?: string;
  html?: string;
  status?: string;
  created_at?: string;
  received_at?: string;
}

interface AgmailThread {
  id?: string;
  thread_id?: string;
  messages?: AgmailMessage[];
  subject?: string;
  participants?: unknown;
  latest_at?: string;
  updated_at?: string;
  created_at?: string;
}

function baseUrl(context: ProviderContext): string {
  const configured = context.providerConfig.settings?.baseUrl ?? context.providerConfig.settings?.url;
  return (typeof configured === "string" && configured.length > 0
    ? configured
    : "https://api.agmail.ai").replace(/\/$/, "");
}

function apiKey(context: ProviderContext, account?: AccountConfig): string {
  const envName = typeof account?.auth?.apiKeyEnv === "string"
    ? account.auth.apiKeyEnv
    : typeof context.providerConfig.auth?.apiKeyEnv === "string"
    ? context.providerConfig.auth.apiKeyEnv
    : "AGMAIL_API_KEY";
  const value = process.env[envName];
  if (!value) throw new Error(`Missing AGMail API key env var '${envName}'.`);
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
      "user-agent": "agent-message-agmail-provider/0.1.0",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    throw new Error(`AGMail request failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as T;
}

function inboxId(account: AccountConfig): string {
  const configured = account.settings?.inboxId;
  return typeof configured === "string" && configured.length > 0 ? configured : account.id;
}

function localPart(input: CreateAccountInput): string {
  const value = input.address?.split("@")[0] ?? input.name ?? input.agentId;
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

function messageId(message: AgmailMessage): string {
  return message.id ?? message.message_id ?? crypto.randomUUID();
}

function mapMessage(provider: string, account: AccountConfig, message: AgmailMessage): MessageEnvelope {
  const from = message.from_address ? { provider, address: message.from_address } : addressRef(provider, message.from);
  return {
    id: messageId(message),
    threadId: message.thread_id ?? messageId(message),
    provider,
    accountId: account.id,
    from,
    to: addressRefs(provider, message.to),
    subject: message.subject,
    text: message.body ?? message.text ?? message.html,
    createdAt: message.created_at ?? message.received_at ?? new Date().toISOString(),
    direction: message.status === "sent" || from.address === account.address ? "sent" : "received",
    metadata: { agmail: message },
  };
}

function mapThread(provider: string, account: AccountConfig, thread: AgmailThread): ThreadView {
  const messages = thread.messages ?? [];
  return {
    id: thread.id ?? thread.thread_id ?? crypto.randomUUID(),
    provider,
    accountId: account.id,
    messageIds: messages.map((message) => messageId(message)),
    participants: addressRefs(provider, thread.participants),
    subject: thread.subject ?? messages.find((message) => message.subject)?.subject,
    latestAt: thread.latest_at ?? thread.updated_at ?? thread.created_at ?? new Date().toISOString(),
  };
}

function threadsFromMessages(provider: string, account: AccountConfig, messages: MessageEnvelope[]): ThreadView[] {
  const byThread = new Map<string, MessageEnvelope[]>();
  for (const message of messages) {
    byThread.set(message.threadId, [...byThread.get(message.threadId) ?? [], message]);
  }
  return [...byThread.entries()].map(([threadId, threadMessages]) => ({
    id: threadId,
    provider,
    accountId: account.id,
    messageIds: threadMessages.map((message) => message.id),
    participants: threadMessages.flatMap((message) => [message.from, ...message.to]),
    subject: threadMessages.find((message) => message.subject)?.subject,
    latestAt: threadMessages.map((message) => message.createdAt).sort().at(-1) ?? new Date().toISOString(),
  }));
}

export const agmailProvider: ProviderAdapter = {
  id: "agmail",
  type: "agmail",
  kind: "email",
  capabilities: ["createAccount", "sendDirect", "listMailbox", "readMessage", "listThreads", "readThread", "replyThread"],

  async setup(context: ProviderContext): Promise<SetupResult> {
    return {
      provider: context.providerConfig.id,
      message: "AGMail gives agents @agmail.ai inboxes with send, receive, search, and threaded replies.",
      nextSteps: [
        "Set AGMAIL_API_KEY or configure providers.agmail.auth.apiKeyEnv.",
        "Optionally set providers.agmail.settings.domain for custom domains.",
        "Create an inbox with: agent-message accounts create agmail --name support-agent.",
      ],
    };
  },

  async createAccount(input: CreateAccountInput, context: ProviderContext): Promise<AccountConfig> {
    const body: Record<string, string> = {
      username: localPart(input),
    };
    if (input.name) body.display_name = input.name;
    if (typeof context.providerConfig.settings?.domain === "string") body.domain = context.providerConfig.settings.domain;

    const inbox = await request<AgmailInbox>(context, "/v1/inboxes", {
      method: "POST",
      body,
    });
    if (!inbox.id) throw new Error("AGMail create inbox response did not include id.");
    return {
      id: inbox.id,
      provider: context.providerConfig.id,
      address: inbox.email ?? inbox.address ?? input.address ?? inbox.id,
      displayName: inbox.display_name ?? input.name,
      agents: [input.agentId],
      settings: { inboxId: inbox.id },
    };
  },

  async sendMessage(input: SendMessageInput, context: ProviderContext): Promise<MessageEnvelope> {
    const recipient = resolveRecipient(context.loadedConfig.config, input.to, input.via);
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId, recipient.provider);
    const response = await request<AgmailMessage>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/messages`, {
      method: "POST",
      account,
      body: {
        to: recipient.address,
        subject: input.subject,
        body: input.text,
      },
    });
    return mapMessage(context.providerConfig.id, account, {
      ...response,
      from: account.address,
      to: [recipient.address],
      subject: input.subject,
      body: input.text,
      status: response.status ?? "sent",
    });
  },

  async listMailbox(query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/messages`, {
      account,
      query: { limit: query.limit ?? 20 },
    });
    return list<AgmailMessage>(response, ["messages"]).map((message) => mapMessage(context.providerConfig.id, account, message));
  },

  async readMessage(messageIdValue: string, query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope | undefined> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/v1/messages/${encodeURIComponent(messageIdValue)}`, { account });
    return mapMessage(context.providerConfig.id, account, data<AgmailMessage>(response, "message"));
  },

  async listThreads(query: MailboxQuery, context: ProviderContext): Promise<ThreadView[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const messages = await this.listMailbox({ ...query, accountId: account.id }, context);
    return threadsFromMessages(context.providerConfig.id, account, messages);
  },

  async readThread(threadIdValue: string, query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/v1/threads/${encodeURIComponent(threadIdValue)}`, { account });
    const thread = data<AgmailThread>(response, "thread");
    return (thread.messages ?? []).map((message) => mapMessage(context.providerConfig.id, account, message));
  },

  async replyToThread(input: ReplyToThreadInput, context: ProviderContext): Promise<MessageEnvelope> {
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId);
    const messages = await this.readThread(input.threadId, { agentId: input.agentId, accountId: account.id }, context);
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error(`Thread '${input.threadId}' has no message to reply to.`);
    const response = await request<AgmailMessage>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/messages`, {
      method: "POST",
      account,
      body: {
        to: lastMessage.from.address === account.address ? firstString(lastMessage.to) : lastMessage.from.address,
        subject: lastMessage.subject?.startsWith("Re:") ? lastMessage.subject : `Re: ${lastMessage.subject ?? ""}`.trim(),
        body: input.text,
        reply_to_message_id: lastMessage.id,
      },
    });
    return mapMessage(context.providerConfig.id, account, {
      ...response,
      from: account.address,
      body: input.text,
      status: response.status ?? "sent",
    });
  },
};
