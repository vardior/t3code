import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

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
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:bots",
      tag: WS_METHODS.botsList,
      staleTimeMs: 10_000,
    }),
    setPaused: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:bot:set-paused",
      tag: WS_METHODS.botsSetPaused,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
  };
}
