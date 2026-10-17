import {
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadProjection,
  type ProviderTurnId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { latestNativeContextUsage } from "@t3tools/provider-core/server/handoffBudget";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export const IDLE_COMPACTION_DELAY_MS = 54 * 60 * 1_000;
export const IDLE_COMPACTION_EXPIRY_MS = 60 * 60 * 1_000;

export interface IdleCompactionCandidate {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly providerTurnId: ProviderTurnId;
  readonly activityAt: number;
}

export const IdleCompactionAdmission = Context.Reference<IdleCompactionCandidate | undefined>(
  "t3/orchestration-v2/IdleCompactionAdmission",
  { defaultValue: () => undefined },
);

export const IdleCompactionPauseGuard = Context.Reference<
  (threadId: ThreadId) => Effect.Effect<boolean>
>("t3/orchestration-v2/IdleCompactionPauseGuard", {
  defaultValue: () => () => Effect.succeed(false),
});

export const idleCompactionFields = [
  "runs",
  "attempts",
  "providerTurns",
  "providerThreads",
  "nodes",
  "subagents",
  "runtimeRequests",
] as const;

type IdleCompactionState = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | (typeof idleCompactionFields)[number]
>;
const live = (status: string) =>
  ["pending", "preparing", "starting", "queued", "running", "waiting"].includes(status);

export function idleCompactionCandidate(
  state: IdleCompactionState,
  now: number,
): IdleCompactionCandidate | undefined {
  const { thread } = state;
  if (
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    thread.settledAt !== null ||
    thread.settledOverride === "settled"
  )
    return;
  if (isProviderNativeSubagentThread(thread)) return;
  if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > now) return;
  if ((thread.openItems ?? []).some((item) => item.status === "open")) return;
  if (state.runs.some((run) => live(run.status))) return;
  if (state.nodes.some((node) => live(node.status))) return;
  if (state.subagents.some((agent) => live(agent.status))) return;
  if (state.runtimeRequests.some((request) => request.status === "pending")) return;
  if (
    state.providerThreads.some(
      (provider) =>
        provider.status === "active" || (provider.pendingBackgroundTasks ?? []).length > 0,
    )
  )
    return;
  const run = state.runs.reduce<(typeof state.runs)[number] | undefined>(
    (latest, row) => (latest === undefined || row.ordinal > latest.ordinal ? row : latest),
    undefined,
  );
  if (
    run?.status !== "completed" ||
    run.queueHeld === true ||
    run.delegatedCompletion?.disposition === "stopped" ||
    run.completedAt === null ||
    run.userMessageId.startsWith("idle-compact:") ||
    (thread.limitRecovery != null &&
      (thread.limitRecovery.runId === run.id || Date.parse(thread.limitRecovery.resetAt) > now))
  )
    return;
  const provider = state.providerThreads.find((row) => row.id === thread.activeProviderThreadId);
  if (
    provider === undefined ||
    provider.nativeThreadRef === null ||
    !["idle", "not_loaded"].includes(provider.status)
  )
    return;
  if (provider.goal != null && provider.goal.status !== "complete") return;
  const turn = state.providerTurns
    .filter((row) => row.providerThreadId === provider.id)
    .reduce<(typeof state.providerTurns)[number] | undefined>(
      (latest, row) => (latest === undefined || row.ordinal > latest.ordinal ? row : latest),
      undefined,
    );
  if (
    turn?.status !== "completed" ||
    turn.runAttemptId !== run.activeAttemptId ||
    turn.completedAt === null
  )
    return;
  const measuredUsage = latestNativeContextUsage(state, provider);
  if ((measuredUsage?.usage.usedTokens ?? provider.contextUsage?.usedTokens ?? 0) <= 200_000)
    return;
  const activityAt = Math.max(
    DateTime.toEpochMillis(run.completedAt),
    DateTime.toEpochMillis(turn.completedAt),
    measuredUsage === undefined ? 0 : Date.parse(measuredUsage.reportedAt),
    state.nodes.reduce(
      (latest, node) =>
        node.completedAt === null
          ? latest
          : Math.max(latest, DateTime.toEpochMillis(node.completedAt)),
      0,
    ),
  );
  const age = now - activityAt;
  if (!Number.isFinite(age) || age < IDLE_COMPACTION_DELAY_MS || age >= IDLE_COMPACTION_EXPIRY_MS)
    return;
  return { threadId: thread.id, runId: run.id, providerTurnId: turn.id, activityAt };
}

export function sameIdleCompactionCandidate(
  left: IdleCompactionCandidate,
  right: IdleCompactionCandidate | undefined,
): boolean {
  return (
    right !== undefined &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.providerTurnId === right.providerTurnId &&
    left.activityAt === right.activityAt
  );
}
