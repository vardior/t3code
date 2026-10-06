import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSummaries } from "../../state/presentation";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const environmentBotsAtom = Atom.make((get) => {
  const queries = get(environmentSummaries.connectedEnvironmentIdsAtom).map((environmentId) => {
    const atom = serverEnvironment.bots.list({ environmentId, input: {} });
    const result = get(atom);
    return {
      environmentId,
      data: Option.getOrNull(AsyncResult.value(result)),
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      isLoading: result._tag === "Initial" || result.waiting,
      refresh: () => appAtomRegistry.refresh(atom),
    };
  });
  return {
    queries,
    bots: queries.flatMap(
      ({ environmentId, data, refresh }) =>
        data?.bots.map((bot) => ({ environmentId, bot, refresh })) ?? [],
    ),
  };
});

export function useEnvironmentBots() {
  return useAtomValue(environmentBotsAtom);
}

export function refreshEnvironmentBots() {
  for (const query of appAtomRegistry.get(environmentBotsAtom).queries) {
    if (!query.isLoading) query.refresh();
  }
}
