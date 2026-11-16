import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HelperProgram, JsonObject, JsonValue } from "@empty/module-sdk";
import { appModule, testEngine } from "@empty/module-sdk/testing";
import * as actions from "./actions";
import { whatsappConnection } from "./connections/whatsapp";
import * as jobs from "./jobs";
import { objectOf, textOf } from "./json";
import manifest from "./module.json";

type Someone = { id: string; name: string; phone: string | null };

export const ME: Someone = { id: "46700000001@s.whatsapp.net", name: "Ada", phone: "+46700000001" };
export const ANNA: Someone = {
  id: "46701234567@s.whatsapp.net",
  name: "Anna",
  phone: "+46701234567",
};
export const BO: Someone = { id: "1234567890@lid", name: "Bo", phone: null };

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

type Chat = { id: string; kind: "direct" | "group"; people: Someone[]; name: string; last: string };

export function fakeHelper() {
  const folder = mkdtempSync(join(tmpdir(), "whatsapp-helper-"));
  const chats = new Map<string, Chat>();
  const listeners = new Map<string, Set<(data: JsonValue) => void>>();
  const asked: { method: string; params: JsonObject }[] = [];
  let linked = true;
  let echoes = true;
  let count = 0;

  const emit = (event: string, data: JsonValue) => {
    for (const listener of listeners.get(event) ?? []) listener(data);
  };
  const listing = (chat: Chat): JsonObject => ({
    id: chat.id,
    name: chat.name,
    kind: chat.kind,
    encrypted: true,
    ...(chat.kind === "direct" && chat.people[0]?.phone && { phone: chat.people[0].phone }),
    participants: chat.people.map(({ id, name, phone }) => ({
      id,
      name,
      ...(phone && { phone }),
    })),
    last_activity_at: chat.last,
    unread: false,
  });
  const message = (
    chat: string,
    from: Someone,
    text: string,
    minutes: number,
    more: JsonObject = {},
  ): JsonObject => {
    count += 1;
    const sent = minutesAgo(minutes);
    const kept = chats.get(chat);
    if (kept && Date.parse(sent) > Date.parse(kept.last)) kept.last = sent;
    return {
      id: `m${count}`,
      conversation_id: chat,
      sender_id: from.id,
      from_me: from.id === ME.id,
      sent_at: sent,
      text,
      attachments: [],
      reactions: [],
      encrypted: true,
      ...more,
    };
  };

  const answers: Record<string, (params: JsonObject) => JsonValue> = {
    conversations: ({ limit, before }) => {
      const all = [...chats.values()].sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
      const start = typeof before === "string" ? Number(before) : 0;
      const end = start + Math.min(typeof limit === "number" ? limit : 20, 100);
      return {
        conversations: all.slice(start, end).map(listing),
        ...(end < all.length && { next: String(end) }),
      };
    },
    messages: () => {
      throw new Error("WhatsApp cannot serve this.");
    },
    send: ({ conversation_id, text, files }) => {
      const chat = String(conversation_id);
      const attachments = (Array.isArray(files) ? files : []).map((file, index) => ({
        id: `a${index}`,
        kind: "image",
        type: "image/png",
        name: textOf(objectOf(file).name) ?? "",
        ref: `ref-${index}`,
      }));
      const sent = message(chat, ME, typeof text === "string" ? text : "", 0, { attachments });
      if (echoes) emit("message", sent);
      return { messages: [sent] };
    },
    attachment: ({ ref }) => {
      const path = join(folder, `${String(ref)}.png`);
      writeFileSync(path, "a picture");
      return { path, name: "picture.png", size: 9, type: "image/png" };
    },
  };

  const helper: HelperProgram = {
    request: async (method, params = {}) => {
      const given = objectOf(params);
      asked.push({ method, params: given });
      if (!linked) throw new Error("Nobody is logged in yet. Log in first.");
      const answer = answers[method];
      if (!answer) throw new Error(`The helper has no such request: ${method}`);
      return answer(given);
    },
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    folder: async () => folder,
  };

  return {
    helper,
    folder,
    asked,
    chat(id: string, people: Someone[], options: { group?: boolean; name?: string } = {}) {
      const chat: Chat = {
        id,
        kind: options.group ? "group" : "direct",
        people,
        name: options.name ?? people.map(({ name }) => name).join(", "),
        last: minutesAgo(60 * 24 * 365),
      };
      chats.set(id, chat);
      return listing(chat);
    },
    notLinkedYet() {
      linked = false;
    },
    linked() {
      linked = true;
      emit("state", { state: "connected" });
    },
    history(chat: string, from: Someone, text: string, minutes: number, more: JsonObject = {}) {
      const kept = chats.get(chat);
      const said = message(chat, from, text, minutes, { history: true, ...more });
      if (kept) emit("conversation", listing(kept));
      emit("message", said);
      return said;
    },
    arrives(chat: string, from: Someone, text: string, more: JsonObject = {}) {
      const said = message(chat, from, text, 0, more);
      emit("message", said);
      return said;
    },
    emit,
    noEchoes() {
      echoes = false;
    },
    logOut(code: string | null, reason: string) {
      linked = false;
      emit("state", { state: "logged_out", ...(code && { code }), message: reason });
    },
  };
}

export async function setUp() {
  const fake = fakeHelper();
  const connection = whatsappConnection();
  const mac = { control: async () => "" };
  const context = { mac, helperProgram: () => fake.helper };
  const stop = new AbortController();
  let changes = 0;
  await connection.watch?.(() => (changes += 1), { ...context, signal: stop.signal });
  const engine = testEngine({
    modules: [await appModule("messages"), { manifest, actions, jobs }],
    connections: [{ name: "whatsapp", kind: "stdio" }],
    connector: async (_server, tool, args) => {
      const found = connection.tools[tool];
      if (!found) throw new Error(`No tool "${tool}".`);
      return found.run(args, context);
    },
  });
  const chat = async (source_id: string) => {
    const [conversation] = await engine
      .collection("messages/conversations")
      .query({ where: { source_id } });
    const messages = await engine.collection("messages/messages").query({
      where: { conversation: conversation?.id ?? "" },
      orderBy: [{ field: "sent" }],
    });
    return { conversation, messages };
  };
  return { engine, fake, chat, changes: () => changes, stop: () => stop.abort() };
}
