import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CodeConnection, HelperProgram, JsonObject, JsonValue } from "@empty/module-sdk";
import { listOf, numberOf, objectOf, textOf } from "../json";
import { type Conversation, HELPER, type Message, NO_REF, People, SERVICE } from "../whatsapp";

const HELPER_PAGE = 100;

type Heard = "message" | "reaction" | "read" | "conversation";
type Waiting = { seq: number; kind: Heard; raw: JsonValue };

const STRING = { type: "string", minLength: 1 };

export function whatsappConnection(): CodeConnection {
  const people = new People();
  const chats = new Map<string, Conversation>();
  let waiting: Waiting[] = [];
  let seq = 0;
  let state: { state: string; message: string | null } | null = null;

  const wait = (kind: Heard, raw: JsonValue) => {
    seq += 1;
    waiting.push({ seq, kind, raw });
  };
  const heardChat = (raw: JsonValue) => {
    const found = people.conversationOf(raw);
    if (found !== null) chats.set(found.id, found);
    return found;
  };

  const heard: Record<Heard | "state", (data: JsonValue) => boolean> = {
    message: (data) => {
      people.learnMe(data);
      wait("message", data);
      return true;
    },
    reaction: (data) => {
      wait("reaction", data);
      return true;
    },
    read: (data) => {
      wait("read", data);
      return true;
    },
    conversation: (data) => {
      if (heardChat(data) === null) return false;
      wait("conversation", data);
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
    const of = (kind: Heard) => batch.filter((entry) => entry.kind === kind).map(({ raw }) => raw);
    const conversations = of("conversation").flatMap((raw) => heardChat(raw) ?? []);
    const messages: Message[] = of("message").flatMap((raw) => people.messageOf(raw) ?? []);
    const theirChats = [...new Set(messages.map(({ conversation }) => conversation))].map(
      (id) => chats.get(id) ?? { id, service: SERVICE },
    );
    return {
      upTo: batch.at(-1)?.seq ?? seq,
      more: waiting.length > batch.length,
      conversations: [...conversations, ...theirChats],
      messages,
      reactions: of("reaction").flatMap((raw) => people.reactionChangeOf(raw) ?? []),
      reads: of("read").flatMap((raw) => people.readChangeOf(raw) ?? []),
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
      const messages = listOf(answer.messages);
      for (const raw of messages) wait("message", raw);
      const problem = objectOf(answer.problem);
      if (textOf(problem.message)) {
        throw new Error(`Only part of it went out: ${textOf(problem.message)}`);
      }
      return { messages: messages.flatMap((raw) => people.messageOf(raw) ?? []) };
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
          "Up to limit of what arrived since the last drop_events: chats, messages with the chat of each, reactions and reads",
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
