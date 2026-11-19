import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, failureFrom, test } from "@empty/module-sdk/testing";
import { openConversation } from "./actions";
import { ANNA, BO, ME, setUp } from "./fakeHelper.test-harness";
import { BATCH } from "./jobs";
import { UNSUPPORTED } from "./whatsapp";

test("the history the phone sends at linking is kept, chats named as in WhatsApp", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.chat("g1", [ANNA, BO], { group: true, name: "Family" });
  fake.history("c1", ANNA, "Long ago", 60 * 24 * 40);
  fake.history("c1", ANNA, "Dinner on Friday?", 30);
  fake.history("c1", ME, "Yes!", 20);
  fake.history("g1", BO, "Look at this", 10);

  await engine.job("messages-whatsapp/sync");

  const withAnna = await chat("c1");
  expect(withAnna.conversation).toMatchObject({ name: "Anna", group: false, service: "WhatsApp" });
  expect(withAnna.messages.map(({ text, from_me }) => ({ text, from_me }))).toEqual([
    { text: "Dinner on Friday?", from_me: false },
    { text: "Yes!", from_me: true },
  ]);
  const family = await chat("g1");
  expect(family.conversation).toMatchObject({ name: "Family", group: true });
  expect(family.messages[0]).toMatchObject({ text: "Look at this", from_name: "Bo" });
});

test("before the phone is linked a sync keeps nothing and says why; once linked the problem clears", async () => {
  const { engine, fake, chat } = await setUp();
  fake.notLinkedYet();

  await expect(engine.job("messages-whatsapp/sync")).rejects.toThrow();
  const [waiting] = await engine.collection("messages/accounts").query({});
  expect(waiting?.problem).toBe("Nobody is logged in yet. Log in first.");

  fake.linked();
  fake.chat("c1", [ANNA]);
  fake.history("c1", ANNA, "Welcome back", 5);
  await engine.job("messages-whatsapp/sync");

  const [linked] = await engine.collection("messages/accounts").query({});
  expect(linked?.problem).toBeNull();
  expect((await chat("c1")).messages.map(({ text }) => text)).toEqual(["Welcome back"]);
});

test("a linking history larger than one batch, in a chat beyond the chats kept, keeps every message", async () => {
  const { engine, fake, chat } = await setUp();
  await engine.set("messages-whatsapp/chats", 1);
  fake.chat("old", [BO]);
  fake.chat("new", [ANNA]);
  for (let minute = 600; minute > 0; minute -= 1) fake.history("old", BO, `Line ${minute}`, minute + 60);
  fake.history("new", ANNA, "Newest", 1);

  await engine.job("messages-whatsapp/sync");

  expect((await chat("old")).messages).toHaveLength(600);
  expect((await chat("new")).messages).toHaveLength(1);
});

test("history older than the days kept is dropped, and more days kept keep it", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  await engine.set("messages-whatsapp/kept_days", 365);
  fake.history("c1", ANNA, "Last summer", 60 * 24 * 200);
  fake.history("c1", ANNA, "Last week", 60 * 24 * 7);

  await engine.job("messages-whatsapp/sync");

  expect((await chat("c1")).messages.map(({ text }) => text)).toEqual(["Last summer", "Last week"]);
});

for (const [code, words] of [
  ["unlinked", "The device was removed under Linked devices, or the phone was offline for about 14 days."],
  ["phone_gone", "WhatsApp on the phone was logged out, reinstalled or moved to another phone."],
  ["banned", "WhatsApp banned this number."],
  ["temporary_ban", "WhatsApp banned this number until 2026-12-01."],
  ["replaced", "Another program connected with the same link."],
  ["client_outdated", "WhatsApp no longer accepts this helper version. Update it."],
] as const) {
  test(`a link that ended as ${code} wakes a sync, and the account says why in the helper's words`, async () => {
    const { engine, fake, changes } = await setUp();
    fake.chat("c1", [ANNA]);
    await engine.job("messages-whatsapp/sync");
    const before = changes();

    fake.logOut(code, words);
    expect(changes()).toBe(before + 1);
    await expect(engine.job("messages-whatsapp/sync")).rejects.toThrow();

    const [account] = await engine.collection("messages/accounts").query({});
    expect(account?.problem).toBe(words);
  });
}

