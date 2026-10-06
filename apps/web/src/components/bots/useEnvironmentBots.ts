import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function useEnvironmentBots() {
  const environmentIds = useConnectedEnvironmentIds();
  const queries = useMemo(
    () =>
      environmentIds.map((environmentId) => {
        const atom = serverEnvironment.bots.list({ environmentId, input: {} });
        return { environmentId, atom, refresh: () => appAtomRegistry.refresh(atom) };
      }),
    [environmentIds],
  );
  const queriesAtom = useMemo(
    () =>
      Atom.make((get) =>
        queries.map(({ environmentId, atom, refresh }) => {
          const result = get(atom);
          return {
            environmentId,
            data: Option.getOrNull(AsyncResult.value(result)),
            error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
            isLoading: result._tag === "Initial" || result.waiting,
            refresh,
          };
        }),
      ),
    [queries],
  );
  const results = useAtomValue(queriesAtom);
  return useMemo(
    () => ({
      queries: results,
      bots: results.flatMap(
        ({ environmentId, data, refresh }) =>
          data?.bots.map((bot) => ({ environmentId, bot, refresh })) ?? [],
      ),
    }),
    [results],
  );
}
