export type OutputFormat = "json" | "pretty";

export type ProviderKind = "local" | "federation" | "email" | "social" | "custom";

export type ProviderCapability =
  | "createAccount"
  | "sendDirect"
  | "listMailbox"
  | "readMessage"
  | "listThreads"
  | "readThread"
  | "replyThread"
  | "serveFederation";

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
}

export interface ProviderConfig {
  id: string;
  type: string;
  kind?: ProviderKind;
  settings?: Record<string, unknown>;
  auth?: Record<string, unknown>;
}

export interface AccountConfig {
  id: string;
  provider: string;
  address: string;
  displayName?: string;
  agents?: string[];
  settings?: Record<string, unknown>;
  auth?: Record<string, unknown>;
}

export interface ContactHandle {
  id: string;
  provider: string;
  address: string;
  accountId?: string;
  label?: string;
  primary?: boolean;
  verified?: boolean;
  capabilities?: ProviderCapability[];
}

export interface ContactConfig {
  id: string;
  displayName: string;
  handles: ContactHandle[];
  metadata?: Record<string, unknown>;
}

export interface AgentMessageConfig {
  defaultAgent?: string;
  state?: {
    dir?: string;
  };
  agents: Record<string, AgentConfig>;
  providers: Record<string, ProviderConfig>;
  accounts: Record<string, AccountConfig>;
  contacts: Record<string, ContactConfig>;
}

export interface LoadedConfig {
  path: string;
  config: AgentMessageConfig;
  stateDir: string;
}

export interface AddressRef {
  provider: string;
  address: string;
  accountId?: string;
  contactId?: string;
  handleId?: string;
  displayName?: string;
}

export interface MessageEnvelope {
  id: string;
  threadId: string;
  provider: string;
  accountId: string;
  from: AddressRef;
  to: AddressRef[];
  subject?: string;
  text?: string;
  createdAt: string;
  direction: "sent" | "received";
  metadata?: Record<string, unknown>;
}

export interface ThreadView {
  id: string;
  provider: string;
  accountId: string;
  messageIds: string[];
  participants: AddressRef[];
  subject?: string;
  latestAt: string;
}

export interface SendMessageInput {
  agentId: string;
  accountId?: string;
  to: string;
  via?: string;
  subject?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ReplyToThreadInput {
  agentId: string;
  accountId?: string;
  threadId: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface MailboxQuery {
  agentId: string;
  accountId?: string;
  limit?: number;
}

export interface ProviderContext {
  loadedConfig: LoadedConfig;
  store: EventStore;
  providerConfig: ProviderConfig;
}

export interface SetupResult {
  provider: string;
  message: string;
  nextSteps: string[];
}

export interface CreateAccountInput {
  agentId: string;
  name?: string;
  address?: string;
}

export interface ProviderAdapter {
  id: string;
  type: string;
  kind: ProviderKind;
  capabilities: ProviderCapability[];
  setup(context: ProviderContext): Promise<SetupResult>;
  createAccount?(
    input: CreateAccountInput,
    context: ProviderContext,
  ): Promise<AccountConfig>;
  sendMessage(
    input: SendMessageInput,
    context: ProviderContext,
  ): Promise<MessageEnvelope>;
  listMailbox(
    query: MailboxQuery,
    context: ProviderContext,
  ): Promise<MessageEnvelope[]>;
  readMessage(
    messageId: string,
    query: MailboxQuery,
    context: ProviderContext,
  ): Promise<MessageEnvelope | undefined>;
  listThreads(query: MailboxQuery, context: ProviderContext): Promise<ThreadView[]>;
  readThread(
    threadId: string,
    query: MailboxQuery,
    context: ProviderContext,
  ): Promise<MessageEnvelope[]>;
  replyToThread(
    input: ReplyToThreadInput,
    context: ProviderContext,
  ): Promise<MessageEnvelope>;
}

export type StoreEventType =
  | "message.sent"
  | "message.received"
  | "account.created"
  | "contact.created"
  | "contact.handle_added";

export interface StoreEvent<TPayload = unknown> {
  id: string;
  type: StoreEventType;
  timestamp: string;
  actorAgentId?: string;
  payload: TPayload;
}

export interface EventStore {
  append<TPayload>(event: Omit<StoreEvent<TPayload>, "id" | "timestamp">): Promise<StoreEvent<TPayload>>;
  readAll(): Promise<StoreEvent[]>;
}
