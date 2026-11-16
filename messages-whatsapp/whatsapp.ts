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
  read?: string | null;
};
export type Conversation = {
  id: string;
  name?: string;
  group?: boolean;
  service: string;
  participants?: Person[];
  unread?: number;
};
export const UNSUPPORTED = "This message can only be seen in WhatsApp.";
export const NO_REF = "no-ref:";

export class People {
  private names = new Map<string, string>();
  private phones = new Map<string, string>();
  me: string | null = null;

  learn(raw: JsonValue) {
    const person = objectOf(raw);
    const id = textOf(person.id);
    if (id === null) return null;
    const name = textOf(person.name);
    const phone = textOf(person.phone);
    if (name) this.names.set(id, name);
    if (phone) this.phones.set(id, phone);
    return this.person(id);
  }

  person(id: string): Person {
    const name = this.names.get(id) ?? null;
    const phone = this.phones.get(id);
    return phone ? { handle: phone, kind: "phone", name } : { handle: id, kind: "id", name };
  }
}

export function conversationOf(raw: JsonValue, people: People): Conversation | null {
  if (!isObject(raw)) return null;
  const id = textOf(raw.id);
  if (id === null) return null;
  const participants = listOf(raw.participants).flatMap((value) => people.learn(value) ?? []);
  return {
    id,
    name: textOf(raw.name) ?? participants.map(({ name }) => name ?? "").join(", "),
    group: raw.kind === "group",
    service: SERVICE,
    participants,
    unread: raw.unread === true ? 1 : 0,
  };
}

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

export const reactionOf = (from: string, kind: string, people: People): Reaction => ({
  from: from === people.me ? null : people.person(from),
  from_me: from === people.me,
  kind,
});

export function messageOf(raw: JsonValue, people: People): Message | null {
  if (!isObject(raw)) return null;
  const id = textOf(raw.id);
  const conversation = textOf(raw.conversation_id);
  const sent = textOf(raw.sent_at);
  const sender = textOf(raw.sender_id);
  if (id === null || conversation === null || sent === null) return null;
  const fromMe = raw.from_me === true;
  if (fromMe && sender !== null) people.me = sender;
  const text = textOf(raw.text) || (raw.unsupported === true ? UNSUPPORTED : null);
  return {
    id,
    conversation,
    from: fromMe || sender === null ? null : people.person(sender),
    from_me: fromMe,
    text,
    sent,
    attachments: listOf(raw.attachments).flatMap((value) => attachmentOf(value, id) ?? []),
    reactions: listOf(raw.reactions).flatMap((value) => {
      const reaction = objectOf(value);
      const from = textOf(reaction.sender_id);
      const kind = textOf(reaction.emoji);
      return from === null || !kind ? [] : [reactionOf(from, kind, people)];
    }),
  };
}

const personIn = (value: JsonValue | undefined): Person | null => {
  const person = objectOf(value);
  const handle = textOf(person.handle);
  if (handle === null) return null;
  return { handle, kind: person.kind === "phone" ? "phone" : "id", name: textOf(person.name) };
};

const keptAttachments = (value: JsonValue | undefined): Attachment[] =>
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

export function keptMessage(value: JsonValue): Message | null {
  const raw = objectOf(value);
  const id = textOf(raw.id);
  const conversation = textOf(raw.conversation);
  const sent = textOf(raw.sent);
  if (id === null || conversation === null || sent === null) return null;
  const read = textOf(raw.read);
  return {
    id,
    conversation,
    from: personIn(raw.from),
    from_me: raw.from_me === true,
    text: textOf(raw.text),
    sent,
    attachments: keptAttachments(raw.attachments),
    reactions: listOf(raw.reactions).flatMap((entry) => {
      const reaction = objectOf(entry);
      const kind = textOf(reaction.kind);
      return kind
        ? [{ from: personIn(reaction.from), from_me: reaction.from_me === true, kind }]
        : [];
    }),
    ...(read !== null && { read }),
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
