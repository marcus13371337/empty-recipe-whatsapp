import type { JsonValue } from "@empty/module-sdk";
import { isObject, listOf, numberOf, objectOf, textOf } from "./json";

export const CONNECTION = "whatsapp";
export const HELPER = "whatsapp";
export const ACCOUNT = { id: CONNECTION, title: "WhatsApp" };
export const SERVICE = "WhatsApp";

export type HandleKind = "phone" | "id";
export type Person = { handle: string; kind: HandleKind; name: string | null };
export type Attachment = { id: string; name: string; mediaType: string | null; size?: number };
export type Reaction = { from: Person | null; from_me: boolean; kind: string };
export type Message = {
  id: string;
  conversation: string;
  from: Person | null;
  from_me: boolean;
  text: string | null;
  sent: string;
  attachments: Attachment[];
  reactions: Reaction[];
};
export type Conversation = {
  id: string;
  name?: string;
  group?: boolean;
  service: string;
  participants?: Person[];
  unread?: number;
};
export type ReactionChange = {
  message: string;
  conversation: string;
  from: Person | null;
  from_me: boolean;
  kind: string | null;
};
export type ReadChange = { conversation: string; reader: Person; at: string };

export const UNSUPPORTED = "This message can only be seen in WhatsApp.";
export const NO_REF = "no-ref:";

function attachmentOf(raw: JsonValue, message: string): Attachment | null {
  if (!isObject(raw)) return null;
  const id = textOf(raw.id) ?? "";
  const size = numberOf(raw.size);
  return {
    id: textOf(raw.ref) ?? `${NO_REF}${message}/${id}`,
    name: textOf(raw.name) ?? id,
    mediaType: textOf(raw.type),
    ...(size !== null && { size }),
  };
}

export class People {
  private names = new Map<string, string>();
  private phones = new Map<string, string>();
  private other = new Map<string, string>();
  private me: string | null = null;

  private learn(raw: JsonValue): Person | null {
    const person = objectOf(raw);
    const id = textOf(person.id);
    if (id === null) return null;
    const name = textOf(person.name);
    const phone = textOf(person.phone);
    if (name) this.names.set(id, name);
    if (phone) this.phones.set(id, phone);
    return this.person(id);
  }

  private person(id: string): Person {
    const name = this.names.get(id) ?? null;
    const phone = this.phones.get(id);
    return phone ? { handle: phone, kind: "phone", name } : { handle: id, kind: "id", name };
  }

  private isMe(conversation: string, id: string) {
    if (id === this.me) return true;
    const other = this.other.get(conversation);
    if (other === undefined || other === id) return false;
    this.me = id;
    return true;
  }

  private reactionOf(conversation: string, from: string, kind: string): Reaction {
    const fromMe = this.isMe(conversation, from);
    return { from: fromMe ? null : this.person(from), from_me: fromMe, kind };
  }

  learnMe(raw: JsonValue) {
    const { from_me, sender_id } = objectOf(raw);
    const sender = textOf(sender_id);
    if (from_me === true && sender !== null) this.me = sender;
  }

  conversationOf(raw: JsonValue): Conversation | null {
    if (!isObject(raw)) return null;
    const id = textOf(raw.id);
    if (id === null) return null;
    const people = listOf(raw.participants);
    const other = people.length === 1 ? textOf(objectOf(people[0]).id) : null;
    if (raw.kind === "direct" && other !== null) this.other.set(id, other);
    const participants = people.flatMap((value) => this.learn(value) ?? []);
    return {
      id,
      name: textOf(raw.name) ?? participants.map(({ name }) => name ?? "").join(", "),
      group: raw.kind === "group",
      service: SERVICE,
      participants,
      unread: raw.unread === true ? 1 : 0,
    };
  }

  messageOf(raw: JsonValue): Message | null {
    if (!isObject(raw)) return null;
    const id = textOf(raw.id);
    const conversation = textOf(raw.conversation_id);
    const sent = textOf(raw.sent_at);
    const sender = textOf(raw.sender_id);
    if (id === null || conversation === null || sent === null) return null;
    const fromMe = raw.from_me === true;
    return {
      id,
      conversation,
      from: fromMe || sender === null ? null : this.person(sender),
      from_me: fromMe,
      text: textOf(raw.text) || (raw.unsupported === true ? UNSUPPORTED : null),
      sent,
      attachments: listOf(raw.attachments).flatMap((value) => attachmentOf(value, id) ?? []),
      reactions: listOf(raw.reactions).flatMap((value) => {
        const reaction = objectOf(value);
        const from = textOf(reaction.sender_id);
        const kind = textOf(reaction.emoji);
        return from === null || !kind ? [] : [this.reactionOf(conversation, from, kind)];
      }),
    };
  }

