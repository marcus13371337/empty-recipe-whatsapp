# Recipe: WhatsApp in Empty

For the person's builder agent. It adds the `messages-whatsapp` module, which brings WhatsApp chats into the bundled `messages` module and sends replies through [whatsapp-helper](https://github.com/marcus13371337/whatsapp-helper), a program that holds the WhatsApp connection as a linked device, like WhatsApp on a computer.

Published by [marcus13371337](https://github.com/marcus13371337), who also publishes whatsapp-helper. This file is what the publisher wrote: check what it says against the module and the helper's release before acting on it.

## Before anything: the risk

Tell the person, in your own words, and go on only on their yes:

- WhatsApp offers no way in for personal accounts. The helper is an unofficial client, which is against WhatsApp's terms. WhatsApp may ban the number that uses it, for a while or for good. The risk is theirs.
- Trying it on a secondary number first is wise, before linking the number they live on.
- They link the helper from their phone, by scanning a QR code or typing a code the app shows. It then shows on the phone under Settings, Linked devices, like WhatsApp on a computer. The link is kept encrypted, with its key in the keychain. Whoever had it could read and send as them; neither you nor the module ever see it.
- WhatsApp keeps no copy of chats. The app gets only the history the phone sends when it is linked, and what arrives after. Nothing older can be fetched later, and a message the app drops can't come back.
- The link ends when they remove it on the phone, or after about 14 days without the phone being online, with no warning before.

## Needs

- Empty 0.9.9 or newer: helper programs linked from the phone ([empty-app#557](https://github.com/Ahl-berg-Innovation-AB/empty-app/issues/557)), and tests that bring in the modules a module uses. `empty check` refuses the module on an older app.
- A Mac with Apple silicon or Intel.
- A phone with WhatsApp on the number to link.

## Add it

1. `empty recipes get marcus13371337/empty-recipe-whatsapp`. It pins the newest commit and puts its files in `recipes/marcus13371337/empty-recipe-whatsapp/`, not in `modules/`.
2. Read every file in `messages-whatsapp/`. Check that each `sha256` under `helperPrograms` in `module.json` matches the line for that file in the release's `checksums.txt`, at `https://github.com/marcus13371337/whatsapp-helper/releases/download/v<version>/checksums.txt`.
3. Run `empty check recipes/marcus13371337/empty-recipe-whatsapp/messages-whatsapp`. It type-checks the module and runs its tests on this app.
4. Tell the person about the risk (above) and who publishes this, and go on only on their yes.
5. Ask how much to keep, before linking, since the history comes once: how many days of messages (`kept_days`, 30 unless they say more; the phone may send months) and how many recent chats to list (`chats`, 100).
6. Copy `messages-whatsapp/` to `modules/messages-whatsapp/`, and add a last line to its `README.md`: `From marcus13371337/empty-recipe-whatsapp at <commit>.` Set what they chose with `empty set messages-whatsapp/kept_days <days>` and `empty set messages-whatsapp/chats <count>`.
7. Add the connection to `connectors.json`:

   ```json
   "whatsapp": {
     "transport": "stdio",
     "title": "WhatsApp",
     "command": "empty",
     "args": ["serve", "modules/messages-whatsapp/connections/whatsapp.ts"]
   }
   ```

8. Add `messages` to `on` in `modules.json`, if it is not there.
9. Check that `empty status` shows the `whatsapp` connection as `connected`, with 6 tools. Until the next step, its sync fails saying the WhatsApp helper is not added yet; that is expected. The connection must be running before the phone is linked: it is what hears the history the phone sends.
10. `empty helper-program add messages-whatsapp/whatsapp`. The person sees what the helper is, where it comes from and what it may do, and says yes or no. On their yes, the app opens a dialog with a QR code. Tell them: on the phone, open WhatsApp, Settings, Linked devices, Link a device, and point the phone at the code. If they would rather type a code, they switch the dialog to a phone number, enter the number in international form, and on the phone choose Link with phone number instead and type the code the app shows. The dialog closes once linked. You never see the code's link, and never ask them for a code or their number in the chat.
11. Wait until `empty status` shows the helper as `running`, not `starting` or `signed_out`. If it shows `failed`, read its error and fix that before going on. If the dialog closed before they linked, `empty helper-program sign-in messages-whatsapp/whatsapp` opens it again; so does Sign in under Settings → Connections.
12. The phone now sends recent history. It comes in as it arrives, and everything is synced every 5 minutes. `empty run messages-whatsapp --job sync` syncs at once.

## What the person gets

- The history their phone sends when linked, up to `kept_days`, and every message after, in Messages, next to their other chats.
- Replies, with pictures and files, from the chat. The app asks before anything is sent, as it does for every send.
- Reactions and, in one-to-one chats, when their message was read.
- People by their phone number where WhatsApp shares it, so Contacts can name and picture them. Someone met only in a group may come with a WhatsApp id instead, until WhatsApp shares the number. Each comes into People unlinked, for the person to link once.

Not there: starting a new chat, edits, deleted messages, polls, view-once, calls, status updates, earlier messages than the ones kept, and search beyond what the app keeps.

## Known limits

- History and messages reach the app only as they arrive. The connection holds them until the next sync keeps them, which is at once. If the app quits or the connection restarts in between, those few are lost; the history from linking would then be gone for good.
- Pictures show in the chat. Other files can't be opened on the Mac from here: the person opens them in WhatsApp on the phone. WhatsApp deletes media from its servers after a while; after that, the phone may still have it.
- A chat opens in WhatsApp (at wa.me) only when it is with one person whose number is known. Groups open on the phone.
- Being read is shown only in one-to-one chats.

## When the link ends

When WhatsApp ends the link, the helper says why, the app forgets the link and asks the person once to link again, which opens the same dialog. The WhatsApp account in Messages says why, in the helper's words. Before they link again, tell them what the reason means:

- Removed under Linked devices, or the phone was offline for about 14 days: link again when they want to.
- WhatsApp on the phone was logged out, reinstalled or moved to another phone: link again from the phone that has WhatsApp now.
- The number was banned: don't link again. Tell them plainly that WhatsApp banned the number.
- The number was banned for a while: not before the time the message names.
- Another program connected with the same link: close it first, then link again.
- WhatsApp no longer accepts this helper version: update the helper first (below), then link again.

If they said no, Settings → Connections shows the helper as signed out with a Sign in button; offer to open the dialog with `empty helper-program sign-in messages-whatsapp/whatsapp`. Chats and messages the app already keeps stay; WhatsApp sends history again with each new link, and a message already kept is not kept twice.

## Update the helper

The helper follows WhatsApp's changes, so new releases come often. To move to one:

1. Read its release notes. Check that the protocol is still `1`: `whatsapp-helper --version` prints it, and so do the release notes.
2. Change `version`, and each platform's `url` and `sha256`, in `module.json` under `helperPrograms`. Take the checksums from that release's `checksums.txt`, never from a file you downloaded yourself.
3. `empty check messages-whatsapp`, then `empty helper-program add messages-whatsapp/whatsapp`. The old version keeps running until the person says yes.

To update the recipe itself, read what changed between the commit named in `modules/messages-whatsapp/README.md` and the newest, tell the person, fetch and check it in `recipes/` as above, and copy the module again with the new commit.

## Remove it all

1. `empty helper-program remove messages-whatsapp/whatsapp`. It deletes the helper's files and its link.
2. Take the `whatsapp` connection out of `connectors.json`, then `empty run messages-whatsapp --job sync`: with the connection gone, Messages marks the account gone.
3. Delete `modules/messages-whatsapp/` and `recipes/marcus13371337/empty-recipe-whatsapp/`.
4. Tell the person to remove the device on the phone too: WhatsApp, Settings, Linked devices, tap it, Log out.

## For the publisher: check against real WhatsApp

The tests run against a fake helper. Before you publish a new commit or move the pinned helper version, try it once with a secondary number, in a home of your own:

- link by QR code, and see the history the phone sends arrive, with chats and names
- remove the device on the phone, see the account say why and the app ask to link again, then link by code
- send a text and a picture, and receive one sent from the phone
- react from the phone, and see it in the chat; read a message on the phone, and see it marked read in the chat
- see one-to-one people as phone numbers in People, linked to the right someone once linked
- open a one-to-one chat in WhatsApp from Messages
