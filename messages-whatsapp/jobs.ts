import type { FailedBecause, JobContext, JsonValue } from "@empty/module-sdk";
import { listOf, numberOf, objectOf, reasonOf, textOf } from "./json";
import {
  ACCOUNT,
  CONNECTION,
  type Conversation,
  keptAttachments,
  keptConversation,
  keptMessage,
  keptReactionChange,
  keptReactions,
  keptReadChange,
  type Message,
  type Person,
  type Reaction,
  type ReactionChange,
  type ReadChange,
  SERVICE,
} from "./whatsapp";

const BATCH = 500;
const MOST_BATCHES = 100;
const SKIPPED_OUTAGES: readonly FailedBecause[] = ["asleep", "timeout"];

const isHere = async (context: JobContext) =>
  (await context.connectors.list()).some(({ name }) => name === CONNECTION);

function unique<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

const messagesIn = (value: JsonValue | undefined): Message[] =>
  listOf(value).flatMap((entry) => keptMessage(entry) ?? []);

const conversationsIn = (value: JsonValue | undefined) =>
  listOf(value).flatMap((entry) => keptConversation(entry) ?? []);

const isLater = (m: Message, than: Message | undefined) =>
  than === undefined || Date.parse(m.sent) >= Date.parse(than.sent);

function keepNewest(newest: Map<string, Message>, m: Message) {
  if (isLater(m, newest.get(m.conversation))) newest.set(m.conversation, m);
}

const storedLine = (
  conversation: string,
  id: string,
  line: { text?: string | null; sent: string; from_me?: boolean | null; attachments?: JsonValue },
): Message => ({
  id,
  conversation,
  from: null,
  from_me: line.from_me ?? false,
  text: line.text ?? null,
  sent: line.sent,
  attachments: keptAttachments(line.attachments),
  reactions: [],
});

async function newestStored(context: JobContext, account: string | undefined) {
  const newest = new Map<string, Message>();
  if (account === undefined) return newest;
  const chats = await context.collection("messages/conversations").query({ where: { account } });
  for (const { id, source_id, last_text, last_at, last_from_me } of chats) {
    if (!source_id) continue;
    if (last_at) {
      keepNewest(
        newest,
        storedLine(source_id, `${source_id}/last`, { text: last_text, sent: last_at, from_me: last_from_me }),
      );
    }
    const [row] = await context.collection("messages/messages").query({
      where: { conversation: id },
      orderBy: [{ field: "sent", direction: "desc" }],
      limit: 1,
    });
    if (row?.source_id && row.sent) {
      keepNewest(newest, storedLine(source_id, row.source_id, { ...row, sent: row.sent }));
    }
  }
  return newest;
}

type Changed = {
  id: string;
  conversation: string;
  from_me: boolean;
  sent: string;
  reactions: Reaction[];
  read: string | null;
};

const peopleIn = (conversations: Conversation[], messages: Message[], reactions: ReactionChange[]) => [
  ...conversations.flatMap(({ participants }) => participants ?? []),
  ...messages.flatMap(({ from, reactions }) => [
    ...(from ? [from] : []),
    ...reactions.flatMap((reaction) => reaction.from ?? []),
  ]),
  ...reactions.flatMap(({ from }) => from ?? []),
];

function distinct(people: Person[]): Person[] {
  const byHandle = new Map<string, Person>();
  for (const person of people) {
    const kept = byHandle.get(person.handle);
    if (!kept?.name) byHandle.set(person.handle, person);
  }
  return [...byHandle.values()];
}

const sameSender = (a: Reaction, b: { from: Person | null; from_me: boolean }) =>
  a.from_me === b.from_me && (a.from_me || a.from?.handle === b.from?.handle);

async function changesFrom(
  context: JobContext,
  account: string,
  reactions: ReactionChange[],
  reads: ReadChange[],
) {
  const changed = new Map<string, Changed>();
  const kept = async (source_id: string, conversation: string) => {
    const already = changed.get(source_id);
    if (already) return already;
    const [row] = await context
      .collection("messages/messages")
      .query({ where: { account, source_id } });
    if (!row?.source_id) return null;
    return {
      id: row.source_id,
      conversation,
      from_me: row.from_me ?? false,
      sent: row.sent ?? "",
      reactions: keptReactions(
        listOf(row.reactions).map((entry) => {
          const { from, from_me, kind } = objectOf(entry);
          const person = objectOf(from);
          return {
            from: textOf(person.handle) === null ? null : { ...person, name: person.source_name ?? null },
            from_me: from_me ?? false,
            kind: kind ?? null,
          };
        }),
      ),
      read: row.read ?? null,
    };
  };
  for (const reaction of reactions) {
    const message = await kept(reaction.message, reaction.conversation);
    if (!message) continue;
    const others = message.reactions.filter((given) => !sameSender(given, reaction));
    const { from, from_me, kind } = reaction;
    changed.set(message.id, {
      ...message,
      reactions: kind ? [...others, { from, from_me, kind }] : others,
    });
  }
  for (const { conversation, reader, at } of reads) {
    const [chat] = await context
      .collection("messages/conversations")
      .query({ where: { account, source_id: conversation } });
    const handles = listOf(chat?.participants).map((entry) => textOf(objectOf(entry).handle));
    if (!chat || chat.group || !handles.includes(reader.handle)) continue;
    const unread = await context.collection("messages/messages").query({
      where: { conversation: chat.id, from_me: true, read: null, sent: { lte: at } },
    });
    for (const row of unread) {
      const message = await kept(row.source_id ?? "", conversation);
      if (message) changed.set(message.id, { ...message, read: at });
    }
  }
  return [...changed.values()];
}

