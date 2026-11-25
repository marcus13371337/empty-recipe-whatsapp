# empty-recipe-whatsapp

A recipe for [Empty](https://empty.rcusahlberg.se): a person's builder agent follows [RECIPE.md](RECIPE.md) to bring their WhatsApp chats into the app. It adds the `messages-whatsapp` module, which talks to [whatsapp-helper](https://github.com/marcus13371337/whatsapp-helper). It is the WhatsApp twin of [empty-recipe-messenger](https://github.com/marcus13371337/empty-recipe-messenger).

**Unofficial.** WhatsApp offers no API for personal accounts. Using an unofficial client is against WhatsApp's terms and WhatsApp may ban the number. The person takes that risk knowingly; the recipe has their builder tell them first.

## Layout

- `RECIPE.md`: the steps for the builder: the risk, adding, linking, updating and removing.
- `messages-whatsapp/`: the module the builder copies into the app home.
  - `module.written.json` is written by the app from `module.ts`; cloning the recipe reads it, so commit it after each change.
  - `connections/whatsapp.ts` speaks the helper's [protocol](https://github.com/marcus13371337/whatsapp-helper/blob/main/PROTOCOL.md) and keeps what arrives until a sync takes it.
  - `jobs.ts` syncs and sends through the `messages` module, `actions.ts` answers its attachment and open-chat questions.
  - `messages-whatsapp.test.ts` runs it all against `fakeHelper.test-harness.ts`, a stand-in for the helper.

## Checks

`empty check messages-whatsapp` in an app home type-checks the module and runs its tests on that app. CI does the same weekly against the newest Empty release, so a change in Empty that breaks the recipe shows here.
