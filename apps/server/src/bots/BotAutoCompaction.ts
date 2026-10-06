import {
  BotError,
  CommandId,
  MessageId,
  latestProviderTurnForAttempt,
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

const COMPACTION_THRESHOLD = 150_000;
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
    readonly afterCompletedRun: (
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

    const afterCompletedRun = Effect.fn("BotAutoCompaction.afterCompletedRun")(function* (
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
      if (run?.status !== "completed") return;
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
      if (
        providerTurn?.status !== "completed" ||
        (providerTurn.tokenUsage?.usedTokens ?? 0) <= COMPACTION_THRESHOLD
      )
        return;

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

    return BotAutoCompaction.of({ afterCompletedRun });
  }),
);

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const compaction = yield* BotAutoCompaction;
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? compaction.afterCompletedRun(event.threadId, event.payload.id).pipe(
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
