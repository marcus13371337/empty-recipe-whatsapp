import { expect, test } from "@empty/module-sdk/testing";
import { ANNA, BO, ME, setUp } from "./fakeHelper.test-harness";
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
  for (let minute = 1200; minute > 0; minute -= 1) fake.history("old", BO, `Line ${minute}`, minute + 60);
  fake.history("new", ANNA, "Newest", 1);

  await engine.job("messages-whatsapp/sync");

  expect((await chat("old")).messages).toHaveLength(1200);
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
  expect(kept?.read).not.toBeNull();
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

  expect((await chat("c1")).messages[0]?.read).toBeNull();
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
  expect(mine?.read).not.toBeNull();
});

test("the person's own reaction in the linking history is theirs", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.history("c1", ME, "On my way", 5);
  fake.history("c1", ANNA, "Cake!", 4, { reactions: [{ sender_id: ME.id, emoji: "😍" }] });

  await engine.job("messages-whatsapp/sync");

  const cake = (await chat("c1")).messages.find(({ text }) => text === "Cake!");
  expect(cake?.reactions).toEqual([{ from: null, from_me: true, kind: "😍" }]);
});

test("a message WhatsApp can't carry says to open it in WhatsApp", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("c1", [ANNA]);
  fake.history("c1", ANNA, "", 5, { unsupported: true });

  await engine.job("messages-whatsapp/sync");

  expect((await chat("c1")).messages.map(({ text }) => text)).toEqual([UNSUPPORTED]);
});
