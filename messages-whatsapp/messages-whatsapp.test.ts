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
