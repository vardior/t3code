import {
  BotError,
  CommandId,
  MessageId,
  latestProviderTurnForAttempt,
  type OrchestrationV2ProviderFailure,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BotService from "./BotService.ts";

const COMPACTION_THRESHOLD = 250_000;
const CONTEXT_OVERFLOW_CODES = new Set([
  "contextlengthexceeded",
  "contextwindowexceeded",
  "prompttoolong",
]);
const CONTEXT_OVERFLOW_MESSAGE =
  /\b(?:context[ -](?:length|window).{0,80}(?:exceeded|exceeds|too (?:long|large)|is full)|(?:exceeds?|exceeded|too (?:long|large)).{0,80}context[ -](?:length|window)|prompt is too long)\b/i;
const isContextOverflow = (failure: OrchestrationV2ProviderFailure) =>
  CONTEXT_OVERFLOW_CODES.has((failure.code ?? "").replace(/[^a-z]/gi, "").toLowerCase()) ||
  CONTEXT_OVERFLOW_MESSAGE.test(failure.message);
const COMPACTING_DRIVERS = new Set([
  "antigravity",
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
]);

export class BotAutoCompaction extends Context.Service<
  BotAutoCompaction,
  {
    readonly afterSettledRun: (
      threadId: ThreadId,
      runId: RunId,
    ) => Effect.Effect<
      void,
      | BotError
      | ThreadManagementService.ThreadManagementError
      | Orchestrator.OrchestratorV2Error
      | ProviderAdapterRegistry.ProviderAdapterRegistryV2Error
    >;
  }
>()("t3/bots/BotAutoCompaction") {}

export const layer = Layer.effect(
  BotAutoCompaction,
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const providers = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;

    const afterSettledRun = Effect.fn("BotAutoCompaction.afterSettledRun")(function* (
      threadId: ThreadId,
      runId: RunId,
    ) {
      if (!(yield* bots.isHomeThread(threadId))) return;

      const projection = yield* threads.getThreadRecords(threadId, [
        "runs",
        "messages",
        "providerTurns",
      ]);
      if (projection.thread.deletedAt !== null || projection.thread.archivedAt !== null) return;
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run?.status !== "completed" && run?.status !== "failed") return;
      if (projection.runs.some((candidate) => candidate.ordinal > run.ordinal)) return;

      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      if (
        message?.text.trim().toLowerCase() === "/compact" &&
        Orchestrator.isNativeMaintenanceCommand(message)
      )
        return;
      const providerTurn = latestProviderTurnForAttempt(
        projection.providerTurns,
        run.activeAttemptId,
      );
      if (run.status === "completed" && providerTurn?.status !== "completed") return;
      const maxTokens = providerTurn?.tokenUsage?.maxTokens;
      const threshold =
        maxTokens != null && maxTokens > 0
          ? Math.min(COMPACTION_THRESHOLD, maxTokens * 0.8)
          : COMPACTION_THRESHOLD;
      const contextOverflow =
        run.status === "failed" &&
        (yield* threads.getThreadRecords(threadId, ["turnItems"], {
          turnItemRunIds: [runId],
          turnItemTypes: ["error"],
        })).turnItems.some(
          (item) =>
            item.type === "error" &&
            (item.providerTurnId === null || item.providerTurnId === providerTurn?.id) &&
            isContextOverflow(item.failure),
        );
      if (!contextOverflow && (providerTurn?.tokenUsage?.usedTokens ?? 0) <= threshold) return;

      const provider = yield* providers.get(projection.thread.providerInstanceId);
      if (!COMPACTING_DRIVERS.has(provider.driver)) return;

      const commandId = CommandId.make(`bot-auto-compact:${run.id}`);
      yield* threads.sendToThread({
        projectId: projection.thread.projectId,
        commandId,
        threadId,
        messageId: MessageId.make(`bot-auto-compact:${run.id}`),
        text: "/compact",
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      });
    });

    return BotAutoCompaction.of({ afterSettledRun });
  }),
);

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const compaction = yield* BotAutoCompaction;
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        event.type === "run.updated" &&
        (event.payload.status === "completed" || event.payload.status === "failed")
          ? compaction.afterSettledRun(event.threadId, event.payload.id).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Bot auto-compaction failed", {
                  threadId: event.threadId,
                  runId: event.payload.id,
                  cause,
                }),
              ),
            )
          : Effect.void,
      ),
      Effect.forkScoped,
    );
  }),
);
