# WhatsApp

The source that keeps the person's WhatsApp chats in the `messages` module, and sends through it. It keeps what arrives, in step as messages arrive and every 5 minutes.

It reaches WhatsApp through the `whatsapp` connection, `connections/whatsapp.ts`, which talks to the `whatsapp` helper program, linked to the person's phone as a device. How to add it, link it, update and remove it is in the recipe's `RECIPE.md`.

WhatsApp keeps no copy of chats, so there is no history to fetch: the module keeps the history the phone sends when it is linked, and every message that arrives after. Earlier messages and search beyond what is kept answer nothing. Starting a new chat isn't possible; a reply goes to a chat that is already there.

People carry their phone number as a `phone` handle where WhatsApp gives one, else their WhatsApp id as an `id` handle on the service `WhatsApp`. Each is added to `people` unlinked, so the person links them once in People.

## What it decides

- **How long messages are kept**: `kept_days`, `30`. A message dropped here can't be fetched again.
- **How many chats are listed**: `chats`, `100`, the most recent. A chat beyond them still comes in with its messages.
- **How often it syncs and sends**: syncs every 5 minutes and sends every minute, besides each change. Fixed, as in the bundled `messages-macos`.
