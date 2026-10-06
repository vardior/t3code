import {
  type BotListResult,
  type EnvironmentId,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  type AtomCommandConcurrency,
  type AtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createBotsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  configScheduler: AtomCommandScheduler,
  configConcurrency: AtomCommandConcurrency<{ readonly environmentId: EnvironmentId }>,
  configValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>,
) {
  const rpcList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:bots",
    tag: WS_METHODS.botsList,
    staleTimeMs: 10_000,
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
    }),
    list: (target: { readonly environmentId: EnvironmentId; readonly input: {} }) =>
      listAtom(target.environmentId),
    setPaused: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:bot:set-paused",
      tag: WS_METHODS.botsSetPaused,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
  };
}
