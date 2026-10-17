import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  RuntimeRequestId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  IdleCompactionAdmission,
  IdleCompactionPauseGuard,
  idleCompactionCandidate,
  sameIdleCompactionCandidate,
} from "./IdleCompactionPolicy.ts";
import * as ForkIdleCompactionService from "./ForkIdleCompactionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const threadId = ThreadId.make("idle-thread");
const instanceId = ProviderInstanceId.make("codex");
const providerThreadId = ProviderThreadId.make("idle-provider-thread");
const at = (milliseconds: number) => DateTime.makeUnsafe(milliseconds);
const minute = 60_000;
type Fixture = {
  -readonly [
    K in keyof OrchestrationV2ThreadProjection
  ]: OrchestrationV2ThreadProjection[K] extends ReadonlyArray<infer Row>
    ? Row[]
    : OrchestrationV2ThreadProjection[K];
};
const fixture = (): Fixture => ({
  thread: {
    id: threadId,
    projectId: ProjectId.make("idle-project"),
    title: "Idle",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    branch: null,
    activeProviderThreadId: providerThreadId,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: at(0),
    updatedAt: at(0),
    lastVisitedAt: null,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    settledOverride: null,
  },
  runs: [
    {
      id: RunId.make("idle-run"),
      threadId,
      ordinal: 1,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-6.1-sol" },
      providerThreadId,
      userMessageId: MessageId.make("idle-message"),
      rootNodeId: null,
      activeAttemptId: RunAttemptId.make("idle-attempt"),
      status: "completed",
      requestedAt: at(0),
      startedAt: at(0),
      completedAt: at(0),
      checkpointId: null,
      contextHandoffId: null,
    },
  ],
  providerTurns: [
    {
      id: ProviderTurnId.make("idle-turn"),
      providerThreadId,
      nodeId: NodeId.make("idle-node"),
      runAttemptId: RunAttemptId.make("idle-attempt"),
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed",
      startedAt: at(0),
      completedAt: at(0),
      tokenUsage: { usedTokens: 200_001, updatedAt: DateTime.formatIso(at(0)) },
    },
  ],
  providerThreads: [
    {
      id: providerThreadId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "synthetic-native",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: at(0),
      updatedAt: at(0),
      contextUsage: { usedTokens: 200_001 },
    },
  ],
  messages: [],
  nodes: [],
  subagents: [],
  runtimeRequests: [],
  providerSessions: [],
  attempts: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: at(0),
});

