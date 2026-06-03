import type { AddressRef, MessageEnvelope, StoreEvent, ThreadView } from "./types.js";

export function messageEvents(events: StoreEvent[], accountId?: string): MessageEnvelope[] {
  return events
    .filter((event) => event.type === "message.sent" || event.type === "message.received")
    .map((event) => event.payload as MessageEnvelope)
    .filter((message) => !accountId || message.accountId === accountId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function threadMessages(
  events: StoreEvent[],
  threadId: string,
  accountId?: string,
): MessageEnvelope[] {
  return messageEvents(events, accountId)
    .filter((message) => message.threadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function threadViews(events: StoreEvent[], accountId?: string): ThreadView[] {
  const byThread = new Map<string, MessageEnvelope[]>();
  for (const message of messageEvents(events, accountId)) {
    const existing = byThread.get(message.threadId) ?? [];
    existing.push(message);
    byThread.set(message.threadId, existing);
  }

  return [...byThread.entries()].map(([threadId, messages]) => {
    const sorted = messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = sorted[sorted.length - 1]!;
    return {
      id: threadId,
      provider: latest.provider,
      accountId: latest.accountId,
      messageIds: sorted.map((message) => message.id),
      participants: uniqueParticipants(sorted),
      subject: latest.subject,
      latestAt: latest.createdAt,
    };
  }).sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

function uniqueParticipants(messages: MessageEnvelope[]): AddressRef[] {
  const refs = new Map<string, AddressRef>();
  for (const message of messages) {
    refs.set(`${message.from.provider}:${message.from.address}`, message.from);
    for (const recipient of message.to) {
      refs.set(`${recipient.provider}:${recipient.address}`, recipient);
    }
  }
  return [...refs.values()];
}
