import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";
import { AppState } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";

export function useHomeBots(environmentIds: ReadonlyArray<EnvironmentId>) {
  const queries = useMemo(
    () =>
      environmentIds.map((environmentId) => {
        const atom = serverEnvironment.bots.list({ environmentId, input: {} });
        return { environmentId, atom, refresh: () => appAtomRegistry.refresh(atom) };
      }),
    [environmentIds],
  );
  const botsAtom = useMemo(
    () =>
      Atom.make((get) =>
        queries.flatMap(({ environmentId, atom, refresh }) => {
          const data = Option.getOrNull(AsyncResult.value(get(atom)));
          return data?.bots.map((bot) => ({ environmentId, bot, refresh })) ?? [];
        }),
      ).pipe(Atom.withLabel("mobile:home-bots")),
    [queries],
  );
  useFocusEffect(
    useCallback(() => {
      const refresh = () => queries.forEach((query) => query.refresh());
      refresh();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
      return () => subscription.remove();
    }, [queries]),
  );
  return useAtomValue(botsAtom);
}
