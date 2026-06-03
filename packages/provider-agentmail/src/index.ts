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

interface AgentMailInbox {
  inbox_id?: string;
  id?: string;
  email?: string;
  address?: string;
  display_name?: string;
  created_at?: string;
  updated_at?: string;
}

interface AgentMailMessage {
  message_id?: string;
  id?: string;
  thread_id?: string;
  inbox_id?: string;
  from?: string | { email?: string; address?: string; name?: string };
  to?: unknown;
  recipients?: unknown;
  subject?: string;
  text?: string;
  text_preview?: string;
  html?: string;
  timestamp?: string;
  received_timestamp?: string;
  sent_timestamp?: string;
  created_at?: string;
  direction?: string;
  in_reply_to?: string;
}

interface AgentMailThread {
  thread_id?: string;
  id?: string;
  inbox_id?: string;
  messages?: AgentMailMessage[];
  senders?: unknown;
  recipients?: unknown;
  subject?: string;
  last_message_id?: string;
  message_count?: number;
  timestamp?: string;
  received_timestamp?: string;
  sent_timestamp?: string;
}

function configuredBaseUrl(context: ProviderContext): string {
  const configured = context.providerConfig.settings?.baseUrl ?? context.providerConfig.settings?.url;
  const baseUrl = typeof configured === "string" && configured.length > 0
    ? configured
    : "https://api.agentmail.to";
  return baseUrl.replace(/\/$/, "").replace(/\/v0$/, "");
}

function apiKey(context: ProviderContext, account?: AccountConfig): string {
  const accountEnv = account?.auth?.apiKeyEnv;
  const providerEnv = context.providerConfig.auth?.apiKeyEnv;
  const envName = typeof accountEnv === "string"
    ? accountEnv
    : typeof providerEnv === "string"
    ? providerEnv
    : "AGENTMAIL_API_KEY";
  const value = process.env[envName];
  if (!value) throw new Error(`Missing AgentMail API key env var '${envName}'.`);
  return value;
}

