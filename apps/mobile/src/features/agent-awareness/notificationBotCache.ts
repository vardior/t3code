import { type BotSummary, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { loadBotHomeThreads, saveBotHomeThreads } from "../../persistence/imperative";

type NotificationBot = Pick<BotSummary, "id" | "homeThreadId">;

export function persistNotificationBots<
  A extends { readonly bots: ReadonlyArray<NotificationBot> },
  E,
>(environmentId: string, atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) {
  let persistedBots: ReadonlyArray<NotificationBot> | undefined;
  return Atom.transform(atom, (get) => {
    const result = get(atom);
    if (result._tag === "Success" && !result.waiting && result.value.bots !== persistedBots) {
      persistedBots = result.value.bots;
      void saveBotHomeThreads(environmentId, persistedBots).catch(console.warn);
    }
    return result;
  });
}

export async function loadNotificationBotsForEnvironment(
  liveBots: (environmentId: string) => ReadonlyArray<NotificationBot> | null,
) {
  const cached = await loadBotHomeThreads().catch(() => null);
  return (environmentId: string) =>
    liveBots(environmentId) ??
    Object.entries(cached?.[environmentId] ?? {}).map(([homeThreadId, id]) => ({
      id,
      homeThreadId: ThreadId.make(homeThreadId),
    }));
}
