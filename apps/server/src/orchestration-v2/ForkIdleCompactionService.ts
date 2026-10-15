import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import {
  IdleCompactionAdmission,
  IdleCompactionPauseGuard,
  idleCompactionCandidate,
  idleCompactionFields,
  IDLE_COMPACTION_DELAY_MS,
  IDLE_COMPACTION_EXPIRY_MS,
} from "./IdleCompactionPolicy.ts";

export const make = Effect.gen(function* () {
  const pauseGuard = yield* IdleCompactionPauseGuard;
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const providers = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const sweep = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT t.thread_id FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_runs r ON r.run_id = (
        SELECT latest.run_id FROM orchestration_v2_projection_runs latest
        WHERE latest.thread_id = t.thread_id ORDER BY latest.ordinal DESC LIMIT 1
      )
      JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = t.active_provider_thread_id
      LEFT JOIN orchestration_v2_projection_provider_turns pt ON pt.provider_turn_id = (
        SELECT latest.provider_turn_id FROM orchestration_v2_projection_provider_turns latest
        WHERE latest.provider_thread_id = p.provider_thread_id ORDER BY latest.ordinal DESC LIMIT 1
      )
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND r.status = 'completed'
        AND r.completed_at <= ${DateTime.formatIso(DateTime.makeUnsafe(now - IDLE_COMPACTION_DELAY_MS))}
        AND r.completed_at > ${DateTime.formatIso(DateTime.makeUnsafe(now - IDLE_COMPACTION_EXPIRY_MS))}
        AND coalesce(json_extract(pt.payload_json, '$.tokenUsage.usedTokens'), json_extract(p.payload_json, '$.contextUsage.usedTokens')) > 200000
        AND NOT EXISTS (SELECT 1 FROM orchestration_command_receipts receipt WHERE receipt.command_id = 'idle-compact:' || r.run_id)
    `;
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(row.thread_id);
          const state = yield* orchestrator.getThreadRecords(threadId, idleCompactionFields);
          const candidate = idleCompactionCandidate(state, now);
          if (candidate === undefined) return;
          const message = yield* orchestrator.getThreadRecords(threadId, ["messages"], {
            messageIds: [state.runs.find((run) => run.id === candidate.runId)!.userMessageId],
          });
          if (message.messages.some((message) => Orchestrator.isNativeMaintenanceCommand(message)))
            return;
          const provider = yield* providers.get(state.thread.providerInstanceId);
          if (provider.supportsCompaction !== true) return;
          const commandId = CommandId.make(`idle-compact:${candidate.runId}`);
          if (Option.isSome(yield* receipts.getByCommandId(commandId))) return;
          yield* orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId,
              threadId,
              messageId: MessageId.make(`idle-compact:${candidate.runId}`),
              text: "/compact",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "agent",
              creationSource: "server",
            })
            .pipe(
              Effect.provideService(IdleCompactionAdmission, candidate),
              Effect.provideService(IdleCompactionPauseGuard, pauseGuard),
            );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Idle context compaction skipped", {
              threadId: row.thread_id,
              cause,
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  });
  return {
    sweep,
    start: () =>
      forkParked(
        sweep.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Idle context compaction sweep failed", { cause }),
          ),
          Effect.repeat(Schedule.spaced("1 minute")),
          Effect.asVoid,
        ),
      ),
  };
});
