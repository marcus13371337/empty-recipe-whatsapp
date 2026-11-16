import { expect, test } from "@empty/module-sdk/testing";
import { ANNA, BO, ME, setUp } from "./fakeHelper.test-harness";

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
