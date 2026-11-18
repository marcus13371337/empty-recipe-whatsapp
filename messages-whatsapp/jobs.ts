import { type JobContext, type JobEvent, type JsonValue, job } from "@empty/module-sdk";
import { listOf, numberOf, objectOf, textOf } from "./json";
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

export const BATCH = 500;
const MOST_BATCHES = 100;

function unique<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

const messagesIn = (value: JsonValue | undefined): Message[] =>
  listOf(value).flatMap((entry) => keptMessage(entry) ?? []);

const conversationsIn = (value: JsonValue | undefined) =>
  listOf(value).flatMap((entry) => keptConversation(entry) ?? []);

const isLater = (message: Message, than: Message | undefined) =>
  than === undefined || Date.parse(message.sent_at) >= Date.parse(than.sent_at);

function keepNewest(newest: Map<string, Message>, message: Message) {
  if (isLater(message, newest.get(message.conversation))) newest.set(message.conversation, message);
}

type StoredLine = {
  id: string;
  sent_at: string;
  text: string | null;
  from_me: boolean | null;
  attachments?: JsonValue;
};

const storedLine = (conversation: string, line: StoredLine): Message => ({
  id: line.id,
  conversation,
  from: null,
  from_me: line.from_me ?? false,
  text: line.text,
  sent_at: line.sent_at,
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
        storedLine(source_id, {
          id: `${source_id}/last`,
          sent_at: last_at,
          text: last_text ?? null,
          from_me: last_from_me ?? null,
        }),
      );
    }
    const [row] = await context.collection("messages/messages").query({
      where: { conversation: id, source_id: { ne: null } },
      orderBy: [{ field: "sent_at", direction: "desc" }],
      limit: 1,
    });
    if (row?.source_id && row.sent_at) {
      keepNewest(
        newest,
        storedLine(source_id, {
          id: row.source_id,
          sent_at: row.sent_at,
          text: row.text ?? null,
          from_me: row.from_me ?? null,
          attachments: row.attachments,
        }),
      );
    }
  }
  return newest;
}

type Changed = {
  id: string;
  conversation: string;
  from_me: boolean;
  sent_at: string;
  reactions: Reaction[];
  read_at: string | null;
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
      sent_at: row.sent_at ?? "",
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
      read_at: row.read_at ?? null,
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
      where: { conversation: chat.id, from_me: true, read_at: null, sent_at: { lte: at } },
    });
    for (const row of unread) {
      const message = await kept(row.source_id ?? "", conversation);
      if (message) changed.set(message.id, { ...message, read_at: at });
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
  return context.sources.syncing("messages", ACCOUNT, () =>
    inTheHelpersWords(context, async () => {
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
          ({ sent_at }) => Date.parse(sent_at) >= since.getTime(),
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
    }),
  );
}

async function inTheHelpersWords<Result>(context: JobContext, work: () => Promise<Result>) {
  try {
    return await work();
  } catch (error) {
    const state = objectOf(
      await context.connectors.call(CONNECTION, "state", {}).catch(() => null),
    );
    const words = textOf(state.message);
    if (words === null) throw error;
    throw Object.assign(new Error(words, { cause: error }), {
      reason: context.connectors.failedBecause(error),
    });
  }
}

export const sync = job(
  {
    timeout: "5m",
    every: "5m",
    catchUp: true,
    when: [
      { connector: CONNECTION },
      { setting: "messages-whatsapp/kept_days" },
      { setting: "messages-whatsapp/chats" },
    ],
  },
  async (context: JobContext, event?: JobEvent) => {
    const connectors = (await context.connectors.list()).filter(({ name }) => name === CONNECTION);
    const synced = await context.sources.feed("messages", {
      connectors,
      event,
      run: async () => {
        await syncAccount(context);
      },
    });
    return { synced };
  },
);

export const send = job(
  { timeout: "5m", every: "1m", catchUp: true, when: [{ collection: "messages/messages" }] },
  async (context: JobContext) => {
    const sent = await context.sources.drain("messages/messages", async (due) => {
      if (!due.conversation) throw context.sources.refusal("cannot_do_here");
      await context.connectors
        .call(CONNECTION, "send", {
          conversation: due.conversation,
          ...(due.text !== null && { text: due.text }),
          ...(due.files.length > 0 && { files: due.files }),
        })
        .catch((error: Error) => {
          if (context.connectors.failedBecause(error) !== "timeout") throw error;
          throw context.sources.refusal("maybe_sent");
        });
      await syncAccount(context).catch((unsynced: Error) =>
        console.warn(`Sent, but the chat did not sync after it: ${unsynced.message}`),
      );
      return null;
    });
    return { sent };
  },
);
