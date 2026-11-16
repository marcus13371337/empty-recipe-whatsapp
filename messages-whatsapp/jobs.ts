import type { FailedBecause, JobContext, JsonValue } from "@empty/module-sdk";
import { listOf, numberOf, objectOf, reasonOf, textOf } from "./json";
import {
  ACCOUNT,
  CONNECTION,
  type Conversation,
  keptConversation,
  keptMessage,
  type Message,
  type Person,
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

const messagesIn = (value: JsonValue | undefined) =>
  listOf(value).flatMap((entry) => keptMessage(entry) ?? []);

const conversationsIn = (value: JsonValue | undefined) =>
  listOf(value).flatMap((entry) => keptConversation(entry) ?? []);

async function lastLines(context: JobContext, account: string | undefined) {
  const last = new Map<string, Message>();
  if (account === undefined) return last;
  const rows = await context.collection("messages/conversations").query({ where: { account } });
  for (const { source_id, last_text, last_at, last_from_me } of rows) {
    if (!source_id || !last_at) continue;
    last.set(source_id, {
      id: `${source_id}/last`,
      conversation: source_id,
      from: null,
      from_me: last_from_me ?? false,
      text: last_text ?? null,
      sent: last_at,
      attachments: [],
      reactions: [],
    });
  }
  return last;
}

const peopleIn = (conversations: Conversation[], messages: Message[]): Person[] => [
  ...conversations.flatMap(({ participants }) => participants ?? []),
  ...messages.flatMap(({ from, reactions }) => [
    ...(from ? [from] : []),
    ...reactions.flatMap((reaction) => reaction.from ?? []),
  ]),
];

function distinct(people: Person[]): Person[] {
  const byHandle = new Map<string, Person>();
  for (const person of people) {
    const kept = byHandle.get(person.handle);
    if (!kept?.name) byHandle.set(person.handle, person);
  }
  return [...byHandle.values()];
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
    const newest = await lastLines(context, kept?.id);
    const met: Person[] = [];
    let synced: JsonValue = null;
    for (let batch = 0; batch < MOST_BATCHES; batch += 1) {
      const waiting = objectOf(
        await context.connectors.call(CONNECTION, "take_events", { limit: BATCH }),
      );
      const messages = unique(messagesIn(waiting.messages)).filter(
        ({ sent }) => Date.parse(sent) >= since.getTime(),
      );
      for (const message of [...messages].sort((a, b) => Date.parse(a.sent) - Date.parse(b.sent))) {
        newest.set(message.conversation, message);
      }
      const conversations = unique([...listed, ...conversationsIn(waiting.conversations)]).map(
        (conversation) => {
          const last = newest.get(conversation.id);
          return last ? { ...conversation, last_message: last } : conversation;
        },
      );
      const changed = messagesIn(waiting.changed);
      synced = await context.action("messages/sync", {
        source,
        account: ACCOUNT,
        since: since.toISOString(),
        conversations,
        messages,
        changed,
      });
      met.push(...peopleIn(conversations, [...messages, ...changed]));
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