test("a live message wakes a sync, which keeps it once", async () => {
  const { engine, fake, chat, changes } = await setUp();
  fake.chat("c1", [ANNA]);
  await engine.job("messages-whatsapp/sync");

  fake.arrives("c1", ANNA, "Are you there?");
  expect(changes()).toBe(1);
  await engine.job("messages-whatsapp/sync");
  await engine.job("messages-whatsapp/sync");

  expect((await chat("c1")).messages.map(({ text }) => text)).toEqual(["Are you there?"]);
  expect((await chat("c1")).conversation).toMatchObject({ last_text: "Are you there?" });
});

test("an older message in a later batch leaves the chat's latest on the newer one", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("g1", [ANNA, BO], { group: true, name: "Family" });
  fake.chat("other", [BO]);
  const newer = fake.history("g1", BO, "Newer", 10);
  for (let minute = BATCH; minute > 0; minute -= 1) fake.history("other", BO, `Line ${minute}`, minute + 60);
  fake.history("g1", ANNA, "Older", 60 * 24 * 14);

  await engine.job("messages-whatsapp/sync");

  const family = await chat("g1");
  expect(family.messages).toHaveLength(2);
  expect(family.conversation).toMatchObject({ last_text: "Newer", last_at: newer.sent_at });
});

test("a sync with no events moves a stale latest up to the newest message kept", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("g1", [ANNA, BO], { group: true, name: "Family" });
  const newer = fake.history("g1", BO, "Newer", 10);
  await engine.job("messages-whatsapp/sync");
  const { conversation } = await chat("g1");
  await engine.collection("messages/conversations").update(conversation?.id ?? "", {
    last_text: "Stale",
    last_at: new Date(Date.now() - 15 * 86_400_000).toISOString(),
  });

  await engine.job("messages-whatsapp/sync");

  expect((await chat("g1")).conversation).toMatchObject({ last_text: "Newer", last_at: newer.sent_at });
});

test("a reply that never went out leaves a stale latest corrected by the newest message kept", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("g1", [ANNA, BO], { group: true, name: "Family" });
  const newer = fake.history("g1", BO, "Newer", 10);
  await engine.job("messages-whatsapp/sync");
  const { conversation } = await chat("g1");
  engine.refuse("whatsapp", "send", failureFrom("You said no.", "refused_by_person"));
  await engine.run("messages/send", { conversation: conversation?.id ?? "", text: "Unsent" });
  await engine.collection("messages/conversations").update(conversation?.id ?? "", {
    last_text: "Stale",
    last_at: new Date(Date.now() - 15 * 86_400_000).toISOString(),
  });

  await engine.job("messages-whatsapp/sync");

  expect((await chat("g1")).conversation).toMatchObject({ last_text: "Newer", last_at: newer.sent_at });
});

test("a picture without text stays the chat's latest line through a later sync", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.history("c1", ANNA, "", 5, {
    attachments: [{ id: "a1", kind: "image", type: "image/png", name: "cat.png", ref: "r1" }],
  });
  await engine.job("messages-whatsapp/sync");
  expect((await chat("c1")).conversation?.last_text).toBe("Photo");

  await engine.job("messages-whatsapp/sync");

  expect((await chat("c1")).conversation?.last_text).toBe("Photo");
});

test("a reaction and a read receipt change a message already kept", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  await engine.job("messages-whatsapp/sync");
  const mine = fake.arrives("c1", ME, "See you at eight");
  await engine.job("messages-whatsapp/sync");

  fake.emit("reaction", {
    conversation_id: "c1",
    message_id: String(mine.id),
    sender_id: ANNA.id,
    emoji: "❤️",
    at: new Date().toISOString(),
  });
  fake.emit("read", { conversation_id: "c1", reader_id: ANNA.id, read_at: new Date().toISOString() });
  await engine.job("messages-whatsapp/sync");

  const [kept] = (await chat("c1")).messages;
  expect(kept?.reactions).toMatchObject([
    { from: { handle: ANNA.phone, kind: "phone" }, from_me: false, kind: "❤️" },
  ]);
  expect(kept?.read_at).not.toBeNull();
});

