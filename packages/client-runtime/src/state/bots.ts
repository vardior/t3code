import {
  type BotListResult,
  type EnvironmentId,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  type AtomCommandConcurrency,
  type AtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createBotsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  configScheduler: AtomCommandScheduler,
  configConcurrency: AtomCommandConcurrency<{ readonly environmentId: EnvironmentId }>,
  configValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>,
) {
  const changes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:server:bots:changes",
    tag: WS_METHODS.botsSubscribeChanges,
  });
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    changes({ environmentId, input: {} });
  const rpcList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:bots",
    tag: WS_METHODS.botsList,
    staleTimeMs: 10_000,
    refreshTrigger,
  });
  const noBots = AsyncResult.success<BotListResult>({ bots: [] });
  const listAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.transform(rpcList({ environmentId, input: {} }), (get, source) => {
      const config = get(configValueAtom(environmentId));
      if (config === null) return AsyncResult.initial<BotListResult, never>(true);
      return config.environment.capabilities.bots === true ? get(source) : noBots;
    }),
  );
  return {
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:bot",
      tag: WS_METHODS.botsGet,
      staleTimeMs: 10_000,
      refreshTrigger,
    }),
    list: (target: { readonly environmentId: EnvironmentId; readonly input: {} }) =>
      listAtom(target.environmentId),
    reorder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:bot:reorder",
      tag: WS_METHODS.botsReorder,
      scheduler: configScheduler,
      concurrency: configConcurrency,
      onSettled: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(rpcList({ environmentId, input: {} }))),
    }),
    setPaused: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:bot:set-paused",
      tag: WS_METHODS.botsSetPaused,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
  };
}