describe("idle compaction eligibility", () => {
  it("uses accepted root-turn occupancy instead of cumulative billing", () => {
    const state = fixture();
    state.attempts.push({
      id: RunAttemptId.make("idle-attempt"),
      nativeThreadId: "synthetic-native",
      runId: state.runs[0]!.id,
      attemptOrdinal: 1,
      rootNodeId: NodeId.make("idle-node"),
      providerInstanceId: instanceId,
      providerThreadId,
      providerTurnId: state.providerTurns[0]!.id,
      reason: "initial",
      status: "completed",
      startedAt: at(0),
      completedAt: at(0),
    });
    state.providerTurns[0] = {
      ...state.providerTurns[0]!,
      tokenUsage: {
        usedTokens: 200_000,
        inputTokens: 900_000,
        updatedAt: DateTime.formatIso(at(0)),
      },
    };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
    state.providerTurns[0] = {
      ...state.providerTurns[0]!,
      tokenUsage: { usedTokens: 200_001, updatedAt: DateTime.formatIso(at(0)) },
    };
    assert.isDefined(idleCompactionCandidate(state, 54 * minute));
    state.providerThreads[0] = {
      ...state.providerThreads[0]!,
      contextUsage: null,
      nativeThreadRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "different-native",
        strength: "strong",
      },
    };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
  });
  it("excludes pending approvals, unanswered user requests, and nested nodes", () => {
    for (const kind of ["user_input", "command"] as const) {
      const state = fixture();
      state.runtimeRequests.push({
        id: RuntimeRequestId.make("request"),
        nodeId: NodeId.make("request-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: at(0),
        resolvedAt: null,
      });
      assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
    }
    const state = fixture();
    state.nodes.push({
      id: NodeId.make("nested"),
      threadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: NodeId.make("nested"),
      kind: "subagent",
      status: "waiting",
      countsForRun: false,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: at(0),
      completedAt: null,
    });
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
  });

  it("requires strictly more than 200000 current tokens, at 54 minutes and before 60", () => {
    const state = fixture();
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute - 1));
    assert.isDefined(idleCompactionCandidate(state, 54 * minute));
    assert.isUndefined(idleCompactionCandidate(state, 60 * minute));
    state.providerThreads[0] = {
      ...state.providerThreads[0]!,
      contextUsage: { usedTokens: 200_000, totalProcessedTokens: 1_000_000 },
    };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
  });
  it("ignores UI metadata and invalidates an old deadline on provider activity", () => {
    const state = fixture();
    const candidate = idleCompactionCandidate(state, 54 * minute)!;
    state.thread = { ...state.thread, title: "Renamed", updatedAt: at(54 * minute) };
    assert.isTrue(
      sameIdleCompactionCandidate(candidate, idleCompactionCandidate(state, 54 * minute)),
    );
    state.runs[0] = { ...state.runs[0]!, completedAt: at(minute) };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
    assert.isFalse(
      sameIdleCompactionCandidate(candidate, idleCompactionCandidate(state, 55 * minute)),
    );
  });
  it.each([
    "preparing",
    "starting",
    "queued",
    "running",
    "waiting",
    "failed",
    "interrupted",
    "cancelled",
  ] as const)("excludes %s runs", (status) => {
    const state = fixture();
    state.runs[0] = { ...state.runs[0]!, status };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
  });
  it("excludes archived, deleted, settled, held and stopped work", () => {
    for (const field of ["archivedAt", "deletedAt", "settledAt"] as const) {
      const state = fixture();
      state.thread = { ...state.thread, [field]: at(1) };
      assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
    }
    const state = fixture();
    state.runs[0] = { ...state.runs[0]!, queueHeld: true };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
    state.runs[0] = {
      ...state.runs[0]!,
      queueHeld: false,
      delegatedCompletion: { disposition: "stopped", nextGeneration: 1, delivery: null },
    };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
  });
  it("waits on a pending usage limit but not on one a later run outlived", () => {
    const state = fixture();
    const limited = {
      runId: state.runs[0]!.id,
      resetAt: DateTime.formatIso(at(60 * minute)),
      autoResume: true,
    };
    state.thread = { ...state.thread, limitRecovery: limited };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
    state.thread = {
      ...state.thread,
      limitRecovery: { ...limited, resetAt: DateTime.formatIso(at(0)) },
    };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
    state.thread = {
      ...state.thread,
      limitRecovery: {
        ...limited,
        runId: RunId.make("run:earlier"),
        resetAt: DateTime.formatIso(at(0)),
      },
    };
    assert.isDefined(idleCompactionCandidate(state, 54 * minute));
  });
  it("excludes background work and paused provider goals", () => {
    const state = fixture();
    state.providerThreads[0] = {
      ...state.providerThreads[0]!,
      pendingBackgroundTasks: [{ taskId: "task", kind: "command" }],
    };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
    state.providerThreads[0] = {
      ...state.providerThreads[0]!,
      pendingBackgroundTasks: [],
      goal: { objective: "work", status: "paused" },
    };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
  });

  it("excludes live native subagents, open user items, and snoozed work", () => {
    const state = fixture();
    state.subagents.push({
      id: NodeId.make("native-child"),
      threadId,
      runId: state.runs[0]!.id,
      parentNodeId: NodeId.make("parent-node"),
      origin: "provider_native",
      createdBy: "agent",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "synthetic",
      title: null,
      model: null,
      status: "running",
      result: null,
      startedAt: at(0),
      completedAt: null,
      updatedAt: at(0),
    });
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
    state.subagents = [];
    state.thread = { ...state.thread, snoozedUntil: at(60 * minute) };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
    state.thread = { ...state.thread, snoozedUntil: at(53 * minute) };
    assert.isDefined(idleCompactionCandidate(state, 54 * minute));
  });
  it("never repeats an idle compaction even with stale occupancy", () => {
    const state = fixture();
    state.runs[0] = { ...state.runs[0]!, userMessageId: MessageId.make("idle-compact:previous") };
    assert.isUndefined(idleCompactionCandidate(state, 54 * minute));
  });
});

const adapter = {
  supportsCompaction: true,
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Effect worker is disabled"),
};
const database = SqlitePersistence.layerMemory;
const registry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  CommandReceiptStore.layer.pipe(Layer.provide(database)),
  registry,
  ProviderReplayHarness.layerWithRegistry({ name: "idle-compaction" }, registry, {
    databaseLayer: database,
    runEffectWorker: false,
  }),
);

const seed = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const state = fixture();
  yield* store.apply({
    id: EventId.make("idle-created"),
    type: "thread.created",
    threadId,
    occurredAt: at(0),
    payload: state.thread,
  });
  yield* store.apply({
    id: EventId.make("idle-run"),
    type: "run.updated",
    threadId,
    occurredAt: at(0),
    payload: state.runs[0]!,
  });
  yield* store.apply({
    id: EventId.make("idle-provider"),
    type: "provider-thread.updated",
    threadId,
    occurredAt: at(0),
    payload: state.providerThreads[0]!,
  });
  yield* store.apply({
    id: EventId.make("idle-turn"),
    type: "provider-turn.updated",
    threadId,
    occurredAt: at(0),
    payload: state.providerTurns[0]!,
  });
  return state;
});