test("a reaction taken back leaves the message without it", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  const said = fake.arrives("c1", ANNA, "Cake!");
  await engine.job("messages-whatsapp/sync");
  const react = (emoji: string) =>
    fake.emit("reaction", {
      conversation_id: "c1",
      message_id: String(said.id),
      sender_id: ANNA.id,
      emoji,
      at: new Date().toISOString(),
    });

  react("😍");
  react("👍");
  await engine.job("messages-whatsapp/sync");
  expect((await chat("c1")).messages[0]?.reactions.map(({ kind }) => kind)).toEqual(["👍"]);

  react("");
  await engine.job("messages-whatsapp/sync");
  expect((await chat("c1")).messages[0]?.reactions).toEqual([]);
});

test("reading on the person's own other device marks none of their messages read", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  await engine.job("messages-whatsapp/sync");
  fake.arrives("c1", ME, "See you at eight");
  await engine.job("messages-whatsapp/sync");

  fake.emit("read", { conversation_id: "c1", reader_id: ME.id, read_at: new Date().toISOString() });
  await engine.job("messages-whatsapp/sync");

  expect((await chat("c1")).messages[0]?.read_at).toBeNull();
});

test("a read receipt stays when a later sync brings the chat again", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.history("c1", ME, "See you at eight", 2);
  await engine.job("messages-whatsapp/sync");

  fake.emit("read", { conversation_id: "c1", reader_id: ANNA.id, read_at: new Date().toISOString() });
  await engine.job("messages-whatsapp/sync");
  fake.arrives("c1", ANNA, "Great");
  await engine.job("messages-whatsapp/sync");

  const [mine] = (await chat("c1")).messages;
  expect(mine?.read_at).not.toBeNull();
});

test("the person's own reaction in the linking history is theirs", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.history("c1", ME, "On my way", 5);
  fake.history("c1", ANNA, "Cake!", 4, { reactions: [{ sender_id: ME.id, emoji: "😍" }] });

  await engine.job("messages-whatsapp/sync");

  const cake = (await chat("c1")).messages.find(({ text }) => text === "Cake!");
  expect(cake?.reactions).toMatchObject([{ from: null, from_me: true, kind: "😍" }]);
});

test("a message WhatsApp can't carry says to open it in WhatsApp", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.history("c1", ANNA, "", 5, { unsupported: true });

  await engine.job("messages-whatsapp/sync");

  expect((await chat("c1")).messages.map(({ text }) => text)).toEqual([UNSUPPORTED]);
});

test("people carry their phone number where WhatsApp gives one, else their WhatsApp id, and come into people unlinked", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("g1", [ANNA, BO], { group: true, name: "Family" });
  fake.history("g1", BO, "Hi all", 5);

  await engine.job("messages-whatsapp/sync");

  const family = await chat("g1");
  expect(family.conversation?.participants).toMatchObject([
    { handle: ANNA.phone, kind: "phone", source_name: "Anna" },
    { handle: BO.id, kind: "id", source_name: "Bo" },
  ]);
  expect(family.messages[0]).toMatchObject({ from_handle: BO.id, from_kind: "id" });
  const handles = await engine.collection("people/handles").query({});
  expect(handles).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "phone", service: null, value: ANNA.phone, someone: null }),
      expect.objectContaining({ kind: "id", service: "WhatsApp", value: BO.id, someone: null }),
    ]),
  );
});

test("a reply with a picture goes out through the helper, which gets the file in its folder", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.history("c1", ANNA, "Photo?", 5);
  await engine.job("messages-whatsapp/sync");
  const { conversation } = await chat("c1");

  await engine.run("messages/send", {
    conversation: conversation?.id ?? "",
    text: "Here",
    files: [{ name: "beach.png", base64: Buffer.from("a picture").toString("base64") }],
  });

  const sent = fake.asked.find(({ method }) => method === "send");
  expect(sent?.params).toMatchObject({ conversation_id: "c1", text: "Here" });
  expect(JSON.stringify(sent?.params.files)).toContain(join(fake.folder, "outgoing"));
  expect(readdirSync(join(fake.folder, "outgoing"))).toEqual([]);
  const messages = (await chat("c1")).messages;
  expect(messages.at(-1)).toMatchObject({ text: "Here", from_me: true, pending: null });
  expect(messages.at(-1)?.attachments[0]?.id).toBe("ref-0");
});

test("a reply is kept from the helper's answer, before its echo arrives", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.arrives("c1", ANNA, "Hi");
  await engine.job("messages-whatsapp/sync");
  fake.noEchoes();
  const { conversation } = await chat("c1");

  await engine.run("messages/send", { conversation: conversation?.id ?? "", text: "Hello" });

  expect((await chat("c1")).messages.map(({ text, pending }) => ({ text, pending }))).toEqual([
    { text: "Hi", pending: null },
    { text: "Hello", pending: null },
  ]);
});

