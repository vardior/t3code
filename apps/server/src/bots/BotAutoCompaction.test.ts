import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BotAutoCompaction from "./BotAutoCompaction.ts";
import * as BotService from "./BotService.ts";

const homeThreadId = ThreadId.make("bot-home");
const runId = RunId.make("bot-run");
const attemptId = RunAttemptId.make("bot-attempt");
const sourceMessageId = MessageId.make("bot-message");

function projection(
  input: {
    usedTokens?: number;
    maxTokens?: number;
    sourceText?: string;
    queuedCompact?: boolean;
    failed?: boolean;
    failureCode?: string;
    failureMessage?: string;
  } = {},
) {
  return {
    thread: {
      projectId: "bot-project",
      providerInstanceId: ProviderInstanceId.make("codex"),
      archivedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        userMessageId: sourceMessageId,
        status: input.failed ? "failed" : "completed",
        activeAttemptId: attemptId,
      },
      ...(input.queuedCompact
        ? [
            {
              id: RunId.make("queued-compact"),
              ordinal: 2,
              userMessageId: MessageId.make("queued-compact-message"),
              status: "queued",
              activeAttemptId: null,
            },
          ]
        : []),
    ],
    messages: [
      { id: sourceMessageId, runId, text: input.sourceText ?? "Work completed", attachments: [] },
      ...(input.queuedCompact
        ? [
            {
              id: MessageId.make("queued-compact-message"),
              runId: RunId.make("queued-compact"),
              text: "/compact",
              attachments: [],
            },
          ]
        : []),
    ],
    turnItems: input.failed
      ? [
          {
            type: "error",
            runId,
            providerTurnId: null,
            failure: {
              code: input.failureCode ?? null,
              message: input.failureMessage ?? "Network disconnected",
            },
          },
        ]
      : [],
    providerTurns: [
      {
        runAttemptId: attemptId,
        ordinal: 1,
        status: input.failed ? "failed" : "completed",
        tokenUsage: { usedTokens: input.usedTokens ?? 250_001, maxTokens: input.maxTokens },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

function harness(input: {
  homeThreadId?: ThreadId;
  projection?: OrchestrationV2ThreadProjection;
  driver?: string;
}) {
  return Effect.gen(function* () {
    const sent = yield* Deferred.make<void>();
    const state = yield* Ref.make(input.projection ?? projection());
    const deliveries = yield* Ref.make<
      ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>
    >([]);
    const layer = BotAutoCompaction.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(BotService.BotService)({
            isHomeThread: (threadId) =>
              Effect.succeed(threadId === (input.homeThreadId ?? homeThreadId)),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Ref.get(state),
            sendToThread: (delivery) =>
              Ref.update(deliveries, (current) => [...current, delivery]).pipe(
                Effect.andThen(
                  Ref.update(state, (current) =>
                    projection({
                      queuedCompact: true,
                      ...(current.providerTurns[0]?.tokenUsage?.usedTokens === undefined
                        ? {}
                        : { usedTokens: current.providerTurns[0].tokenUsage.usedTokens }),
                      ...(current.messages[0]?.text === undefined
                        ? {}
                        : { sourceText: current.messages[0].text }),
                    }),
                  ),
                ),
                Effect.andThen(Deferred.succeed(sent, undefined)),
                Effect.as({} as never),
              ),
          }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            get: () => Effect.succeed({ driver: input.driver ?? "codex" } as never),
          }),
        ),
      ),
    );
    return { layer, deliveries, sent };
  });
}

