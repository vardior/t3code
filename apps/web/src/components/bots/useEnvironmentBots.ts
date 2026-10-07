import { useAtomValue } from "@effect/atom-react";
import { botNeedsYou } from "@t3tools/client-runtime/state/bot-conversation";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSummaries } from "../../state/presentation";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { retainEnvironmentBotQueries } from "./environmentBots.logic";

const environmentBotsAtom = Atom.make((get) => {
  const current = get(environmentSummaries.environmentIdsAtom).map((environmentId) => {
    const atom = serverEnvironment.bots.list({ environmentId, input: {} });
    const result = get(atom);
    return {
      environmentId,
      supported:
        get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities.bots ===
        true,
      data: Option.getOrNull(AsyncResult.value(result)),
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      isLoading: result._tag === "Initial" || result.waiting,
      refresh: () => appAtomRegistry.refresh(atom),
    };
  });
  const previous = Option.getOrNull(
    get.self<{ readonly queries: ReadonlyArray<(typeof current)[number]> }>(),
  );
  const queries = retainEnvironmentBotQueries(current, previous?.queries ?? []);
  return {
    queries,
    bots: queries.flatMap(
      ({ environmentId, data, refresh }) =>
        data?.bots.map((bot) => ({ environmentId, bot, refresh })) ?? [],
    ),
  };
}).pipe(Atom.keepAlive);

const botsNeedsYouCountAtom = Atom.make((get) => {
  let count = 0;
  for (const { environmentId, data } of get(environmentBotsAtom).queries) {
    if (!data?.bots.length) continue;
    const shells = get(environmentThreadShells.environmentThreadIndexAtom(environmentId));
    for (const bot of data.bots) {
      const source = shells.get(bot.homeThreadId);
      if (botNeedsYou(bot, source ? presentThreadShell(environmentId, source) : null)) count += 1;
    }
  }
  return count;
});

export function useBotsNeedsYouCount() {
  return useAtomValue(botsNeedsYouCountAtom);
}

export function useEnvironmentBots() {
  return useAtomValue(environmentBotsAtom);
}

export function refreshEnvironmentBots() {
  for (const query of appAtomRegistry.get(environmentBotsAtom).queries) {
    if (!query.isLoading) query.refresh();
  }
}