async function request<T>(
  context: ProviderContext,
  path: string,
  options: { method?: string; body?: unknown; account?: AccountConfig; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const url = new URL(`${configuredBaseUrl(context)}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${apiKey(context, options.account)}`,
      "content-type": "application/json",
      "user-agent": "agent-message-agentmail-provider/0.1.0",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    throw new Error(`AgentMail request failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as T;
}

function inboxId(account: AccountConfig): string {
  const configured = account.settings?.inboxId;
  return typeof configured === "string" && configured.length > 0 ? configured : account.id;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstString(value[0]);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return firstString(object.email) ?? firstString(object.address) ?? firstString(object.value);
  }
  return undefined;
}

function addressRef(provider: string, value: unknown): AddressRef {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    return {
      provider,
      address: firstString(object.email) ?? firstString(object.address) ?? "unknown",
      displayName: firstString(object.name) ?? firstString(object.display_name),
    };
  }
  return {
    provider,
    address: firstString(value) ?? "unknown",
  };
}

function addressRefs(provider: string, value: unknown): AddressRef[] {
  if (Array.isArray(value)) return value.map((item) => addressRef(provider, item));
  const single = firstString(value);
  return single ? [{ provider, address: single }] : [];
}

function messageId(message: AgentMailMessage): string {
  return message.message_id ?? message.id ?? crypto.randomUUID();
}

function threadId(message: AgentMailMessage): string {
  return message.thread_id ?? message.in_reply_to ?? messageId(message);
}

function timestamp(message: AgentMailMessage): string {
  return message.timestamp ??
    message.received_timestamp ??
    message.sent_timestamp ??
    message.created_at ??
    new Date().toISOString();
}

function mapMessage(
  provider: string,
  account: AccountConfig,
  message: AgentMailMessage,
): MessageEnvelope {
  const from = message.from === undefined
    ? { provider, address: "unknown" }
    : addressRef(provider, message.from);
  const to = addressRefs(provider, message.to ?? message.recipients);
  const direction = from.address === account.address ? "sent" : "received";
  return {
    id: messageId(message),
    threadId: threadId(message),
    provider,
    accountId: account.id,
    from,
    to,
    subject: message.subject,
    text: message.text ?? message.text_preview,
    createdAt: timestamp(message),
    direction,
    metadata: {
      agentmail: message,
    },
  };
}

function listFromResponse<T>(response: unknown, keys: string[]): T[] {
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

function mapThread(provider: string, account: AccountConfig, thread: AgentMailThread): ThreadView {
  const latestAt = thread.timestamp ??
    thread.received_timestamp ??
    thread.sent_timestamp ??
    new Date().toISOString();
  return {
    id: thread.thread_id ?? thread.id ?? thread.last_message_id ?? crypto.randomUUID(),
    provider,
    accountId: account.id,
    messageIds: thread.messages?.map((message) => messageId(message)) ?? [],
    participants: [
      ...addressRefs(provider, thread.senders),
      ...addressRefs(provider, thread.recipients),
    ],
    subject: thread.subject,
    latestAt,
  };
}

export const agentMailProvider: ProviderAdapter = {
  id: "agentmail",
  type: "agentmail",
  kind: "email",
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
      message: "AgentMail uses inboxes as agent-owned email identities.",
      nextSteps: [
        "Set AGENTMAIL_API_KEY or configure providers.agentmail.auth.apiKeyEnv.",
        "Optionally set providers.agentmail.settings.baseUrl, defaulting to https://api.agentmail.to.",
        "Create an inbox with: agent-message accounts create agentmail --name support-agent.",
      ],
    };
  },

  async createAccount(
    input: CreateAccountInput,
    context: ProviderContext,
  ): Promise<AccountConfig> {
    const body: Record<string, string> = {};
    if (input.name) {
      body.display_name = input.name;
      body.client_id = input.name;
    }
    if (input.address) {
      const [username, domain] = input.address.split("@");
      if (username) body.username = username;
      if (domain) body.domain = domain;
    }

    const inbox = await request<AgentMailInbox>(context, "/v0/inboxes", {
      method: "POST",
      body,
    });

    const id = inbox.inbox_id ?? inbox.id;
    if (!id) throw new Error("AgentMail create inbox response did not include inbox_id.");
    return {
      id,
      provider: context.providerConfig.id,
      address: inbox.email ?? inbox.address ?? input.address ?? id,
      displayName: inbox.display_name ?? input.name,
      agents: [input.agentId],
      settings: {
        inboxId: id,
      },
    };
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
    const message = await request<AgentMailMessage>(
      context,
      `/v0/inboxes/${encodeURIComponent(inboxId(account))}/messages/send`,
      {
        method: "POST",
        account,
        body: {
          to: [recipient.address],
          subject: input.subject,
          text: input.text,
        },
      },
    );
    return mapMessage(context.providerConfig.id, account, message);
  },

  async listMailbox(
    query: MailboxQuery,
    context: ProviderContext,
  ): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(
      context,
      `/v0/inboxes/${encodeURIComponent(inboxId(account))}/messages`,
      {
        account,
        query: { limit: query.limit ?? 20 },
      },
    );
    return listFromResponse<AgentMailMessage>(response, ["messages"]).map((message) => {
      return mapMessage(context.providerConfig.id, account, message);
    });
  },

  async readMessage(
    messageIdValue: string,
    query: MailboxQuery,
    context: ProviderContext,
  ): Promise<MessageEnvelope | undefined> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const message = await request<AgentMailMessage>(
      context,
      `/v0/inboxes/${encodeURIComponent(inboxId(account))}/messages/${encodeURIComponent(messageIdValue)}`,
      { account },
    );
    return mapMessage(context.providerConfig.id, account, message);
  },

  async listThreads(query: MailboxQuery, context: ProviderContext): Promise<ThreadView[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(
      context,
      `/v0/inboxes/${encodeURIComponent(inboxId(account))}/threads`,
      {
        account,
        query: { limit: query.limit ?? 20 },
      },
    );
    return listFromResponse<AgentMailThread>(response, ["threads"]).map((thread) => {
      return mapThread(context.providerConfig.id, account, thread);
    });
  },

  async readThread(
    threadIdValue: string,
    query: MailboxQuery,
    context: ProviderContext,
  ): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const thread = await request<AgentMailThread>(
      context,
      `/v0/inboxes/${encodeURIComponent(inboxId(account))}/threads/${encodeURIComponent(threadIdValue)}`,
      { account },
    );
    if (Array.isArray(thread.messages)) {
      return thread.messages.map((message) => mapMessage(context.providerConfig.id, account, message));
    }
    if (thread.last_message_id) {
      const message = await this.readMessage(thread.last_message_id, query, context);
      return message ? [message] : [];
    }
    return [];
  },

  async replyToThread(
    input: ReplyToThreadInput,
    context: ProviderContext,
  ): Promise<MessageEnvelope> {
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId);
    const messages = await this.readThread(input.threadId, { agentId: input.agentId, accountId: account.id }, context);
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error(`Thread '${input.threadId}' has no message to reply to.`);

    const message = await request<AgentMailMessage>(
      context,
      `/v0/inboxes/${encodeURIComponent(inboxId(account))}/messages/${encodeURIComponent(lastMessage.id)}/reply`,
      {
        method: "POST",
        account,
        body: {
          text: input.text,
          reply_all: true,
        },
      },
    );
    return mapMessage(context.providerConfig.id, account, message);
  },
};