describe("BotAutoCompaction", () => {
  it.effect("queues one server-owned maintenance turn for an over-limit bot home", () =>
    Effect.gen(function* () {
      const { layer, deliveries } = yield* harness({});
      yield* Effect.gen(function* () {
        const service = yield* BotAutoCompaction.BotAutoCompaction;
        yield* service.afterSettledRun(homeThreadId, runId);
        yield* service.afterSettledRun(homeThreadId, runId);
      }).pipe(Effect.provide(layer));
      const sent = yield* Ref.get(deliveries);
      assert.lengthOf(sent, 1);
      assert.include(sent[0], {
        text: "/compact",
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      });
    }),
  );

  it.effect("the event worker recovers a failed overflow run", () =>
    Effect.gen(function* () {
      const { layer, deliveries, sent } = yield* harness({
        projection: projection({
          failed: true,
          usedTokens: 0,
          failureCode: "contextWindowExceeded",
        }),
      });
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      yield* Layer.build(
        BotAutoCompaction.workerLive.pipe(
          Layer.provide(layer),
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(events),
            }),
          ),
        ),
      );
      yield* Queue.offer(events, {
        type: "run.updated",
        threadId: homeThreadId,
        payload: { id: runId, status: "failed" },
      } as OrchestrationV2DomainEvent);
      yield* Deferred.await(sent);
      assert.equal((yield* Ref.get(deliveries))[0]?.text, "/compact");
    }).pipe(Effect.scoped),
  );

  it.effect("skips a bot home below the threshold", () =>
    Effect.gen(function* () {
      const { layer, deliveries } = yield* harness({
        projection: projection({ usedTokens: 250_000 }),
      });
      const service = yield* BotAutoCompaction.BotAutoCompaction.pipe(Effect.provide(layer));
      yield* service.afterSettledRun(homeThreadId, runId);
      assert.isEmpty(yield* Ref.get(deliveries));
    }),
  );

  it.effect.each([
    { usedTokens: 160_001, maxTokens: 200_000, expected: 1 },
    { usedTokens: 160_000, maxTokens: 200_000, expected: 0 },
    { usedTokens: 250_001, maxTokens: 1_000_000, expected: 1 },
    { usedTokens: 250_000, maxTokens: 1_000_000, expected: 0 },
  ])("compacts at the capped window threshold: %j", ({ usedTokens, maxTokens, expected }) =>
    Effect.gen(function* () {
      const { layer, deliveries } = yield* harness({
        projection: projection({ usedTokens, maxTokens }),
      });
      const service = yield* BotAutoCompaction.BotAutoCompaction.pipe(Effect.provide(layer));
      yield* service.afterSettledRun(homeThreadId, runId);
      assert.lengthOf(yield* Ref.get(deliveries), expected);
    }),
  );

  it.effect.each([
    { failureCode: "contextWindowExceeded", usedTokens: 0, expected: 1 },
    { failureCode: "context_length_exceeded", usedTokens: 0, expected: 1 },
    {
      failureMessage: "Claude stopped: the prompt exceeds the model's context window.",
      usedTokens: 0,
      expected: 1,
    },
    {
      failureMessage: "Your input exceeds the context window of this model",
      usedTokens: 0,
      expected: 1,
    },
    { failureMessage: "Prompt is too long", usedTokens: 0, expected: 1 },
    { failureMessage: "Network disconnected", usedTokens: 250_001, expected: 1 },
    { failureMessage: "Token budget exhausted", usedTokens: 0, expected: 0 },
    { failureMessage: "Context window unavailable", usedTokens: 0, expected: 0 },
    { failureCode: "contextWindowExceeded", sourceText: "/compact", expected: 0 },
  ])("recovers failed runs conservatively: %j", (input) =>
    Effect.gen(function* () {
      const { layer, deliveries } = yield* harness({
        projection: projection({ ...input, failed: true }),
      });
      const service = yield* BotAutoCompaction.BotAutoCompaction.pipe(Effect.provide(layer));
      yield* service.afterSettledRun(homeThreadId, runId);
      assert.lengthOf(yield* Ref.get(deliveries), input.expected);
    }),
  );

  it.effect("skips a thread that is not a bot home", () =>
    Effect.gen(function* () {
      const { layer, deliveries } = yield* harness({ homeThreadId: ThreadId.make("other") });
      const service = yield* BotAutoCompaction.BotAutoCompaction.pipe(Effect.provide(layer));
      yield* service.afterSettledRun(homeThreadId, runId);
      assert.isEmpty(yield* Ref.get(deliveries));
    }),
  );

  it.effect("does not compact a completed /compact turn again", () =>
    Effect.gen(function* () {
      const { layer, deliveries } = yield* harness({
        projection: projection({ sourceText: "/compact" }),
      });
      const service = yield* BotAutoCompaction.BotAutoCompaction.pipe(Effect.provide(layer));
      yield* service.afterSettledRun(homeThreadId, runId);
      assert.isEmpty(yield* Ref.get(deliveries));
    }),
  );

  it.effect("does not queue behind an existing /compact", () =>
    Effect.gen(function* () {
      const { layer, deliveries } = yield* harness({
        projection: projection({ queuedCompact: true }),
      });
      const service = yield* BotAutoCompaction.BotAutoCompaction.pipe(Effect.provide(layer));
      yield* service.afterSettledRun(homeThreadId, runId);
      assert.isEmpty(yield* Ref.get(deliveries));
    }),
  );

  it.effect("skips a provider without native compaction", () =>
    Effect.gen(function* () {
      const { layer, deliveries } = yield* harness({ driver: "unknown-provider" });
      const service = yield* BotAutoCompaction.BotAutoCompaction.pipe(Effect.provide(layer));
      yield* service.afterSettledRun(homeThreadId, runId);
      assert.isEmpty(yield* Ref.get(deliveries));
    }),
  );
});
