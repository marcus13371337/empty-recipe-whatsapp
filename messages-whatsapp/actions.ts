import type { ActionAnswer, ActionArgs, JobContext } from "@empty/module-sdk";
import { listOf, numberOf, objectOf, textOf } from "./json";
import { ACCOUNT, CONNECTION, NO_REF } from "./whatsapp";

export async function older() {
  return { messages: [] };
}

export async function search() {
  return { messages: [] };
}

export async function attachment(
  context: JobContext,
  { id }: ActionArgs<"messages-whatsapp/attachment">,
): Promise<ActionAnswer<"messages-whatsapp/attachment">> {
  if (id.startsWith(NO_REF)) throw context.fail("fail.notHandedOver");
  const answer = objectOf(await context.connectors.call(CONNECTION, "attachment", { id }));
  const kept = objectOf(answer.attachment);
  const file = objectOf(answer.file);
  const size = numberOf(kept.size);
  return {
    attachment: {
      id: textOf(kept.id) ?? id,
      name: textOf(kept.name) ?? "",
      media_type: textOf(kept.media_type),
      ...(size !== null && { size }),
    },
    file: { base64: textOf(file.base64) ?? "", media_type: textOf(file.media_type) ?? "" },
    kept: "here",
  };
}

export async function openAttachment(context: JobContext): Promise<never> {
  throw context.fail("fail.onlyInWhatsApp");
}

export async function showAttachment(context: JobContext): Promise<never> {
  throw context.fail("fail.onlyInWhatsApp");
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
  if (!chat || chat.group || phone === null) throw context.fail("fail.noChatLink");
  await context.openLink(`https://wa.me/${phone.replace(/\D/g, "")}`);
  return { opened: true };
}