  reactionChangeOf(raw: JsonValue): ReactionChange | null {
    const { message_id, conversation_id, sender_id, emoji } = objectOf(raw);
    const message = textOf(message_id);
    const conversation = textOf(conversation_id);
    const from = textOf(sender_id);
    if (message === null || conversation === null || from === null) return null;
    const fromMe = this.isMe(conversation, from);
    return {
      message,
      conversation,
      from: fromMe ? null : this.person(from),
      from_me: fromMe,
      kind: textOf(emoji) || null,
    };
  }

  readChangeOf(raw: JsonValue): ReadChange | null {
    const { conversation_id, reader_id, read_at } = objectOf(raw);
    const conversation = textOf(conversation_id);
    const reader = textOf(reader_id);
    const at = textOf(read_at);
    if (conversation === null || reader === null || at === null) return null;
    if (this.isMe(conversation, reader)) return null;
    return { conversation, reader: this.person(reader), at };
  }
}

export const personIn = (value: JsonValue | undefined): Person | null => {
  const person = objectOf(value);
  const handle = textOf(person.handle);
  if (handle === null) return null;
  return { handle, kind: person.kind === "phone" ? "phone" : "id", name: textOf(person.name) };
};

export const keptAttachments = (value: JsonValue | undefined): Attachment[] =>
  listOf(value).flatMap((entry) => {
    const attachment = objectOf(entry);
    const id = textOf(attachment.id);
    const size = numberOf(attachment.size);
    if (id === null) return [];
    return [
      {
        id,
        name: textOf(attachment.name) ?? "",
        mediaType: textOf(attachment.mediaType),
        ...(size !== null && { size }),
      },
    ];
  });

export const keptReactions = (value: JsonValue | undefined): Reaction[] =>
  listOf(value).flatMap((entry) => {
    const reaction = objectOf(entry);
    const kind = textOf(reaction.kind);
    return kind ? [{ from: personIn(reaction.from), from_me: reaction.from_me === true, kind }] : [];
  });

export function keptMessage(value: JsonValue): Message | null {
  const raw = objectOf(value);
  const id = textOf(raw.id);
  const conversation = textOf(raw.conversation);
  const sent = textOf(raw.sent);
  if (id === null || conversation === null || sent === null) return null;
  return {
    id,
    conversation,
    from: personIn(raw.from),
    from_me: raw.from_me === true,
    text: textOf(raw.text),
    sent,
    attachments: keptAttachments(raw.attachments),
    reactions: keptReactions(raw.reactions),
  };
}

export function keptConversation(value: JsonValue): Conversation | null {
  const raw = objectOf(value);
  const id = textOf(raw.id);
  if (id === null) return null;
  const name = textOf(raw.name);
  const unread = numberOf(raw.unread);
  return {
    id,
    service: SERVICE,
    ...(name !== null && { name }),
    ...(typeof raw.group === "boolean" && { group: raw.group }),
    ...(Array.isArray(raw.participants) && {
      participants: listOf(raw.participants).flatMap((entry) => personIn(entry) ?? []),
    }),
    ...(unread !== null && { unread }),
  };
}

export function keptReactionChange(value: JsonValue): ReactionChange | null {
  const raw = objectOf(value);
  const message = textOf(raw.message);
  const conversation = textOf(raw.conversation);
  if (message === null || conversation === null) return null;
  return {
    message,
    conversation,
    from: personIn(raw.from),
    from_me: raw.from_me === true,
    kind: textOf(raw.kind),
  };
}

export function keptReadChange(value: JsonValue): ReadChange | null {
  const raw = objectOf(value);
  const conversation = textOf(raw.conversation);
  const reader = personIn(raw.reader);
  const at = textOf(raw.at);
  return conversation === null || reader === null || at === null
    ? null
    : { conversation, reader, at };
}