test("a reply the person said no to is kept as refused by them", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  await engine.job("messages-whatsapp/sync");
  const { conversation } = await chat("c1");
  engine.refuse("whatsapp", "send", failureFrom("You said no.", "refused_by_person"));

  await engine.run("messages/send", { conversation: conversation?.id ?? "", text: "Here" });

  const reply = (await chat("c1")).messages.find(({ text }) => text === "Here");
  expect(reply?.failed_because).toBe("refused_by_person");
});

test("a reply whose send timed out is kept as maybe sent, and not sent again", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  await engine.job("messages-whatsapp/sync");
  const { conversation } = await chat("c1");
  engine.refuse("whatsapp", "send", failureFrom("Too slow.", "timeout"));

  await engine.run("messages/send", { conversation: conversation?.id ?? "", text: "Here" });
  await engine.job("messages-whatsapp/send");

  const reply = (await chat("c1")).messages.find(({ text }) => text === "Here");
  expect(reply?.failed_because).toBe("maybe_sent");
  expect(engine.calls.filter(({ tool }) => tool === "send")).toHaveLength(1);
});

test("an attachment is fetched from the helper, and its file in the helper's folder is removed", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.history("c1", ANNA, "", 5, {
    attachments: [{ id: "a1", kind: "image", type: "image/png", name: "cat.png", ref: "r1" }],
  });
  await engine.job("messages-whatsapp/sync");
  const [message] = (await chat("c1")).messages;

  const answer = await engine.run("messages-whatsapp/attachment", {
    account: "whatsapp",
    id: message?.attachments[0]?.id ?? "",
  });

  expect(answer).toMatchObject({
    kept: "here",
    file: { base64: Buffer.from("a picture").toString("base64"), media_type: "image/png" },
  });
  expect(existsSync(join(fake.folder, "r1.png"))).toBe(false);
});

test("a file WhatsApp has not handed over says to open the chat in WhatsApp, and the helper is not asked", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.history("c1", ANNA, "", 5, {
    attachments: [{ id: "a1", kind: "document", type: "application/pdf", name: "plan.pdf" }],
  });
  await engine.job("messages-whatsapp/sync");
  const [message] = (await chat("c1")).messages;

  await expect(
    engine.run("messages-whatsapp/attachment", {
      account: "whatsapp",
      id: message?.attachments[0]?.id ?? "",
    }),
  ).rejects.toThrow("has not handed this file over");
  expect(fake.asked.filter(({ method }) => method === "attachment")).toEqual([]);
});

test("a WhatsApp file can't be opened on the Mac, and says to open the chat in WhatsApp", async () => {
  const { engine } = await setUp();

  await expect(
    engine.run("messages-whatsapp/openAttachment", { account: "whatsapp", id: "r1" }),
  ).rejects.toThrow("open the chat there");
});

test("earlier messages are none, since WhatsApp keeps no history, and the helper is never asked for any", async () => {
  const { engine, fake } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.history("c1", ANNA, "First", 60);
  await engine.job("messages-whatsapp/sync");

  const answer = await engine.run("messages-whatsapp/older", {
    account: "whatsapp",
    conversation: "c1",
    before: new Date().toISOString(),
    limit: 10,
  });

  expect(answer).toEqual({ messages: [] });
  expect(fake.asked.filter(({ method }) => method === "messages")).toEqual([]);
});

test("a failed sync keeps the reason's code beside its words", async () => {
  const { engine, fake } = await setUp();
  fake.chat("c1", [ANNA]);
  engine.refuse("whatsapp", "conversations", failureFrom("Link again.", "needs_login"));

  await expect(engine.job("messages-whatsapp/sync")).rejects.toThrow();

  const [account] = await engine.collection("messages/accounts").query({});
  expect(account?.failed_because).toBe("needs_login");
});

test("a sync that only timed out leaves the account without a problem", async () => {
  const { engine, fake } = await setUp();
  fake.chat("c1", [ANNA]);
  await engine.job("messages-whatsapp/sync");
  engine.refuse("whatsapp", "conversations", failureFrom("Too slow.", "timeout"));

  await expect(engine.job("messages-whatsapp/sync")).rejects.toThrow();

  const [account] = await engine.collection("messages/accounts").query({});
  expect(account?.problem).toBeNull();
});

