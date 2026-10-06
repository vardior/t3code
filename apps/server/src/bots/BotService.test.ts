import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { BotSummary, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as BotService from "./BotService.ts";

const decodeBot = Schema.decodeUnknownEffect(BotSummary);

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const testLayer = Layer.mergeAll(SqlitePersistence.layerMemory, NodeServices.layer);

const scheduledTasksLayer = ScheduledTaskService.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    ),
  ),
);

const withBots = <A, E, R>(
  input: { readonly baseDir: string; readonly env?: NodeJS.ProcessEnv },
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.provide(
      BotService.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
        Layer.provideMerge(scheduledTasksLayer),
      ),
    ),
    Effect.provideService(HostProcessEnvironment, input.env ?? {}),
  );

const listBots = (input: { readonly baseDir: string; readonly env?: NodeJS.ProcessEnv }) =>
  withBots(
    input,
    Effect.gen(function* () {
      const service = yield* BotService.BotService;
      return yield* service.list();
    }),
  );

const insertSchedule = (
  sql: SqlClient.SqlClient,
  schedule: { id: string; threadId: string | null; enabled: boolean; createdAt: string },
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: schedule.id,
    title: schedule.id,
    prompt: "Wake up.",
    enabled: schedule.enabled ? 1 : 0,
    schedule_json: JSON.stringify({ type: "interval", everyMs: 900_000 }),
    project_id: "project-1",
    thread_id: schedule.threadId,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "agent",
    creation_source: "mcp",
    created_at: schedule.createdAt,
    updated_at: schedule.createdAt,
    next_run_at: schedule.enabled ? "2026-10-01T01:00:00.000Z" : null,
    last_run_at: null,
    last_run_status: "never",
    last_run_error: null,
    run_count: 0,
  })}`;

const insertThread = (
  sql: SqlClient.SqlClient,
  thread: { id: string; createdAt: string; parentThreadId?: string; deletedAt?: string },
) => sql`
  INSERT INTO orchestration_v2_projection_threads (
    thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
    created_at, updated_at, deleted_at, payload_json
  ) VALUES (
    ${thread.id}, 'project-1', ${`Title ${thread.id}`}, 'codex', 'full-access', 'default',
    ${thread.createdAt}, ${thread.createdAt}, ${thread.deletedAt ?? null},
    ${toJson({
      lineage: {
        parentThreadId: thread.parentThreadId ?? null,
        relationshipToParent: thread.parentThreadId ? "subagent" : null,
        rootThreadId: thread.parentThreadId ?? thread.id,
      },
    })}
  )
`;

const insertMessage = (
  sql: SqlClient.SqlClient,
  message: {
    id: string;
    threadId: string;
    createdAt: string;
    senderThreadId?: string;
    runId?: string;
    role?: string;
    streaming?: boolean;
    text?: string;
  },
) => sql`
  INSERT INTO orchestration_v2_projection_messages (
    message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
  ) VALUES (
    ${message.id}, ${message.threadId}, ${message.runId ?? null}, NULL,
    ${message.role ?? "user"}, ${message.streaming ? 1 : 0},
    ${message.createdAt}, ${message.createdAt},
    ${toJson({ text: message.text ?? "", createdBy: "user", senderThreadId: message.senderThreadId })}
  )
`;

const insertRun = (
  sql: SqlClient.SqlClient,
  run: { id: string; threadId: string; ordinal: number; status: string },
) => sql`
  INSERT INTO orchestration_v2_projection_runs (
    run_id, thread_id, ordinal, provider, status, requested_at, payload_json
  ) VALUES (
    ${run.id}, ${run.threadId}, ${run.ordinal}, 'codex', ${run.status},
    '2026-10-01T00:00:00.000Z', '{}'
  )
