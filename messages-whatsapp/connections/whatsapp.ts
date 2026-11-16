import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CodeConnection, HelperProgram, JsonObject, JsonValue } from "@empty/module-sdk";
import { listOf, numberOf, objectOf, textOf } from "../json";
import {
  type Conversation,
  conversationOf,
  HELPER,
  type Message,
  messageOf,
  NO_REF,
  People,
  reactionOf,
  SERVICE,
} from "../whatsapp";

const HELPER_PAGE = 100;
const KNOWN = 5_000;

type Waiting = { seq: number; kind: "messages" | "changed" | "conversations"; value: JsonValue };

const STRING = { type: "string", minLength: 1 };

export function whatsappConnection(): CodeConnection {
  const people = new People();
  const chats = new Map<string, Conversation>();
  const others = new Map<string, Set<string>>();
  const known = new Map<string, Message>();
  let waiting: Waiting[] = [];
  let seq = 0;
  let state: { state: string; message: string | null } | null = null;

  const remember = (given: Message) => {
    const read = given.read ?? known.get(given.id)?.read;
    const message = read ? { ...given, read } : given;
    known.delete(message.id);
    known.set(message.id, message);
    if (known.size > KNOWN) {
      const oldest = known.keys().next().value;
      if (oldest !== undefined) known.delete(oldest);
    }
    return message;
  };
  const wait = (kind: Waiting["kind"], value: Message | Conversation) => {
    seq += 1;
    waiting.push({ seq, kind, value: JSON.parse(JSON.stringify(value)) });
  };
  const heardChat = (raw: JsonValue) => {
    const found = conversationOf(raw, people);
    if (found === null) return null;
    chats.set(found.id, found);
    const ids = listOf(objectOf(raw).participants).flatMap((p) => textOf(objectOf(p).id) ?? []);
    others.set(found.id, new Set(ids));
    return found;
  };

  const heard: Record<string, (data: JsonValue) => boolean> = {
    message: (data) => {
      const message = messageOf(data, people);
      if (message === null) return false;
      remember(message);
      wait("messages", message);
      return true;
    },
    reaction: (data) => {
      const { message_id, sender_id, emoji } = objectOf(data);
      const message = known.get(textOf(message_id) ?? "");
      const from = textOf(sender_id);
      if (!message || from === null) return false;
      const reacting = reactionOf(from, "", people);
      const kept = message.reactions.filter(
        (reaction) =>
          reaction.from_me !== reacting.from_me ||
          (!reacting.from_me && reaction.from?.handle !== reacting.from?.handle),
      );
      const kind = textOf(emoji);
      const changed = { ...message, reactions: kind ? [...kept, { ...reacting, kind }] : kept };
      remember(changed);
      wait("changed", changed);
      return true;
    },
    read: (data) => {
      const { conversation_id, reader_id, read_at } = objectOf(data);
      const conversation = textOf(conversation_id);
      const at = textOf(read_at);
      if (conversation === null || at === null || chats.get(conversation)?.group !== false) {
        return false;
      }
      if (!others.get(conversation)?.has(textOf(reader_id) ?? "")) return false;
      const reached = [...known.values()].filter(
        (message) =>
          message.conversation === conversation &&
          message.from_me &&
          !message.read &&
          Date.parse(message.sent) <= Date.parse(at),
      );
      for (const message of reached) {
        const changed = { ...message, read: at };
        remember(changed);
        wait("changed", changed);
      }
      return reached.length > 0;
    },
    conversation: (data) => {
      const found = heardChat(data);
      if (found === null) return false;
      wait("conversations", found);
      return true;
    },
    state: (data) => {
      const said = objectOf(data);
      state = { state: textOf(said.state) ?? "unknown", message: textOf(said.message) };
      return said.state === "connected" || said.state === "logged_out";
    },
  };

  const take = (limit: number) => {
    const batch = waiting.slice(0, limit);
    const of = (kind: Waiting["kind"]) =>
      batch.filter((entry) => entry.kind === kind).map(({ value }) => value);
    const messages = of("messages");
    const theirChats = [
      ...new Set(messages.map((message) => textOf(objectOf(message).conversation) ?? "")),
    ].map((id) => chats.get(id) ?? { id, service: SERVICE });
    return {
      upTo: batch.at(-1)?.seq ?? seq,
      more: waiting.length > batch.length,
      messages,
      changed: of("changed"),
      conversations: [...of("conversations"), ...JSON.parse(JSON.stringify(theirChats))],
    };
  };

  const conversations = async (helper: HelperProgram, limit: number) => {
    const found: Conversation[] = [];
    let before: string | null = null;
    while (found.length < limit) {
      const answer = objectOf(
        await helper.request("conversations", {
          limit: Math.min(HELPER_PAGE, limit - found.length),
          ...(before !== null && { before }),
        }),
      );
      found.push(...listOf(answer.conversations).flatMap((raw) => heardChat(raw) ?? []));
      before = textOf(answer.next);
      if (before === null) break;
    }
    return found;
  };

  const send = async (helper: HelperProgram, args: JsonObject) => {
    const folder = join(await helper.folder(), "outgoing");
    await mkdir(folder, { recursive: true });
    const files = await Promise.all(
      listOf(args.files).map(async (value) => {
        const file = objectOf(value);
        const name = basename(textOf(file.name) ?? "file");
        const path = join(folder, `${randomUUID()}-${name}`);
        await writeFile(path, Buffer.from(textOf(file.base64) ?? "", "base64"));
        return { path, name };
      }),
    );
    try {
      const answer = objectOf(
        await helper.request("send", {
          conversation_id: textOf(args.conversation) ?? "",
          ...(textOf(args.text) && { text: textOf(args.text) }),
          ...(files.length > 0 && { files }),
        }),
      );
      const answered = listOf(answer.messages);
      const echoed = answered.flatMap((raw) => known.get(textOf(objectOf(raw).id) ?? "") ?? []);
      const fresh = answered
        .filter((raw) => !known.has(textOf(objectOf(raw).id) ?? ""))
        .flatMap((raw) => {
          const message = messageOf(raw, people);
          return message ? [remember(message)] : [];
        });
      for (const message of fresh) wait("messages", message);
      const problem = objectOf(answer.problem);
      if (textOf(problem.message)) {
        throw new Error(`Only part of it went out: ${textOf(problem.message)}`);
      }
      return { messages: [...echoed, ...fresh] };
    } finally {
      await Promise.all(files.map(({ path }) => rm(path, { force: true })));
    }
  };

  const attachment = async (helper: HelperProgram, id: string) => {
    if (id.startsWith(NO_REF)) {
      throw new Error("WhatsApp has not handed this file over. Open the chat in WhatsApp.");
    }
    const answer = objectOf(await helper.request("attachment", { ref: id }));
    const path = textOf(answer.path) ?? "";
    try {
      const mediaType = textOf(answer.type);
      return {
        attachment: {
          id,
          name: textOf(answer.name) ?? basename(path),
          mediaType,
          size: numberOf(answer.size) ?? 0,
        },
        file: {
          base64: (await readFile(path)).toString("base64"),
          mediaType: mediaType ?? "application/octet-stream",
        },
        kept: "here",
      };
    } finally {
      await rm(path, { force: true });
    }
  };

  return {
    tools: {
      conversations: {
        description: "The most recent WhatsApp chats, newest activity first",
        does: "read",
        input: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1 } },
          required: ["limit"],
        },
        run: async (args, { helperProgram }) => ({
          conversations: await conversations(helperProgram(HELPER), numberOf(args.limit) ?? 100),
        }),
      },
      take_events: {
        description:
          "Up to limit of what arrived since the last drop_events: messages, changes and chats, with the chat of every message",
        does: "read",
        input: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1 } },
          required: ["limit"],
        },
        run: (args) => take(numberOf(args.limit) ?? 500),
      },
      drop_events: {
        description: "Forget what take_events gave, up to upTo, once it is kept",
        does: "read",
        input: { type: "object", properties: { upTo: { type: "integer" } }, required: ["upTo"] },
        run: (args) => {
          const upTo = numberOf(args.upTo) ?? 0;
          waiting = waiting.filter((entry) => entry.seq > upTo);
          return null;
        },
      },
      state: {
        description: "The WhatsApp link's last state, with its reason in plain words",
        does: "read",
        run: () => state,
      },
      send: {
        description: "Send text, files or both to a WhatsApp chat",
        input: {
          type: "object",
          properties: {
            conversation: STRING,
            text: { type: "string" },
            files: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, base64: { type: "string" } },
                required: ["name", "base64"],
              },
            },
          },
          required: ["conversation"],
        },
        run: (args, { helperProgram }) => send(helperProgram(HELPER), args),
      },
      attachment: {
        description: "One attachment's file",
        does: "read",
        input: { type: "object", properties: { id: STRING }, required: ["id"] },
        run: (args, { helperProgram }) => attachment(helperProgram(HELPER), textOf(args.id) ?? ""),
      },
    },
    watch: (emit, { helperProgram, signal }) => {
      const helper = helperProgram(HELPER);
      const stops = Object.entries(heard).map(([event, hear]) =>
        helper.on(event, (data) => {
          if (hear(data)) emit();
        }),
      );
      signal.addEventListener("abort", () => {
        for (const stop of stops) stop();
      });
    },
  };
}

export default whatsappConnection();
