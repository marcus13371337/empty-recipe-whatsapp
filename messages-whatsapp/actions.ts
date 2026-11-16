import type { ActionArgs, JobContext } from "@empty/module-sdk";
import { listOf, objectOf, textOf } from "./json";
import { ACCOUNT, CONNECTION } from "./whatsapp";

export async function older() {
  return { messages: [] };
}

export async function search() {
  return { messages: [] };
}

export async function attachment(
  context: JobContext,
  { id }: ActionArgs<"messages-whatsapp/attachment">,
) {
  return context.connectors.call(CONNECTION, "attachment", { id });
}

const ONLY_IN_WHATSAPP = "WhatsApp files open in WhatsApp: open the chat there.";

export async function openAttachment(): Promise<never> {
  throw new Error(ONLY_IN_WHATSAPP);
}

export async function showAttachment(): Promise<never> {
  throw new Error(ONLY_IN_WHATSAPP);
}

export async function openConversation(
  context: JobContext,
  { conversation }: ActionArgs<"messages-whatsapp/openConversation">,
) {
  const [account] = await context
    .collection("messages/accounts")
    .query({ where: { source: context.module, source_id: ACCOUNT.id } });
  const [chat] = await context
    .collection("messages/conversations")
    .query({ where: { account: account?.id ?? "", source_id: conversation } });
  const people = listOf(chat?.participants).map(objectOf);
  const phone = people.length === 1 && people[0]?.kind === "phone" ? textOf(people[0].handle) : null;
  if (!chat || chat.group || phone === null) {
    throw new Error("WhatsApp has no link for this chat: open it in WhatsApp on the phone.");
  }
  await context.openLink(`https://wa.me/${phone.replace(/\D/g, "")}`);
  return { opened: true };
}