`;

it.effect(
  "treats a missing default bots directory as empty but a missing configured one as an error",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-home-" });
      expect(yield* listBots({ baseDir })).toEqual({ bots: [] });
      for (const env of [{}, { T3CODE_BOTS_DIR: path.join(baseDir, "elsewhere") }]) {
        yield* withBots(
          { baseDir, env },
          Effect.gen(function* () {
            const bots = yield* BotService.BotService;
            expect(yield* bots.list()).toEqual({ bots: [] });
            expect(yield* bots.isHomeThread(ThreadId.make("home"))).toBe(false);
          }),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("lists only summaries and gets charter, Slack DMs and spawned workers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-home-" });
    const root = path.join(baseDir, "bots");
    yield* fs.makeDirectory(root);

    yield* fs.makeDirectory(path.join(root, "helper"));
    yield* fs.writeFileString(
      path.join(root, "helper", "bot.json"),
      toJson({
        name: "Helper",
        homeThreadId: "home",
        triageThreadId: "triage",
        scheduledTaskId: "task-1",
        unknownField: 1,
      }),
    );
    yield* fs.writeFileString(path.join(root, "helper", "charter.md"), "Be helpful.\n");
    yield* fs.writeFileString(
      path.join(root, "helper", "dm-log.jsonl"),
      [
        toJson({ ts: "1.0", text: "Any news?", at: "2026-10-01T00:08:00Z", acked: true }),
        "not json",
        "",
      ].join("\n"),
    );
    yield* fs.makeDirectory(path.join(root, "broken"));
    yield* fs.writeFileString(path.join(root, "broken", "bot.json"), "{");
    yield* fs.makeDirectory(path.join(root, "notes"));
    yield* fs.makeDirectory(path.join(root, "Release Bot"));
    yield* fs.writeFileString(
      path.join(root, "Release Bot", "bot.json"),
      toJson({ name: "Release Bot", homeThreadId: "release-home" }),
    );

    yield* insertThread(sql, { id: "home", createdAt: "2026-10-01T00:00:00.000Z" });
    yield* insertThread(sql, { id: "triage", createdAt: "2026-10-01T00:01:00.000Z" });
    yield* insertMessage(sql, {
      id: "m-triage",
      threadId: "triage",
      createdAt: "2026-10-01T00:01:00.000Z",
      senderThreadId: "home",
    });
    yield* insertThread(sql, { id: "launched", createdAt: "2026-10-01T00:03:00.000Z" });
    yield* insertMessage(sql, {
      id: "m-launched",
      threadId: "launched",
      createdAt: "2026-10-01T00:03:00.000Z",
      senderThreadId: "home",
    });
    yield* insertRun(sql, { id: "r1", threadId: "launched", ordinal: 1, status: "completed" });
    yield* insertRun(sql, { id: "r2", threadId: "launched", ordinal: 2, status: "running" });
    yield* insertThread(sql, {
      id: "subagent",
      createdAt: "2026-10-01T00:02:00.000Z",
      parentThreadId: "home",
    });
    yield* insertThread(sql, { id: "messaged-later", createdAt: "2026-10-01T00:04:00.000Z" });
    yield* insertMessage(sql, {
      id: "m-later-1",
      threadId: "messaged-later",
      createdAt: "2026-10-01T00:04:00.000Z",
    });
    yield* insertMessage(sql, {
      id: "m-later-2",
      threadId: "messaged-later",
      createdAt: "2026-10-01T00:05:00.000Z",
      senderThreadId: "home",
    });
    yield* insertThread(sql, {
      id: "deleted",
      createdAt: "2026-10-01T00:06:00.000Z",
      parentThreadId: "home",
      deletedAt: "2026-10-01T00:07:00.000Z",
    });

    expect(yield* listBots({ baseDir })).toEqual({
      bots: [
        {
          id: "helper",
          name: "Helper",
          homeThreadId: "home",
          scheduledTaskIds: ["task-1"],
          paused: false,
          lastReply: null,
        },
      ],
    });
    const detail = yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        for (const botId of ["missing", "broken", "../helper", "", "Release Bot"]) {
          expect((yield* bots.get({ botId }).pipe(Effect.flip))._tag).toBe("BotError");
        }
        return yield* bots.get({ botId: "helper" });
      }),
    );
    expect(detail).toEqual({
      charter: "Be helpful.",
      workers: [
        {
          threadId: "subagent",
          title: "Title subagent",
          createdAt: "2026-10-01T00:02:00.000Z",
          status: null,
        },
        {
          threadId: "launched",
          title: "Title launched",
          createdAt: "2026-10-01T00:03:00.000Z",
          status: "running",
        },
      ],
      slackDms: [{ text: "Any news?", at: "2026-10-01T00:08:00Z" }],
    });
    const listReads: string[] = [];
    const summary = yield* listBots({ baseDir }).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: (filePath, encoding) => {
          listReads.push(filePath);
          return fs.readFileString(filePath, encoding);
        },
        open: (filePath, options) => {
          listReads.push(filePath);
          return fs.open(filePath, options);
        },
      }),
    );
    expect(listReads).toContain(path.join(root, "helper", "bot.json"));
    expect(listReads.every((filePath) => path.basename(filePath) === "bot.json")).toBe(true);
    const dms = Array.from({ length: 450 }, (_, index) => ({
      text: `${index}: ${"שלום 🌍 ".repeat(100)}`,
      at: "2026-10-01T00:08:00Z",
    }));
    yield* fs.writeFileString(
      path.join(root, "helper", "dm-log.jsonl"),
      dms.map((dm) => toJson(dm)).join("\n"),
    );
    let bytesRead = 0;
    const tail = yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        return yield* bots.get({ botId: "helper" });
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        open: (filePath, options) =>
          fs.open(filePath, options).pipe(
            Effect.map(
              (file) =>
                new Proxy(file, {
                  get: (target, property) =>
                    property === "read"
                      ? (buffer: Uint8Array) =>
                          target.read(buffer).pipe(
                            Effect.tap((count) =>
                              Effect.sync(() => {
                                bytesRead += count;
                              }),
                            ),
                          )
                      : Reflect.get(target, property, target),
                }),
            ),
          ),
      }),
    );
    expect(bytesRead).toBeGreaterThan(0);
    expect(bytesRead).toBeLessThan(Buffer.byteLength(dms.map((dm) => toJson(dm)).join("\n")));
    expect(Buffer.byteLength(toJson(summary))).toBe(126);
    expect(Buffer.byteLength(toJson({ bots: [{ ...summary.bots[0], ...tail }] }))).toBeGreaterThan(
      100_000,
    );
    expect(tail.slackDms).toEqual(dms.slice(-200));
    const homeMatches = yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        return [
          yield* bots.isHomeThread(ThreadId.make("home")),
          yield* bots.isHomeThread(ThreadId.make("triage")),
        ];
      }),
    );
    expect(homeMatches).toEqual([true, false]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "pausing a bot turns off every schedule that wakes it, and resuming turns back on only those",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-home-" });
      const botDir = path.join(baseDir, "bots", "helper");
      yield* fs.makeDirectory(botDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(botDir, "bot.json"),
        toJson({
          name: "Helper",
          homeThreadId: "home",
          triageThreadId: "triage",
          scheduledTaskId: "listed",
          intervalMs: 900_000,
        }),
      );
      yield* insertSchedule(sql, {
        id: "listed",
        threadId: "triage",
        enabled: true,
        createdAt: "2026-10-01T00:03:00.000Z",
      });
      yield* insertSchedule(sql, {
        id: "bound",
        threadId: "home",
        enabled: true,
        createdAt: "2026-10-01T00:01:00.000Z",
      });
      yield* insertSchedule(sql, {
        id: "already-off",
        threadId: "home",
        enabled: false,
        createdAt: "2026-10-01T00:02:00.000Z",
      });
      yield* insertSchedule(sql, {
        id: "unrelated",
        threadId: "elsewhere",
        enabled: true,
        createdAt: "2026-10-01T00:00:00.000Z",
      });

      const readConfig = fs
        .readFileString(path.join(botDir, "bot.json"))
        .pipe(Effect.map((text): unknown => JSON.parse(text)));

      yield* withBots(
        { baseDir },
        Effect.gen(function* () {
          const bots = yield* BotService.BotService;
          const schedules = yield* ScheduledTaskService.ScheduledTaskService;
          const enabledById = schedules
            .list()
            .pipe(
              Effect.map(({ tasks }) =>
                Object.fromEntries(tasks.map((task) => [task.id, task.enabled])),
              ),
            );
          const helper = bots.list().pipe(Effect.map(({ bots }) => bots[0]));

          expect((yield* helper)?.scheduledTaskIds).toEqual(["listed", "bound", "already-off"]);
          expect((yield* helper)?.paused).toBe(false);

          yield* bots.setPaused({ botId: "helper", paused: true });
          yield* schedules.setEnabled({ id: ScheduledTaskId.make("listed"), enabled: true });
          yield* insertSchedule(sql, {
            id: "new-bound",
            threadId: "home",
            enabled: true,
            createdAt: "2026-10-01T00:04:00.000Z",
          });
          yield* bots.setPaused({ botId: "helper", paused: true });
          expect((yield* helper)?.paused).toBe(true);
          expect(yield* enabledById).toEqual({
            listed: false,
            bound: false,
            "already-off": false,
            unrelated: true,
            "new-bound": false,
          });
          expect(yield* readConfig).toMatchObject({
            intervalMs: 900_000,
            paused: true,
            pausedScheduleIds: ["listed", "bound", "new-bound"],
          });

          yield* bots.setPaused({ botId: "helper", paused: false });
          expect((yield* helper)?.paused).toBe(false);
          expect(yield* enabledById).toEqual({
            listed: true,
            bound: true,
            "already-off": false,
            unrelated: true,
            "new-bound": true,
          });
          expect(yield* readConfig).toEqual({
            name: "Helper",
            homeThreadId: "home",
            triageThreadId: "triage",
            scheduledTaskId: "listed",
            intervalMs: 900_000,
          });

          yield* schedules.setEnabled({ id: ScheduledTaskId.make("listed"), enabled: false });
          yield* fs.writeFileString(
            path.join(botDir, "bot.json"),
            toJson({
              name: "Helper",
              homeThreadId: "home",
              scheduledTaskId: "listed",
              pausedUntil: "2999-01-01T00:00:00Z",
              pausedReason: "Paused by its parent",
            }),
          );
          expect((yield* helper)?.paused).toBe(true);
          yield* bots.setPaused({ botId: "helper", paused: false });
          expect((yield* enabledById).listed).toBe(true);
          expect(yield* readConfig).toEqual({
            name: "Helper",
            homeThreadId: "home",
            scheduledTaskId: "listed",
          });

          const escaped = yield* bots
            .setPaused({ botId: "../helper", paused: true })
            .pipe(Effect.flip);
          expect(escaped.message).toBe("Unknown bot ../helper");
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each([
  { paused: false, nextPaused: true },
  { paused: true, nextPaused: true },
  { paused: true, nextPaused: false },
])(
  "restores schedules and preserves bot.json when the state write fails: %s",
  ({ paused, nextPaused }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-pause-write-" });
      const botDir = path.join(baseDir, "bots", "helper");
      const configPath = path.join(botDir, "bot.json");
      const config = {
        name: "Helper",
        homeThreadId: "home",
        ...(paused ? { paused: true, pausedScheduleIds: ["already-off"] } : {}),
      };
      yield* fs.makeDirectory(botDir, { recursive: true });
      yield* fs.writeFileString(configPath, toJson(config));
      for (const [id, enabled] of [
        ["enabled", true],
        ["already-off", false],
      ] as const) {
        yield* insertSchedule(sql, {
          id,
          threadId: "home",
          enabled,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
      }
      const writeError = new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "rename",
        }),
      );
      const failingFs = FileSystem.FileSystem.of({
        ...fs,
        rename: (source, target) =>
          target === configPath ? Effect.fail(writeError) : fs.rename(source, target),
      });
      yield* withBots(
        { baseDir },
        Effect.gen(function* () {
          const bots = yield* BotService.BotService;
          const schedules = yield* ScheduledTaskService.ScheduledTaskService;
          const error = yield* bots
            .setPaused({ botId: "helper", paused: nextPaused })
            .pipe(Effect.flip);
          expect(error.message).toBe(`Cannot ${nextPaused ? "pause" : "resume"} bot helper`);
          expect(error.cause).toBe(writeError);
          expect(yield* fromJson(yield* fs.readFileString(configPath))).toEqual(config);
          expect(
            (yield* schedules.list()).tasks
              .map((task) => ({ id: task.id, enabled: task.enabled }))
              .toSorted((left, right) => left.id.localeCompare(right.id)),
          ).toEqual([
            { id: "already-off", enabled: false },
            { id: "enabled", enabled: true },
          ]);
        }),
      ).pipe(Effect.provideService(FileSystem.FileSystem, failingFs));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("previews only the latest settled final assistant reply, as bounded plain text", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-preview-" });
    const botDir = path.join(baseDir, "bots", "helper");
    yield* fs.makeDirectory(botDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(botDir, "bot.json"),
      toJson({ name: "Helper", homeThreadId: "home" }),
    );
    yield* insertThread(sql, { id: "home", createdAt: "2026-10-01T00:00:00.000Z" });
    const readReply = listBots({ baseDir }).pipe(Effect.map((result) => result.bots[0]!.lastReply));
    expect(yield* readReply).toBeNull();
    yield* insertRun(sql, { id: "settled", threadId: "home", ordinal: 1, status: "completed" });
    yield* insertMessage(sql, {
      id: "question",
      threadId: "home",
      runId: "settled",
      createdAt: "2026-10-01T00:01:00.000Z",
    });
    yield* insertMessage(sql, {
      id: "intermediate",
      threadId: "home",
      runId: "settled",
      role: "assistant",
      text: "I am investigating.",
      createdAt: "2026-10-01T00:02:00.000Z",
    });
    yield* insertMessage(sql, {
      id: "final",
      threadId: "home",
      runId: "settled",
      role: "assistant",
      text: "## Done\n\n**Fixed** the [issue](https://example.com) with `code`.\n- Ready to ship.",
      createdAt: "2026-10-01T00:03:00.000Z",
    });
    const finalReply = {
      text: "Done Fixed the issue with code. Ready to ship.",
      at: "2026-10-01T00:03:00.000Z",
    };
    expect(yield* readReply).toEqual(finalReply);
    yield* insertRun(sql, { id: "active", threadId: "home", ordinal: 2, status: "running" });
    yield* insertMessage(sql, {
      id: "active-question",
      threadId: "home",
      runId: "active",
      createdAt: "2026-10-01T00:04:00.000Z",
    });
    yield* insertMessage(sql, {
      id: "active-intermediate",
      threadId: "home",
      runId: "active",
      role: "assistant",
      text: "Still investigating.",
      createdAt: "2026-10-01T00:05:00.000Z",
    });
    yield* insertMessage(sql, {
      id: "streaming",
      threadId: "home",
      runId: "settled",
      role: "assistant",
      streaming: true,
      text: "Partial output",
      createdAt: "2026-10-01T00:06:00.000Z",
    });
    expect(yield* readReply).toEqual(finalReply);
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'active'`;
    yield* insertMessage(sql, {
      id: "long-final",
      threadId: "home",
      runId: "active",
      role: "assistant",
      text: `**${"word ".repeat(60)}**`,
      createdAt: "2026-10-01T00:07:00.000Z",
    });
    const preview = yield* readReply;
    expect(preview).toEqual({ text: `${"word ".repeat(39)}word…`, at: "2026-10-01T00:07:00.000Z" });
    expect(preview!.text).toHaveLength(200);
    const { lastReply: _, ...oldBot } = (yield* listBots({ baseDir })).bots[0]!;
    expect((yield* decodeBot(oldBot)).lastReply).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("caches home thread lookups for 30 seconds and refreshes them after listing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-cache-" });
    const botDir = path.join(baseDir, "bots", "helper");
    const configPath = path.join(botDir, "bot.json");
    yield* fs.makeDirectory(botDir, { recursive: true });
    yield* fs.writeFileString(configPath, toJson({ name: "Helper", homeThreadId: "home" }));
    let directoryReads = 0;
    let configReads = 0;
    const trackedFs = FileSystem.FileSystem.of({
      ...fs,
      readDirectory: (...args) =>
        Effect.suspend(() => {
          directoryReads++;
          return fs.readDirectory(...args);
        }),
      readFileString: (...args) =>
        Effect.suspend(() => {
          if (args[0] === configPath) configReads++;
          return fs.readFileString(...args);
        }),
    });
    yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        expect(yield* bots.isHomeThread(ThreadId.make("home"))).toBe(true);
        yield* fs.writeFileString(configPath, toJson({ name: "Helper", homeThreadId: "new-home" }));
        yield* TestClock.adjust("29999 millis");
        expect(yield* bots.isHomeThread(ThreadId.make("home"))).toBe(true);
        expect(yield* bots.isHomeThread(ThreadId.make("new-home"))).toBe(false);
        expect([directoryReads, configReads]).toEqual([1, 1]);
        yield* TestClock.adjust("1 millis");
        expect(yield* bots.isHomeThread(ThreadId.make("new-home"))).toBe(true);
        expect(yield* bots.isHomeThread(ThreadId.make("home"))).toBe(false);
        expect([directoryReads, configReads]).toEqual([2, 2]);
        yield* fs.writeFileString(
          configPath,
          toJson({ name: "Helper", homeThreadId: "listed-home" }),
        );
        yield* bots.list();
        expect(yield* bots.isHomeThread(ThreadId.make("listed-home"))).toBe(true);
        expect([directoryReads, configReads]).toEqual([3, 3]);
        yield* fs.writeFileString(
          configPath,
          toJson({ name: "Helper", homeThreadId: "paused-home" }),
        );
        yield* bots.setPaused({ botId: "helper", paused: true });
        const readsAfterPause = [directoryReads, configReads];
        expect(yield* bots.isHomeThread(ThreadId.make("paused-home"))).toBe(true);
        expect([directoryReads, configReads]).toEqual(readsAfterPause);
      }),
    ).pipe(Effect.provideService(FileSystem.FileSystem, trackedFs));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("does not fail home thread lookups when the bots path is unreadable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-unreadable-" });
    yield* fs.writeFileString(path.join(baseDir, "bots"), "not a directory");
    const warnings: unknown[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(message);
    });
    yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        expect(yield* bots.isHomeThread(ThreadId.make("home"))).toBe(false);
        yield* TestClock.adjust("30 seconds");
        expect(yield* bots.isHomeThread(ThreadId.make("home"))).toBe(false);
        expect((yield* bots.list().pipe(Effect.flip))._tag).toBe("BotError");
      }),
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    expect(warnings).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each([true, false])("preserves intervening bot.json edits when paused=%s", (paused) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-edit-" });
    const botDir = path.join(baseDir, "bots", "helper");
    const configPath = path.join(botDir, "bot.json");
    yield* fs.makeDirectory(botDir, { recursive: true });
    const pauseFields = paused
      ? {}
      : {
          paused: true,
          pausedUntil: "2999-01-01T00:00:00Z",
          pausedReason: "Taking a break",
          pausedScheduleIds: [],
        };
    yield* fs.writeFileString(
      configPath,
      toJson({
        name: "Helper",
        homeThreadId: "home",
        removedByAgent: true,
        ...pauseFields,
      }),
    );
    let edited = false;
    const editingFs = FileSystem.FileSystem.of({
      ...fs,
      readFileString: (filePath, ...args) =>
        fs.readFileString(filePath, ...args).pipe(
          Effect.flatMap((raw) => {
            if (filePath !== configPath || edited) return Effect.succeed(raw);
            edited = true;
            return fs
              .writeFileString(
                configPath,
                toJson({
                  name: "Renamed by agent",
                  homeThreadId: "home",
                  agentState: { cursor: "new" },
                  ...pauseFields,
                }),
              )
              .pipe(Effect.as(raw));
          }),
        ),
    });
    yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        yield* bots.setPaused({ botId: "helper", paused });
      }),
    ).pipe(Effect.provideService(FileSystem.FileSystem, editingFs));
    expect(yield* fromJson(yield* fs.readFileString(configPath))).toEqual({
      name: "Renamed by agent",
      homeThreadId: "home",
      agentState: { cursor: "new" },
      ...(paused
        ? {
            paused: true,
            pausedReason: "Paused from the Bots view",
            pausedScheduleIds: [],
          }
        : {}),
    });
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each([{ paused: true }, { pausedUntil: "2999-01-01T00:00:00Z" }])(
  "resumes only disabled listed schedules for bot pause fields %j",
  (pauseFields) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-resume-" });
      const botDir = path.join(baseDir, "bots", "helper");
      yield* fs.makeDirectory(botDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(botDir, "bot.json"),
        toJson({
          name: "Helper",
          homeThreadId: "home",
          scheduledTaskId: "listed-disabled",
          dmRelayScheduledTaskId: "listed-enabled",
          ...pauseFields,
        }),
      );
      for (const schedule of [
        { id: "listed-disabled", enabled: false },
        { id: "listed-enabled", enabled: true },
        { id: "discovered-disabled", enabled: false },
        { id: "discovered-enabled", enabled: true },
      ]) {
        yield* insertSchedule(sql, {
          ...schedule,
          threadId: "home",
          createdAt: "2026-10-01T00:00:00.000Z",
        });
      }
      yield* withBots(
        { baseDir },
        Effect.gen(function* () {
          const bots = yield* BotService.BotService;
          const schedules = yield* ScheduledTaskService.ScheduledTaskService;
          const before = (yield* schedules.list()).tasks.find(
            (task) => task.id === "listed-enabled",
          );
          yield* bots.setPaused({ botId: "helper", paused: false });
          const { tasks } = yield* schedules.list();
          expect(Object.fromEntries(tasks.map((task) => [task.id, task.enabled]))).toEqual({
            "listed-disabled": true,
            "listed-enabled": true,
            "discovered-disabled": false,
            "discovered-enabled": true,
          });
          expect(tasks.find((task) => task.id === "listed-enabled")).toEqual(before);
          expect(yield* fromJson(yield* fs.readFileString(path.join(botDir, "bot.json")))).toEqual({
            name: "Helper",
            homeThreadId: "home",
            scheduledTaskId: "listed-disabled",
            dmRelayScheduledTaskId: "listed-enabled",
          });
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("finishes an interrupted pause before a concurrent resume reads its state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-interrupt-" });
    const botDir = path.join(baseDir, "bots", "helper");
    const configPath = path.join(botDir, "bot.json");
    yield* fs.makeDirectory(botDir, { recursive: true });
    yield* fs.writeFileString(configPath, toJson({ name: "Helper", homeThreadId: "home" }));
    yield* insertSchedule(sql, {
      id: "wake",
      threadId: "home",
      enabled: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const writing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let held = false;
    yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        const schedules = yield* ScheduledTaskService.ScheduledTaskService;
        const pause = yield* bots
          .setPaused({ botId: "helper", paused: true })
          .pipe(Effect.forkChild);
        yield* Deferred.await(writing);
        expect((yield* schedules.list()).tasks[0]?.enabled).toBe(false);
        yield* Effect.sync(() => pause.interruptUnsafe());
        const resume = yield* bots
          .setPaused({ botId: "helper", paused: false })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        expect(Exit.isFailure(yield* Fiber.await(pause))).toBe(true);
        yield* Fiber.join(resume);
        expect((yield* schedules.list()).tasks[0]?.enabled).toBe(true);
        expect(yield* fromJson(yield* fs.readFileString(configPath))).toEqual({
          name: "Helper",
          homeThreadId: "home",
        });
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        rename: (source, target) => {
          if (target !== configPath || held) return fs.rename(source, target);
          held = true;
          return Deferred.succeed(writing, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(fs.rename(source, target)),
          );
        },
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("caps sparse DM log reads and keeps the newest valid messages in order", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-sparse-" });
    const botDir = path.join(baseDir, "bots", "helper");
    yield* fs.makeDirectory(botDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(botDir, "bot.json"),
      toJson({ name: "Helper", homeThreadId: "home" }),
    );
    const dms = [
      { text: "older", at: "2026-10-01T00:00:00Z" },
      { text: "newer 🌍", at: "2026-10-01T00:01:00Z" },
    ];
    yield* fs.writeFileString(
      path.join(botDir, "dm-log.jsonl"),
      [
        toJson({ text: "outside cap", at: "2026-10-01T00:00:00Z" }),
        '{"other":"'.concat("x".repeat(3 * 1024 * 1024), '"}'),
        toJson(dms[0]),
        "invalid\n".repeat(20000),
        toJson(dms[1]),
      ].join("\n"),
    );
    let bytesRead = 0;
    const detail = yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        return yield* (yield* BotService.BotService).get({ botId: "helper" });
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        open: (filePath, options) =>
          fs.open(filePath, options).pipe(
            Effect.map(
              (file) =>
                new Proxy(file, {
                  get: (target, property) =>
                    property === "read"
                      ? (buffer: Uint8Array) =>
                          target.read(buffer).pipe(
                            Effect.tap((count) =>
                              Effect.sync(() => {
                                bytesRead += count;
                              }),
                            ),
                          )
                      : Reflect.get(target, property, target),
                }),
            ),
          ),
      }),
    );
    expect(bytesRead).toBe(2 * 1024 * 1024);
    expect(detail.slackDms).toEqual(dms);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("ignores non-bot entries and warns again after a successful home lookup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-warning-" });
    const root = path.join(baseDir, "bots");
    const botDir = path.join(root, "helper");
    const configPath = path.join(botDir, "bot.json");
    yield* fs.makeDirectory(botDir, { recursive: true });
    for (const name of ["bin", "memory", "eval"]) yield* fs.makeDirectory(path.join(root, name));
    yield* fs.writeFileString(path.join(root, "BOTS.md"), "Bots");
    yield* fs.writeFileString(configPath, toJson({ name: "Helper", homeThreadId: "home" }));
    const warnings: unknown[] = [];
    yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        expect(yield* bots.isHomeThread(ThreadId.make("home"))).toBe(true);
        expect(warnings).toHaveLength(0);
        for (const [raw, warningCount] of [
          ["{", 1],
          ["{", 1],
          [toJson({ name: "Helper", homeThreadId: "home" }), 1],
          ["{", 2],
        ] as const) {
          yield* fs.writeFileString(configPath, raw);
          yield* TestClock.adjust("30 seconds");
          yield* bots.isHomeThread(ThreadId.make("home"));
          expect(warnings).toHaveLength(warningCount);
        }
      }),
    ).pipe(
      Effect.provide(
        Logger.layer(
          [
            Logger.make(({ logLevel, message }) => {
              if (logLevel === "Warn") warnings.push(message);
            }),
          ],
          { mergeWithExisting: false },
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
