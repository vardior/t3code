import {
  BotError,
  BotSlackDm,
  ScheduledTaskId,
  ThreadId,
  type RunId,
  type BotDetail,
  type BotGetInput,
  type BotListResult,
  type BotSetPausedInput,
  type BotSetPausedResult,
  type BotSummary,
} from "@t3tools/contracts";
import { RelayOwnerNotification } from "@t3tools/contracts/relay";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ServerConfig } from "../config.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";

import {
  BOT_ID,
  BotSchedulePauseTransition,
  decodeBotConfig,
  isPaused,
  listedScheduleIds,
  ownThreadIds,
  writeBotPauseFields,
  type BotConfigFile,
} from "./BotConfig.ts";

const HOME_THREAD_CACHE_TTL_MS = 30_000;
const MAX_WORKERS_PER_BOT = 50;
const MAX_SLACK_DMS_PER_BOT = 200;
const MAX_SLACK_DM_BYTES = 2 * 1024 * 1024;
const MAX_REPLY_PREVIEW_LENGTH = 200;

const replyPreview = (text: string) => {
  const plainText = text
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<([^>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plainText.length > MAX_REPLY_PREVIEW_LENGTH
    ? `${plainText.slice(0, MAX_REPLY_PREVIEW_LENGTH - 1).trimEnd()}…`
    : plainText;
};

const decodeOwnerNotification = Schema.decodeEffect(RelayOwnerNotification);
const decodeSlackDmLine = Schema.decodeUnknownOption(Schema.fromJsonString(BotSlackDm));
const isBotError = Schema.is(BotError);

const isPauseExpired = (config: BotConfigFile, nowMs: number) =>
  config.paused !== true &&
  config.pausedUntil !== undefined &&
  Date.parse(config.pausedUntil) <= nowMs;

interface WorkerRow {
  readonly thread_id: string;
  readonly title: string;
  readonly created_at: string;
  readonly status: string | null;
}

export class BotService extends Context.Service<
  BotService,
  {
    readonly streamChanges: Stream.Stream<{}>;
    readonly get: (input: BotGetInput) => Effect.Effect<BotDetail, BotError>;
    readonly list: () => Effect.Effect<BotListResult, BotError>;
    readonly isHomeThread: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly notifyOwner: (
      threadId: ThreadId | undefined,
      input: RelayOwnerNotification,
    ) => Effect.Effect<{ readonly runId: RunId }, BotError>;
    readonly getOwnerNotification: (
      threadId: ThreadId,
      runId: RunId,
    ) => Effect.Effect<RelayOwnerNotification | undefined>;
    readonly setPaused: (input: BotSetPausedInput) => Effect.Effect<BotSetPausedResult, BotError>;
  }
>()("t3/bots/BotService") {}

export const layer = Layer.effect(
  BotService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const changes = yield* PubSub.sliding<{}>(1);
    const ownerNotifications = new Map<
      ThreadId,
      { readonly runId: RunId; readonly notification: RelayOwnerNotification }
    >();
    const workerLookupLock = yield* Semaphore.make(1);
    const workerIds = new Map<ThreadId, ReadonlyArray<string>>();
    let workerGeneration = 0;
    const invalidateWorkers = () => {
      workerGeneration++;
      workerIds.clear();
    };
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scheduledTasks = yield* ScheduledTaskService;
    const configuredBotsDir = (yield* HostProcessEnvironment).T3CODE_BOTS_DIR?.trim() || null;
    const botsDir = configuredBotsDir ?? path.join((yield* ServerConfig).baseDir, "bots");

    const homeThreadLookupLock = yield* Semaphore.make(1);
    let homeThreadIds = new Set<ThreadId>();
    let homeThreadIdsExpireAt = 0;
    let homeThreadReadWarningLogged = false;

    const readBotIds = () =>
      fileSystem.readDirectory(botsDir).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
        Effect.map((entries) => entries.filter((id) => BOT_ID.test(id)).toSorted()),
      );

    const cacheHomeThreadIds = (ids: Iterable<ThreadId>) =>
      Effect.gen(function* () {
        homeThreadIds = new Set(ids);
        homeThreadIdsExpireAt = (yield* Clock.currentTimeMillis) + HOME_THREAD_CACHE_TTL_MS;
      });

    const warnHomeThreadReadFailure = (cause: unknown) =>
      Effect.gen(function* () {
        if (homeThreadReadWarningLogged) return;
        homeThreadReadWarningLogged = true;
        yield* Effect.logWarning("Cannot read bot home threads", { botsDir, cause });
      });

    const refreshHomeThreadIds = () =>
      Effect.gen(function* () {
        const ids = yield* readBotIds();
        let readFailed = false;
        const configs = yield* Effect.forEach(ids, (id) =>
          Effect.gen(function* () {
            const configPath = path.join(botsDir, id, "bot.json");
            if (
              !(yield* fileSystem
                .exists(configPath)
                .pipe(Effect.catchCause(() => Effect.succeed(false))))
            )
              return null;
            return yield* fileSystem
              .readFileString(configPath)
              .pipe(Effect.flatMap(decodeBotConfig));
          }).pipe(
            Effect.catchCause((cause) => {
              readFailed = true;
              return warnHomeThreadReadFailure(cause).pipe(Effect.as(null));
            }),
          ),
        );
        if (!readFailed) homeThreadReadWarningLogged = false;
        yield* cacheHomeThreadIds(
          configs.flatMap((config) => (config === null ? [] : [config.homeThreadId])),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          warnHomeThreadReadFailure(cause).pipe(Effect.andThen(cacheHomeThreadIds([]))),
        ),
      );

    const listWorkerIds = (homeThreadId: ThreadId) =>
      Effect.gen(function* () {
        const cached = workerIds.get(homeThreadId);
        if (cached !== undefined) return cached;
        const generation = workerGeneration;
        const rows = yield* sql<{ readonly thread_id: string }>`
          SELECT t.thread_id
          FROM orchestration_v2_projection_threads t
          WHERE t.deleted_at IS NULL
            AND t.thread_id <> ${homeThreadId}
            AND (
              json_extract(t.payload_json, '$.lineage.parentThreadId') = ${homeThreadId}
              OR (
                SELECT json_extract(m.payload_json, '$.senderThreadId')
                FROM orchestration_v2_projection_messages m
                WHERE m.thread_id = t.thread_id
                ORDER BY m.created_at, m.message_id LIMIT 1
              ) = ${homeThreadId}
            )
          ORDER BY t.created_at DESC
          LIMIT ${MAX_WORKERS_PER_BOT + 2}
        `;
        const ids = rows.map((row) => row.thread_id);
        if (generation === workerGeneration) workerIds.set(homeThreadId, ids);
        return ids;
      }).pipe(workerLookupLock.withPermit);

    const listWorkers = (homeThreadId: ThreadId, ownThreadIds: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const ids = (yield* listWorkerIds(homeThreadId)).filter((id) => !ownThreadIds.has(id));
        if (ids.length === 0) return [];
        const rows = yield* sql<WorkerRow>`
          SELECT thread_id, title, created_at, status FROM (
            SELECT t.thread_id, t.title, t.created_at,
              (
                SELECT r.status FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = t.thread_id
                ORDER BY r.ordinal DESC LIMIT 1
              ) AS status
            FROM orchestration_v2_projection_threads t
            WHERE t.thread_id IN ${sql.in(ids)} AND t.deleted_at IS NULL
            ORDER BY t.created_at DESC
            LIMIT ${MAX_WORKERS_PER_BOT}
          ) ORDER BY created_at
        `;
        return rows.map((row) => ({
          threadId: ThreadId.make(row.thread_id),
          title: row.title,
          createdAt: row.created_at,
          status: row.status,
        }));
      });

    const readLastReply = (homeThreadId: ThreadId) =>
      sql<{ readonly text: string; readonly at: string }>`
        SELECT json_extract(m.payload_json, '$.text') AS text, m.created_at AS at
        FROM orchestration_v2_projection_messages m
        WHERE m.thread_id = ${homeThreadId}
          AND m.role = 'assistant' AND m.streaming = 0 AND m.run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs r
            WHERE r.run_id = m.run_id
              AND r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
          )
          AND EXISTS (
            SELECT 1 FROM orchestration_v2_projection_messages incoming
            WHERE incoming.run_id = m.run_id AND incoming.role = 'user'
              AND NOT (
                json_extract(incoming.payload_json, '$.createdBy') IS 'agent'
                AND (
                  json_extract(incoming.payload_json, '$.senderThreadId') IS ${homeThreadId}
                  OR json_extract(incoming.payload_json, '$.creationSource') IS 'server'
                )
                AND json_extract(incoming.payload_json, '$.text') IS '/compact'
              )
          )
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT 1
      `.pipe(
        Effect.map((rows) => {
          const reply = rows[0];
          return reply ? { text: replyPreview(reply.text), at: reply.at } : null;
        }),
      );

    const readHomeThreadState = (threadId: ThreadId) =>
      sql<{ readonly archived_at: string | null }>`
        SELECT archived_at FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId} AND deleted_at IS NULL
      `.pipe(
        Effect.map((rows) => ({
          homeThreadMissing: rows.length === 0,
          homeThreadArchived: rows[0]?.archived_at != null,
        })),
      );

    const isThreadQueueHeld = (threadId: ThreadId) =>
      sql<{ readonly found: number }>`
        SELECT 1 AS found FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status = 'queued'
          AND json_extract(payload_json, '$.queueHeld') IS 1
        LIMIT 1
      `.pipe(Effect.map((rows) => rows.length > 0));

    const scheduleIdsFor = (config: BotConfigFile) =>
      sql<{ readonly task_id: string }>`
        SELECT task_id FROM scheduled_tasks
        WHERE thread_id IN ${sql.in(ownThreadIds(config))}
        ORDER BY created_at
      `.pipe(
        Effect.map((rows) => [
          ...new Set([
            ...listedScheduleIds(config),
            ...rows.map((row) => ScheduledTaskId.make(row.task_id)),
          ]),
        ]),
      );

    const readCharter = (botDir: string) =>
      fileSystem.readFileString(path.join(botDir, "charter.md")).pipe(
        Effect.map((text) => text.trim() || null),
        Effect.catchCause(() => Effect.succeed(null)),
      );

    const readSlackDms = (botDir: string) =>
      Effect.gen(function* () {
        const file = yield* fileSystem.open(path.join(botDir, "dm-log.jsonl"));
        let position = Number((yield* file.stat).size);
        let leadingBytes = new Uint8Array(0);
        let totalRead = 0;
        const newestDms: BotSlackDm[] = [];
        while (position > 0 && totalRead < MAX_SLACK_DM_BYTES) {
          const start = Math.max(0, position - Math.min(64 * 1024, MAX_SLACK_DM_BYTES - totalRead));
          yield* file.seek(BigInt(start), "start");
          const chunk = new Uint8Array(position - start);
          let read = 0;
          while (read < chunk.length) {
            const count = yield* file.read(chunk.subarray(read));
            if (count === 0) break;
            read += count;
          }
          totalRead += read;
          const combined = new Uint8Array(read + leadingBytes.length);
          combined.set(chunk.subarray(0, read));
          combined.set(leadingBytes, read);
          position = start;
          const firstNewline = combined.indexOf(10);
          const completeStart =
            position === 0 ? 0 : firstNewline < 0 ? combined.length : firstNewline + 1;
          leadingBytes = combined.slice(0, completeStart);
          const lines = new TextDecoder().decode(combined.subarray(completeStart)).split("\n");
          for (let index = lines.length - 1; index >= 0; index--) {
            const dm = decodeSlackDmLine(lines[index]!);
            if (Option.isSome(dm)) newestDms.push(dm.value);
            if (newestDms.length === MAX_SLACK_DMS_PER_BOT) return newestDms.toReversed();
          }
          if (read === 0) break;
        }
        return newestDms.toReversed();
      }).pipe(
        Effect.scoped,
        Effect.catchCause(() => Effect.succeed([])),
      );

    const get = (input: BotGetInput) =>
      Effect.gen(function* () {
        if (!BOT_ID.test(input.botId)) {
          return yield* new BotError({ message: `Unknown bot ${input.botId}` });
        }
        const botDir = path.join(botsDir, input.botId);
        const config = yield* fileSystem
          .readFileString(path.join(botDir, "bot.json"))
          .pipe(Effect.flatMap(decodeBotConfig));
        const sideThreadIds = new Set(
          [config.triageThreadId, config.dmRelayThreadId].filter((value) => value !== undefined),
        );
        return {
          charter: yield* readCharter(botDir),
          workers: yield* listWorkers(config.homeThreadId, sideThreadIds),
          slackDms: yield* readSlackDms(botDir),
        };
      }).pipe(
        Effect.mapError((cause) =>
          isBotError(cause)
            ? cause
            : new BotError({ message: `Cannot read bot ${input.botId}`, cause }),
        ),
      );

    const readBot = (id: string, botDir: string) =>
      Effect.gen(function* () {
        const configPath = path.join(botDir, "bot.json");
        const config = yield* fileSystem
          .readFileString(configPath)
          .pipe(Effect.flatMap(decodeBotConfig));
        const bot: BotSummary = {
          id,
          name: config.name,
          homeThreadId: config.homeThreadId,
          scheduledTaskIds: yield* scheduleIdsFor(config),
          paused: isPaused(config, yield* Clock.currentTimeMillis),
          ...(config.pausedUntil === undefined ? {} : { pausedUntil: config.pausedUntil }),
          ...(yield* readHomeThreadState(config.homeThreadId)),
          ...((yield* isThreadQueueHeld(config.homeThreadId)) ? { homeThreadQueueHeld: true } : {}),
          lastReply: yield* readLastReply(config.homeThreadId),
        };
        return Option.some(bot);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Skipping unreadable bot", { id, cause }).pipe(
            Effect.as(Option.none<BotSummary>()),
          ),
        ),
      );

    const list = () =>
      Effect.gen(function* () {
        const entries = yield* readBotIds().pipe(
          Effect.mapError(
            (cause) => new BotError({ message: `Cannot read bots directory ${botsDir}`, cause }),
          ),
        );
        const bots = yield* Effect.forEach(
          entries,
          (id) => {
            const botDir = path.join(botsDir, id);
            return fileSystem.exists(path.join(botDir, "bot.json")).pipe(
              Effect.catchCause(() => Effect.succeed(false)),
              Effect.flatMap((exists) =>
                exists ? readBot(id, botDir) : Effect.succeed(Option.none<BotSummary>()),
              ),
            );
          },
          { concurrency: 4 },
        );
        const summaries = bots.flatMap((bot) => Option.toArray(bot));
        yield* cacheHomeThreadIds(summaries.map((bot) => bot.homeThreadId));
        return { bots: summaries };
      });

    const isHomeThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        if ((yield* Clock.currentTimeMillis) >= homeThreadIdsExpireAt) {
          yield* refreshHomeThreadIds();
        }
        return homeThreadIds.has(threadId);
      }).pipe(homeThreadLookupLock.withPermit);

    const notifyOwner = Effect.fn("BotService.notifyOwner")(function* (
      threadId: ThreadId | undefined,
      input: RelayOwnerNotification,
    ) {
      if (threadId === undefined || !(yield* isHomeThread(threadId))) {
        return yield* new BotError({ message: "notify_owner requires a bot home thread." });
      }
      const notification = yield* decodeOwnerNotification(input).pipe(
        Effect.mapError(
          () => new BotError({ message: "The notification title or body is invalid." }),
        ),
      );
      const shell = yield* orchestrator
        .getThreadShell(threadId)
        .pipe(
          Effect.mapError((cause) => new BotError({ message: "Cannot read the bot run.", cause })),
        );
      const runId = shell?.activeRunId;
      if (runId == null || shell?.archivedAt !== null || shell.deletedAt !== null) {
        return yield* new BotError({ message: "notify_owner requires an active bot run." });
      }
      ownerNotifications.set(threadId, { runId, notification });
      return { runId };
    });

    const getOwnerNotification = (threadId: ThreadId, runId: RunId) =>
      Effect.sync(() => {
        const request = ownerNotifications.get(threadId);
        return request?.runId === runId ? request.notification : undefined;
      });

    const setBotScheduleEnabled = (id: ScheduledTaskId, enabled: boolean) =>
      scheduledTasks
        .setEnabled({ id, enabled })
        .pipe(Effect.provideService(BotSchedulePauseTransition, true));

    const setScheduleIdsEnabled = (ids: ReadonlyArray<ScheduledTaskId>, enabled: boolean) =>
      Effect.forEach(ids, (id) => setBotScheduleEnabled(id, enabled), { discard: true });

    const setPaused = (input: BotSetPausedInput, onlyIfExpired = false) =>
      Effect.gen(function* () {
        if (!BOT_ID.test(input.botId)) {
          return yield* new BotError({ message: `Unknown bot ${input.botId}` });
        }
        const configPath = path.join(botsDir, input.botId, "bot.json");
        const raw = yield* fileSystem.readFileString(configPath);
        const config = yield* decodeBotConfig(raw);
        if (onlyIfExpired && !isPauseExpired(config, yield* Clock.currentTimeMillis)) return {};
        const writePauseFields = (fields: Record<string, unknown> | null) =>
          writeBotPauseFields(configPath, fields).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );

        if (input.paused) {
          const now = yield* Clock.currentTimeMillis;
          const pausedAt =
            isPaused(config, now) && config.pausedAt !== undefined
              ? config.pausedAt
              : DateTime.formatIso(DateTime.makeUnsafe(now));
          const botScheduleIds = new Set(yield* scheduleIdsFor(config));
          const { tasks } = yield* scheduledTasks.list();
          const enabledIds = tasks
            .filter((task) => task.enabled && botScheduleIds.has(task.id))
            .map((task) => task.id);
          const disabledIds: ScheduledTaskId[] = [];
          yield* Effect.gen(function* () {
            for (const id of enabledIds) {
              yield* setBotScheduleEnabled(id, false);
              disabledIds.push(id);
            }
            yield* writePauseFields({
              paused: true,
              pausedAt,
              pausedReason: "Paused from the Bots view",
              pausedScheduleIds: [
                ...new Set([...(config.pausedScheduleIds ?? []), ...disabledIds]),
              ],
            });
          }).pipe(
            Effect.catchCause((cause) =>
              setScheduleIdsEnabled(disabledIds, true).pipe(
                Effect.flatMap(() => Effect.failCause(cause)),
              ),
            ),
          );
          return {};
        }

        if (
          !isPaused(config, yield* Clock.currentTimeMillis) &&
          config.pausedAt === undefined &&
          config.pausedUntil === undefined &&
          config.pausedScheduleIds === undefined
        )
          return {};
        const { tasks } = yield* scheduledTasks.list();
        const rememberedIds = new Set(config.pausedScheduleIds ?? []);
        const botThreadIds = new Set(ownThreadIds(config));
        const pausedAt = config.pausedAt === undefined ? NaN : Date.parse(config.pausedAt);
        const pausedUntil =
          config.pausedUntil === undefined ? Infinity : Date.parse(config.pausedUntil);
        const resumeIds = tasks
          .filter(
            (task) =>
              !task.enabled &&
              (rememberedIds.has(task.id) ||
                (config.pausedScheduleIds === undefined &&
                  task.threadId !== null &&
                  botThreadIds.has(task.threadId) &&
                  Date.parse(task.createdAt) >= pausedAt &&
                  Date.parse(task.createdAt) < pausedUntil)),
          )
          .map((task) => task.id);
        const enabledIds: ScheduledTaskId[] = [];
        yield* Effect.gen(function* () {
          for (const id of resumeIds) {
            yield* setBotScheduleEnabled(id, true);
            enabledIds.push(id);
          }
          yield* writePauseFields(null);
        }).pipe(
          Effect.catchCause((cause) =>
            setScheduleIdsEnabled(enabledIds, false).pipe(
              Effect.flatMap(() => Effect.failCause(cause)),
            ),
          ),
        );
        return {};
      }).pipe(
        Effect.uninterruptible,
        Effect.provideService(BotSchedulePauseTransition, true),
        scheduledTasks.withBotPauseLock,
        Effect.tap(() => refreshHomeThreadIds()),
        Effect.tap(() => PubSub.publish(changes, {})),
        Effect.mapError((cause) =>
          isBotError(cause)
            ? cause
            : new BotError({
                message: `Cannot ${input.paused ? "pause" : "resume"} bot ${input.botId}`,
                cause,
              }),
        ),
      );

    const restoreExpiredPauses = Effect.gen(function* () {
      const ids = yield* readBotIds();
      yield* Effect.forEach(
        ids,
        (botId) =>
          Effect.gen(function* () {
            const configPath = path.join(botsDir, botId, "bot.json");
            if (
              !(yield* fileSystem
                .exists(configPath)
                .pipe(Effect.catchCause(() => Effect.succeed(false))))
            )
              return;
            const raw = yield* fileSystem.readFileString(configPath);
            const config = yield* decodeBotConfig(raw).pipe(
              Effect.catch((cause) =>
                Effect.logDebug("Skipping malformed bot pause state", { botId, cause }).pipe(
                  Effect.as(null),
                ),
              ),
            );
            if (config === null) return;
            if (isPauseExpired(config, yield* Clock.currentTimeMillis)) {
              yield* setPaused({ botId, paused: false }, true);
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Cannot restore expired bot pause", { botId, cause }),
            ),
          ),
        { discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Cannot scan expired bot pauses", { botsDir, cause }),
      ),
    );

    yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "thread.deleted") ownerNotifications.delete(event.threadId);
          if (
            event.type === "thread.created" ||
            event.type === "thread.deleted" ||
            (event.type === "message.updated" &&
              event.payload.role === "user" &&
              event.payload.senderThreadId !== undefined)
          ) {
            invalidateWorkers();
          }
          if (
            (event.type === "thread.archived" ||
              event.type === "thread.unarchived" ||
              event.type === "thread.deleted") &&
            (yield* isHomeThread(event.threadId))
          ) {
            yield* PubSub.publish(changes, {});
          }
        }),
      ),
      Effect.catchCause((cause) => Effect.logWarning("Cannot watch bot thread changes", { cause })),
      Effect.forkScoped({ startImmediately: true }),
    );

    yield* scheduledTasks.subscribeList().pipe(
      Stream.map(({ tasks }) =>
        tasks
          .map((task) => JSON.stringify([task.id, task.threadId]))
          .toSorted()
          .join("\n"),
      ),
      Stream.changes,
      Stream.drop(1),
      Stream.runForEach(() => PubSub.publish(changes, {})),
      Effect.catchCause((cause) => Effect.logWarning("Cannot watch bot schedules", { cause })),
      Effect.forkScoped({ startImmediately: true }),
    );

    const watchDir = (yield* fileSystem.exists(botsDir)) ? botsDir : path.dirname(botsDir);
    yield* fileSystem.watch(watchDir, { recursive: true }).pipe(
      Stream.filter((event) => {
        const relative = path.relative(botsDir, path.resolve(watchDir, event.path));
        if (relative === "") return true;
        const parts = relative.split(path.sep);
        return (
          BOT_ID.test(parts[0] ?? "") &&
          (parts.length === 1 || (parts.length === 2 && parts[1] === "bot.json"))
        );
      }),
      Stream.debounce(Duration.millis(100)),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          homeThreadIdsExpireAt = 0;
          invalidateWorkers();
          yield* PubSub.publish(changes, {});
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Cannot watch bot configuration changes", { botsDir, cause }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );

    yield* restoreExpiredPauses;
    yield* restoreExpiredPauses.pipe(
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.delay("1 minute"),
      Effect.forkScoped,
    );

    return BotService.of({
      get,
      list,
      isHomeThread,
      notifyOwner,
      getOwnerNotification,
      setPaused,
      streamChanges: Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(Stream.succeed({}), Stream.fromSubscription(subscription));
        }),
      ),
    });
  }),
);
