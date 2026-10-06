import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type BotSummary,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
  type NetworkStatus,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createBotsEnvironmentAtoms } from "./bots.ts";
import { createAtomCommandScheduler } from "./runtime.ts";

it.effect("refreshes bots and details on every server invalidation across mounted clients", () =>
  Effect.gen(function* () {
    const target = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("bots-environment"),
      label: "Bots",
      httpBaseUrl: "https://bots.example.test",
      wsBaseUrl: "wss://bots.example.test",
    });
    const changes = yield* SubscriptionRef.make({});
    let bots: ReadonlyArray<BotSummary> = [
      {
        id: "helper",
        name: "Helper",
        homeThreadId: ThreadId.make("home"),
        scheduledTaskIds: [],
        paused: false,
      },
    ];
    let charter = "Initial charter";
    const client = {
      [WS_METHODS.botsSubscribeChanges]: () => SubscriptionRef.changes(changes),
      [WS_METHODS.botsList]: () => Effect.sync(() => ({ bots })),
      [WS_METHODS.botsGet]: () => Effect.sync(() => ({ charter, workers: [], slackDms: [] })),
    } as unknown as WsRpcProtocolClient;
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online" as const,
        phase: "connected" as const,
        attempt: 1,
        generation: 1,
      }),
      session: yield* SubscriptionRef.make(Option.some({ client } as RpcSession)),
      prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const runtime = Atom.runtime(
      Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map(),
        ),
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      }),
    );
    const config = Atom.make({ environment: { capabilities: { bots: true } } } as ServerConfig);
    const atoms = createBotsEnvironmentAtoms(
      runtime,
      createAtomCommandScheduler(),
      { mode: "serial", key: ({ environmentId }) => environmentId },
      () => config,
    );
    const registries = [AtomRegistry.make(), AtomRegistry.make()];
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => registries.forEach((registry) => registry.dispose())),
    );
    const list = atoms.list({ environmentId: target.environmentId, input: {} });
    const detail = atoms.get({ environmentId: target.environmentId, input: { botId: "helper" } });
    for (const registry of registries) {
      registry.mount(list);
      registry.mount(detail);
      expect(
        (yield* AtomRegistry.getResult(registry, list, { suspendOnWaiting: true })).bots[0]?.paused,
      ).toBe(false);
      expect(
        (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).charter,
      ).toBe(charter);
    }
    for (const next of [
      [{ ...bots[0]!, paused: true, pausedUntil: "2026-10-07T00:00:00Z" }],
      [{ ...bots[0]!, paused: false, homeThreadArchived: true }],
      [
        { ...bots[0]!, homeThreadArchived: false },
        { ...bots[0]!, id: "second" },
      ],
      [],
    ]) {
      bots = next;
      charter += " changed";
      const refreshed = registries.map((registry) => {
        const listReady = Latch.makeUnsafe();
        const detailReady = Latch.makeUnsafe();
        const stopList = registry.subscribe(list, (result) => {
          if (AsyncResult.isSuccess(result) && result.value.bots === next) listReady.openUnsafe();
        });
        const stopDetail = registry.subscribe(detail, (result) => {
          if (AsyncResult.isSuccess(result) && result.value.charter === charter)
            detailReady.openUnsafe();
        });
        return { listReady, detailReady, stopList, stopDetail };
      });
      yield* SubscriptionRef.set(changes, {});
      for (const refresh of refreshed) {
        yield* refresh.listReady.await;
        yield* refresh.detailReady.await;
        refresh.stopList();
        refresh.stopDetail();
      }
    }
  }).pipe(Effect.scoped),
);