test("a sync with the WhatsApp connection gone marks the account gone", async () => {
  const { engine, fake } = await setUp();
  fake.chat("c1", [ANNA]);
  await engine.job("messages-whatsapp/sync");

  engine.disconnect("whatsapp");
  await engine.job("messages-whatsapp/sync");

  const [account] = await engine.collection("messages/accounts").query({});
  expect(account?.gone_at).not.toBeNull();
});

test("a chat with one person opens in WhatsApp at wa.me with their number, and a group says to use the phone", async () => {
  const { engine, fake } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.chat("g1", [ANNA, BO], { group: true, name: "Family" });
  await engine.job("messages-whatsapp/sync");

  const opened: string[] = [];
  const context = {
    ...engine.context("messages-whatsapp"),
    openLink: async (url: string) => void opened.push(url),
  };

  await openConversation(context, { account: "whatsapp", conversation: "c1" });

  expect(opened).toEqual(["https://wa.me/46701234567"]);
  await expect(
    openConversation(context, { account: "whatsapp", conversation: "g1" }),
  ).rejects.toThrow("open it in WhatsApp on the phone");
});

test("a reaction and a read receipt reach a message kept before the connection restarted", async () => {
  const { engine, fake, chat, restart } = await setUp();
  fake.chat("c1", [ANNA]);
  const mine = fake.history("c1", ME, "See you at eight", 5);
  await engine.job("messages-whatsapp/sync");
  await restart();

  fake.emit("reaction", {
    conversation_id: "c1",
    message_id: String(mine.id),
    sender_id: ANNA.id,
    emoji: "👍",
    at: new Date().toISOString(),
  });
  fake.emit("read", { conversation_id: "c1", reader_id: ANNA.id, read_at: new Date().toISOString() });
  await engine.job("messages-whatsapp/sync");

  const [kept] = (await chat("c1")).messages;
  expect(kept?.reactions).toMatchObject([{ from: { handle: ANNA.phone }, from_me: false, kind: "👍" }]);
  expect(kept?.read_at).not.toBeNull();
});

test("the person's own reaction is theirs before any message of theirs was seen", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  const cake = fake.history("c1", ANNA, "Cake!", 5, { reactions: [{ sender_id: ME.id, emoji: "😍" }] });
  await engine.job("messages-whatsapp/sync");

  fake.emit("reaction", {
    conversation_id: "c1",
    message_id: String(cake.id),
    sender_id: ME.id,
    emoji: "🎉",
    at: new Date().toISOString(),
  });
  await engine.job("messages-whatsapp/sync");

  expect((await chat("c1")).messages[0]?.reactions).toMatchObject([{ from: null, from_me: true, kind: "🎉" }]);
  const handles = await engine.collection("people/handles").query({});
  expect(handles.map(({ value }) => value)).not.toContain(ME.phone);
});

test("in a group, a reaction from someone who has left stays theirs, not the person's", async () => {
  const { engine, fake, chat } = await setUp();
  const gone = { id: "46709999999@s.whatsapp.net", name: "Cleo", phone: "+46709999999" };
  fake.chat("g1", [ANNA, BO], { group: true, name: "Family" });
  fake.history("g1", ANNA, "Cake!", 5, { reactions: [{ sender_id: gone.id, emoji: "😍" }] });

  await engine.job("messages-whatsapp/sync");

  expect((await chat("g1")).messages[0]?.reactions).toMatchObject([
    { from: { handle: gone.id }, from_me: false, kind: "😍" },
  ]);
});

test("the person's own reaction in a group is theirs once a one-to-one chat showed who they are", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.chat("g1", [ANNA, BO], { group: true, name: "Family" });
  const hi = fake.history("c1", ANNA, "Hi", 10);
  fake.history("g1", BO, "Cake!", 5, { reactions: [{ sender_id: ME.id, emoji: "😍" }] });
  fake.emit("reaction", {
    conversation_id: "c1",
    message_id: String(hi.id),
    sender_id: ME.id,
    emoji: "👋",
    at: new Date().toISOString(),
  });

  await engine.job("messages-whatsapp/sync");

  expect((await chat("g1")).messages[0]?.reactions).toMatchObject([{ from: null, from_me: true, kind: "😍" }]);
});