describe("idle compaction admission", () => {
  it.effect.each([120_001, 200_001])(
    "does not enqueue settled %s-token work before 54 minutes",
    (usedTokens) =>
      Effect.gen(function* () {
        const state = yield* seed;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        yield* store.apply({
          id: EventId.make("settled-provider-occupancy"),
          type: "provider-thread.updated",
          threadId,
          occurredAt: at(0),
          payload: { ...state.providerThreads[0]!, contextUsage: { usedTokens } },
        });
        yield* store.apply({
          id: EventId.make("settled-occupancy"),
          type: "provider-turn.updated",
          threadId,
          occurredAt: at(0),
          payload: {
            ...state.providerTurns[0]!,
            tokenUsage: { usedTokens, maxTokens: 150_000, updatedAt: DateTime.formatIso(at(0)) },
          },
        });
        const service = yield* ForkIdleCompactionService.make;
        const o = yield* Orchestrator.OrchestratorV2;
        yield* service.sweep;
        assert.lengthOf((yield* o.getThreadRecords(threadId, ["messages"])).messages, 0);
        yield* TestClock.adjust(54 * minute - 1);
        yield* service.sweep;
        assert.lengthOf((yield* o.getThreadRecords(threadId, ["messages"])).messages, 0);
        yield* TestClock.adjust(1);
        yield* service.sweep;
        const messages = (yield* o.getThreadRecords(threadId, ["messages"])).messages;
        assert.lengthOf(messages, usedTokens === 200_001 ? 1 : 0);
        if (usedTokens === 200_001) assert.equal(messages[0]!.text, "/compact");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "checks bot pause at admission and admits after resume without consuming the generation",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* TestClock.adjust(54 * minute);
        let paused = true;
        let checks = 0;
        const service = yield* ForkIdleCompactionService.make.pipe(
          Effect.provideService(IdleCompactionPauseGuard, (candidateThreadId) =>
            Effect.sync(() => {
              assert.equal(candidateThreadId, threadId);
              checks++;
              return paused;
            }),
          ),
        );
        const o = yield* Orchestrator.OrchestratorV2;
        yield* service.sweep;
        yield* (yield* ForkIdleCompactionService.make.pipe(
          Effect.provideService(IdleCompactionPauseGuard, () => Effect.succeed(true)),
        )).sweep;
        assert.lengthOf((yield* o.getThreadRecords(threadId, ["messages"])).messages, 0);
        assert.equal(checks, 1);
        paused = false;
        yield* service.sweep;
        assert.lengthOf((yield* o.getThreadRecords(threadId, ["messages"])).messages, 1);
        assert.equal(checks, 2);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("the scoped server worker recovers due maintenance at startup", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* TestClock.adjust(54 * minute);
      const o = yield* Orchestrator.OrchestratorV2;
      const admitted = yield* Deferred.make<void>();
      yield* o.streamStoredEvents.pipe(
        Stream.map((stored) => stored.event),
        Stream.runForEach((event) =>
          event.type === "run.created" && event.payload.userMessageId.startsWith("idle-compact:")
            ? Deferred.succeed(admitted, undefined)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      const service = yield* ForkIdleCompactionService.make;
      yield* service.start();
      yield* Deferred.await(admitted);
      assert.lengthOf((yield* o.getThreadRecords(threadId, ["messages"])).messages, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("blocks maintenance when a completed delegated task has fresh queued child work", () =>
    Effect.gen(function* () {
      const state = yield* seed;
      yield* TestClock.adjust(54 * minute);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const childId = ThreadId.make("live-child");
      yield* store.apply({
        id: EventId.make("child-created"),
        type: "thread.created",
        threadId: childId,
        occurredAt: at(0),
        payload: {
          ...state.thread,
          id: childId,
          lineage: {
            rootThreadId: threadId,
            parentThreadId: threadId,
            relationshipToParent: "subagent",
          },
          creationSource: "mcp",
          activeProviderThreadId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("child-queued"),
        type: "run.updated",
        threadId: childId,
        occurredAt: at(54 * minute),
        payload: {
          ...state.runs[0]!,
          id: RunId.make("child-run"),
          threadId: childId,
          status: "queued",
          completedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("delegated-child"),
        type: "subagent.updated",
        threadId,
        occurredAt: at(0),
        payload: {
          id: NodeId.make("delegated-child"),
          threadId,
          runId: state.runs[0]!.id,
          parentNodeId: NodeId.make("parent-node"),
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          providerThreadId: null,
          childThreadId: childId,
          nativeTaskRef: null,
          prompt: "synthetic",
          title: null,
          model: null,
          status: "completed",
          result: null,
          startedAt: at(0),
          completedAt: at(0),
          updatedAt: at(0),
        },
      });
      yield* (yield* ForkIdleCompactionService.make).sweep;
      const o = yield* Orchestrator.OrchestratorV2;
      assert.lengthOf((yield* o.getThreadRecords(threadId, ["messages"])).messages, 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not retry a rejected attempt across restart", () =>
    Effect.gen(function* () {
      const state = yield* seed;
      yield* TestClock.adjust(54 * minute);
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.upsert({
        commandId: CommandId.make(`idle-compact:${state.runs[0]!.id}`),
        threadId,
        commandType: "message.dispatch",
        acceptedAt: at(54 * minute),
        resultSequence: 0,
        status: "rejected",
        error: "synthetic refusal",
      });
      yield* (yield* ForkIdleCompactionService.make).sweep;
      yield* (yield* ForkIdleCompactionService.make).sweep;
      const o = yield* Orchestrator.OrchestratorV2;
      assert.lengthOf((yield* o.getThreadRecords(threadId, ["messages"])).messages, 0);
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("skips unsupported adapters without opening a session", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* TestClock.adjust(54 * minute);
      const service = yield* ForkIdleCompactionService.make.pipe(
        Effect.provideService(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
          get: () => Effect.succeed({ ...adapter, supportsCompaction: false }),
          list: () => Effect.succeed([instanceId]),
        }),
      );
      yield* service.sweep;
      const o = yield* Orchestrator.OrchestratorV2;
      assert.lengthOf((yield* o.getThreadRecords(threadId, ["messages"])).messages, 0);
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("does not catch up long-expired deadlines on startup", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* TestClock.adjust(60 * minute);
      yield* (yield* ForkIdleCompactionService.make).sweep;
      const o = yield* Orchestrator.OrchestratorV2;
      assert.lengthOf((yield* o.getThreadRecords(threadId, ["messages"])).messages, 0);
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("failure with stale high usage cannot loop, and fresh activity arms again", () =>
    Effect.gen(function* () {
      const state = yield* seed;
      yield* TestClock.adjust(54 * minute);
      const service = yield* ForkIdleCompactionService.make;
      const o = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* service.sweep;
      const compactRun = (yield* o.getThreadRecords(threadId, ["runs"])).runs.at(-1)!;
      yield* store.apply({
        id: EventId.make("compact-failed"),
        type: "run.updated",
        threadId,
        occurredAt: at(54 * minute),
        payload: { ...compactRun, status: "failed", completedAt: at(54 * minute) },
      });
      yield* service.sweep;
      assert.lengthOf((yield* o.getThreadRecords(threadId, ["messages"])).messages, 1);
      for (const node of (yield* o.getThreadRecords(threadId, ["nodes"])).nodes) {
        yield* store.apply({
          id: EventId.make(`failed-node:${node.id}`),
          type: "node.updated",
          threadId,
          occurredAt: at(54 * minute),
          payload: { ...node, status: "failed", completedAt: at(54 * minute) },
        });
      }
      yield* store.apply({
        id: EventId.make("fresh-run"),
        type: "run.updated",
        threadId,
        occurredAt: at(54 * minute),
        payload: {
          ...state.runs[0]!,
          id: RunId.make("new-user-run"),
          ordinal: 3,
          completedAt: at(54 * minute),
        },
      });
      yield* store.apply({
        id: EventId.make("fresh-provider"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: at(54 * minute),
        payload: state.providerThreads[0]!,
      });
      yield* TestClock.adjust(54 * minute);
      yield* service.sweep;
      assert.lengthOf((yield* o.getThreadRecords(threadId, ["messages"])).messages, 2);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("admits once at the deadline and survives a worker restart", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* ForkIdleCompactionService.make;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* TestClock.adjust(54 * minute - 1);
      yield* service.sweep;
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages, 0);
      yield* TestClock.adjust(1);
      yield* service.sweep;
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages, 1);
      yield* (yield* ForkIdleCompactionService.make).sweep;
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages, 1);
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("revalidates a stale candidate inside actual command admission", () =>
    Effect.gen(function* () {
      const state = yield* seed;
      yield* TestClock.adjust(54 * minute);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const candidate = idleCompactionCandidate(state, 54 * minute)!;
      yield* store.apply({
        id: EventId.make("new-activity"),
        type: "run.updated",
        threadId,
        occurredAt: at(54 * minute),
        payload: { ...state.runs[0]!, status: "queued" },
      });
      yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("stale-idle"),
          threadId,
          messageId: MessageId.make("stale-idle"),
          text: "/compact",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.provideService(IdleCompactionAdmission, candidate));
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages, 0);
    }).pipe(Effect.provide(testLayer)),
  );
});