async function addHandles(context: JobContext, people: Person[]) {
  for (const { handle, kind, name } of people) {
    await context.action("people/addHandle", {
      kind,
      value: handle,
      name,
      ...(kind === "id" && { service: SERVICE }),
    });
  }
}

export async function syncAccount(context: JobContext, now = new Date()) {
  const source = context.module;
  const keptDays = await context.setting("messages-whatsapp/kept_days");
  const chats = await context.setting("messages-whatsapp/chats");
  const since = new Date(now.getTime() - keptDays * 86_400_000);
  const [kept] = await context
    .collection("messages/accounts")
    .query({ where: { source, source_id: ACCOUNT.id } });
  try {
    const listed = conversationsIn(
      objectOf(await context.connectors.call(CONNECTION, "conversations", { limit: chats }))
        .conversations,
    );
    const newest = await newestStored(context, kept?.id);
    const met: Person[] = [];
    let synced: JsonValue = null;
    for (let batch = 0; batch < MOST_BATCHES; batch += 1) {
      const waiting = objectOf(
        await context.connectors.call(CONNECTION, "take_events", { limit: BATCH }),
      );
      const messages = unique(messagesIn(waiting.messages)).filter(
        ({ sent }) => Date.parse(sent) >= since.getTime(),
      );
      for (const message of messages) keepNewest(newest, message);
      const taken = conversationsIn(waiting.conversations);
      const conversations = unique([...listed, ...taken]).map((conversation) => {
        const last = newest.get(conversation.id);
        return last ? { ...conversation, last_message: last } : conversation;
      });
      const keep = (more: { messages: Message[]; changed: Changed[] }) =>
        context.action("messages/sync", {
          source,
          account: ACCOUNT,
          since: since.toISOString(),
          conversations,
          ...more,
        });
      synced = await keep({ messages, changed: [] });
      const reactions = listOf(waiting.reactions).flatMap((entry) => keptReactionChange(entry) ?? []);
      const reads = listOf(waiting.reads).flatMap((entry) => keptReadChange(entry) ?? []);
      if (reactions.length > 0 || reads.length > 0) {
        const [account] = await context
          .collection("messages/accounts")
          .query({ where: { source, source_id: ACCOUNT.id } });
        const changed = await changesFrom(context, account?.id ?? "", reactions, reads);
        if (changed.length > 0) synced = await keep({ messages: [], changed });
      }
      met.push(...peopleIn(taken, messages, reactions));
      await context.connectors.call(CONNECTION, "drop_events", {
        upTo: numberOf(waiting.upTo) ?? 0,
      });
      if (waiting.more !== true) break;
    }
    await addHandles(context, distinct(met));
    return synced;
  } catch (error) {
    const reason = context.connectors.failedBecause(error);
    if (reason === null || !SKIPPED_OUTAGES.includes(reason)) {
      const state = objectOf(
        await context.connectors.call(CONNECTION, "state", {}).catch(() => null),
      );
      const problem = textOf(state.message) ?? reasonOf(error);
      await context.action("messages/syncFailed", {
        source,
        account: ACCOUNT,
        problem,
        failed_because: reason,
      });
    }
    throw error;
  }
}

export async function sync(context: JobContext) {
  if (!(await isHere(context))) {
    await context.action("messages/forget", { source: context.module, account: ACCOUNT.id });
    return { synced: 0 };
  }
  await syncAccount(context);
  return { synced: 1 };
}

type File = { name: string; base64: string };
type Due = { id: string; conversation: string | null; text: string | null; files: File[] };

const fileIn = (value: JsonValue): File[] => {
  const name = textOf(objectOf(value).name);
  const base64 = textOf(objectOf(value).base64);
  return name === null || base64 === null ? [] : [{ name, base64 }];
};

function dueIn(answer: JsonValue): Due | null {
  const due = objectOf(answer).send;
  const id = textOf(objectOf(due).id);
  if (id === null) return null;
  const { conversation, text, files } = objectOf(due);
  return {
    id,
    conversation: textOf(conversation),
    text: textOf(text),
    files: listOf(files).flatMap(fileIn),
  };
}

export async function send(context: JobContext) {
  const source = context.module;
  let sent = 0;
  for (;;) {
    const due = dueIn(await context.action("messages/takeDue", { source }));
    if (!due) return { sent };
    sent += 1;
    try {
      if (due.conversation === null) {
        throw new Error("WhatsApp can only answer in a chat that is already there.");
      }
      const { conversation } = due;
      await context.onBehalfOf("messages/messages", due, () =>
        context.connectors.call(CONNECTION, "send", {
          conversation,
          ...(due.text !== null && { text: due.text }),
          ...(due.files.length > 0 && { files: due.files }),
        }),
      );
    } catch (error) {
      await context.action("messages/sent", {
        source,
        id: due.id,
        ...context.connectors.failure(error),
      });
      continue;
    }
    await syncAccount(context).catch(() => null);
    await context.action("messages/sent", { source, id: due.id });
  }
}
