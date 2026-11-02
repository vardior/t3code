import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  BotSummary,
  ScheduledTaskId,
  RunId,
  EnvironmentId,
  ProviderInstanceId,
  type OrchestrationV2ThreadShell,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import * as OpenItemService from "../openItems/OpenItemService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { McpSchema, McpServer } from "effect/ai";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../mcp/ThreadMetadataMcpService.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import * as OrchestratorHandlers from "../mcp/toolkits/orchestrator/handlers.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { BotSchedulePauseTransition } from "./BotConfig.ts";
import * as BotService from "./BotService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";

const decodeBot = Schema.decodeUnknownEffect(BotSummary);

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const testLayer = Layer.mergeAll(SqlitePersistence.layerMemory, NodeServices.layer);

const scheduledTasksLayer = ScheduledTaskService.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    ),
  ),
);

const withBots = <A, E, R>(
  input: {
    readonly baseDir: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly domainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
    readonly readShell?: () => Effect.Effect<OrchestrationV2ThreadShell | null>;
  },
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.provide(
      BotService.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: input.domainEvents ?? Stream.empty,
            ...(input.readShell === undefined ? {} : { getThreadShell: input.readShell }),
          }),
        ),
        Layer.provideMerge(
          scheduledTasksLayer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
          ),
        ),
      ),
    ),
    Effect.provideService(HostProcess.Environment, input.env ?? {}),
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
    scheduledTaskId?: string;
    createdBy?: "user" | "agent";
    creationSource?: string;
    runId?: string;
    role?: string;
    streaming?: boolean;
    text?: string;
    notification?: { source: { kind: string }; outcome: string; summary: string };
    delegatedCompletion?: { parentRunId: string; generation: number; taskIds: string[] };
  },
) => sql`
  INSERT INTO orchestration_v2_projection_messages (
    message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
  ) VALUES (
    ${message.id}, ${message.threadId}, ${message.runId ?? null}, NULL,
    ${message.role ?? "user"}, ${message.streaming ? 1 : 0},
    ${message.createdAt}, ${message.createdAt},
    ${toJson({
      text: message.text ?? "",
      createdBy: message.createdBy ?? "user",
      creationSource: message.creationSource,
      senderThreadId: message.senderThreadId,
      scheduledTaskId: message.scheduledTaskId,
      notification: message.notification,
      delegatedCompletion: message.delegatedCompletion,
    })}
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

it.effect("lists each bot's job line, joining a wrapped job and falling back to the name", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-jobs-" });
    const root = path.join(baseDir, "bots");
    const writeBot = (id: string, charter?: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(root, id), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, id, "bot.json"),
          toJson({ name: `${id} name`, homeThreadId: `${id}-home` }),
        );
        if (charter !== undefined) {
          yield* fs.writeFileString(path.join(root, id, "charter.md"), charter);
        }
      });
    yield* writeBot(
      "omni",
      "# omni\n\n## Identity\njob: Keep omni healthy on GKE.\ngood looks like: quiet.\n",
    );
    yield* writeBot(
      "chief",
      "## Identity\njob: Or's front door. Turn what he sends into streams, and keep him to\n     the decisions that are truly his.\ntemperament: brief.\n",
    );
    yield* writeBot("plain");
    yield* fs.makeDirectory(path.join(root, "broken"));
    yield* fs.writeFileString(path.join(root, "broken", "bot.json"), "{");
    yield* fs.makeDirectory(path.join(root, "notes"));

    const jobs = yield* withBots(
      { baseDir },
      Effect.flatMap(BotService.BotService, (bots) => bots.listJobs()),
    );
    expect(jobs).toEqual([
      {
        id: "chief",
        job: "Or's front door. Turn what he sends into streams, and keep him to the decisions that are truly his.",
      },
      { id: "omni", job: "Keep omni healthy on GKE." },
      { id: "plain", job: "plain name" },
    ]);
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
          homeThreadMissing: false,
          homeThreadArchived: false,
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
    expect(
      listReads.every((filePath) => ["bot.json", "order.json"].includes(path.basename(filePath))),
    ).toBe(true);
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
    expect(Buffer.byteLength(toJson(summary))).toBe(179);
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

      yield* TestClock.setTime(Date.parse("2026-10-01T00:03:30.000Z"));
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
          for (const id of ["listed", "bound", "already-off"]) {
            const error = yield* schedules
              .setEnabled({ id: ScheduledTaskId.make(id), enabled: true })
              .pipe(Effect.flip);
            expect(error.message).toBe(
              "Paused with bot Helper. Resume the bot before enabling this task.",
            );
          }
          const { tasks } = yield* schedules.list();
          const bound = tasks.find((task) => task.id === "bound")!;
          const error = yield* schedules.upsert({ ...bound, enabled: true }).pipe(Effect.flip);
          expect(error.message).toBe(
            "Paused with bot Helper. Resume the bot before enabling this task.",
          );
          const created = yield* schedules.upsert({
            ...bound,
            id: ScheduledTaskId.make("paused-create"),
            enabled: true,
          });
          expect(created.task.enabled).toBe(false);
          expect(created.task.nextRunAt).toBe(null);
          yield* schedules.setEnabled({ id: ScheduledTaskId.make("unrelated"), enabled: true });
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
            "paused-create": false,
          });
          expect(yield* readConfig).toMatchObject({
            intervalMs: 900_000,
            paused: true,
            pausedScheduleIds: ["listed", "bound", "paused-create", "new-bound"],
          });

          yield* bots.setPaused({ botId: "helper", paused: false });
          expect((yield* helper)?.paused).toBe(false);
          expect(yield* enabledById).toEqual({
            listed: true,
            bound: true,
            "already-off": false,
            unrelated: true,
            "new-bound": true,
            "paused-create": true,
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
          expect((yield* helper)?.pausedUntil).toBe("2999-01-01T00:00:00Z");
          yield* bots.setPaused({ botId: "helper", paused: false });
          expect((yield* enabledById).listed).toBe(false);
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

it.effect.each(["resume", "worker", "startup"] as const)(
  "recovers same-millisecond tasks with lost pause ids through %s within the pause interval",
  (operation) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-pause-recovery-" });
      const botDir = path.join(baseDir, "bots", "helper");
      const configPath = path.join(botDir, "bot.json");
      const config = {
        name: "Helper",
        homeThreadId: "home",
        triageThreadId: "triage",
        dmRelayThreadId: "relay",
      };
      yield* fs.makeDirectory(botDir, { recursive: true });
      yield* fs.writeFileString(configPath, toJson(config));
      yield* insertSchedule(sql, {
        id: "already-off",
        threadId: "home",
        enabled: false,
        createdAt: "1969-01-01T00:00:00.000Z",
      });
      yield* insertSchedule(sql, {
        id: "remembered",
        threadId: "home",
        enabled: true,
        createdAt: "1969-01-01T00:00:00.000Z",
      });
      const restored = yield* Deferred.make<void>();
      let restoring = false;
      yield* withBots(
        { baseDir },
        Effect.gen(function* () {
          const bots = yield* BotService.BotService;
          const schedules = yield* ScheduledTaskService.ScheduledTaskService;
          yield* bots.setPaused({ botId: "helper", paused: true });
          const pausedConfig = yield* fs.readFileString(configPath);
          expect(yield* fromJson(pausedConfig)).toMatchObject({
            pausedAt: "1970-01-01T00:00:00.000Z",
            pausedScheduleIds: ["remembered"],
          });
          const template = (yield* schedules.list()).tasks.find(
            (task) => task.id === "remembered",
          )!;
          for (const threadId of ["home", "triage", "relay"]) {
            const { task } = yield* schedules.upsert({
              ...template,
              id: ScheduledTaskId.make(`lost-${threadId}`),
              threadId: ThreadId.make(threadId),
              enabled: true,
            });
            expect(task.enabled).toBe(false);
          }
          yield* insertSchedule(sql, {
            id: "unrelated",
            threadId: "elsewhere",
            enabled: false,
            createdAt: "1970-01-01T00:00:00.001Z",
          });
          yield* fs.writeFileString(configPath, pausedConfig);
          yield* bots.setPaused({ botId: "helper", paused: true });
          expect(yield* fromJson(yield* fs.readFileString(configPath))).toMatchObject({
            pausedAt: "1970-01-01T00:00:00.000Z",
            pausedScheduleIds: ["remembered"],
          });
          yield* fs.writeFileString(
            configPath,
            toJson({
              ...config,
              pausedAt: "1970-01-01T00:00:00.000Z",
              pausedUntil: "1970-01-01T00:00:01.000Z",
            }),
          );
          yield* TestClock.adjust("1 second");
          for (const id of ["at-expiry", "after-expiry"]) {
            const { task } = yield* schedules.upsert({
              ...template,
              id: ScheduledTaskId.make(id),
              enabled: true,
            });
            expect(task.enabled).toBe(true);
            yield* schedules.setEnabled({ id: task.id, enabled: false });
            yield* TestClock.adjust("1 millis");
          }
          if (operation === "worker") {
            restoring = true;
            yield* TestClock.adjust("1 minute");
            yield* Deferred.await(restored);
          }
          if (operation === "resume") yield* bots.setPaused({ botId: "helper", paused: false });
        }),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (source, target) =>
            fs
              .rename(source, target)
              .pipe(
                Effect.tap(() =>
                  target === configPath && restoring
                    ? Deferred.succeed(restored, undefined)
                    : Effect.void,
                ),
              ),
        }),
      );
      if (operation === "startup") {
        yield* TestClock.adjust("1 second");
        yield* withBots({ baseDir }, Effect.void);
      }
      expect(
        yield* sql<{
          task_id: string;
          enabled: number;
        }>`SELECT task_id, enabled FROM scheduled_tasks`.pipe(
          Effect.map((rows) =>
            Object.fromEntries(rows.map((row) => [row.task_id, row.enabled === 1])),
          ),
        ),
      ).toEqual({
        "already-off": false,
        remembered: false,
        "at-expiry": false,
        "after-expiry": false,
        "lost-home": true,
        "lost-triage": true,
        "lost-relay": true,
        unrelated: false,
      });
      expect(yield* fromJson(yield* fs.readFileString(configPath))).toEqual(config);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each([[], ["remembered"]])(
  "trusts present pause ids %j when a task is deliberately created disabled",
  (pausedScheduleIds) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-pause-ids-" });
      const botDir = path.join(baseDir, "bots", "helper");
      const configPath = path.join(botDir, "bot.json");
      yield* fs.makeDirectory(botDir, { recursive: true });
      yield* fs.writeFileString(
        configPath,
        toJson({
          name: "Helper",
          homeThreadId: "home",
          paused: true,
          pausedAt: "1970-01-01T00:00:00.000Z",
          pausedScheduleIds,
        }),
      );
      yield* insertSchedule(sql, {
        id: "remembered",
        threadId: "home",
        enabled: false,
        createdAt: "1969-01-01T00:00:00.000Z",
      });
      yield* withBots(
        { baseDir },
        Effect.gen(function* () {
          const bots = yield* BotService.BotService;
          const schedules = yield* ScheduledTaskService.ScheduledTaskService;
          yield* TestClock.adjust("1 millis");
          const template = (yield* schedules.list()).tasks[0]!;
          for (const enabled of pausedScheduleIds.length > 0 ? [true, false] : [false]) {
            yield* schedules.upsert({
              ...template,
              id: ScheduledTaskId.make(enabled ? "pause-disabled" : "intentionally-disabled"),
              enabled,
            });
          }
          yield* bots.setPaused({ botId: "helper", paused: false });
          expect(
            Object.fromEntries(
              (yield* schedules.list()).tasks.map((task) => [task.id, task.enabled]),
            ),
          ).toEqual({
            remembered: pausedScheduleIds.includes("remembered"),
            ...(pausedScheduleIds.length > 0 ? { "pause-disabled": true } : {}),
            "intentionally-disabled": false,
          });
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("starts a fresh pause interval when re-paused after timed expiry", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-repause-" });
    const botDir = path.join(baseDir, "bots", "helper");
    const configPath = path.join(botDir, "bot.json");
    const config = { name: "Helper", homeThreadId: "home" };
    yield* fs.makeDirectory(botDir, { recursive: true });
    yield* fs.writeFileString(
      configPath,
      toJson({
        ...config,
        pausedAt: "1970-01-01T00:00:00.000Z",
        pausedUntil: "1970-01-01T00:00:01.000Z",
      }),
    );
    yield* insertSchedule(sql, {
      id: "template",
      threadId: "elsewhere",
      enabled: false,
      createdAt: "1969-01-01T00:00:00.000Z",
    });
    yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        const schedules = yield* ScheduledTaskService.ScheduledTaskService;
        yield* TestClock.adjust("1 second");
        const { task } = yield* schedules.upsert({
          ...(yield* schedules.list()).tasks[0]!,
          id: ScheduledTaskId.make("gap-disabled"),
          threadId: ThreadId.make("home"),
          enabled: true,
        });
        expect(task.enabled).toBe(true);
        yield* schedules.setEnabled({ id: task.id, enabled: false });
        yield* TestClock.adjust("1 millis");
        yield* bots.setPaused({ botId: "helper", paused: true });
        expect(yield* fromJson(yield* fs.readFileString(configPath))).toMatchObject({
          pausedAt: "1970-01-01T00:00:01.001Z",
          pausedScheduleIds: [],
        });
        yield* fs.writeFileString(
          configPath,
          toJson({ ...config, paused: true, pausedAt: "1970-01-01T00:00:01.001Z" }),
        );
        yield* bots.setPaused({ botId: "helper", paused: false });
        expect(
          (yield* schedules.list()).tasks.find((task) => task.id === "gap-disabled")?.enabled,
        ).toBe(false);
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
    for (const [ordinal, command] of [
      { status: "completed", input: "printf '%s' 'Sent reply' | bin/dm-send", exitCode: 0 },
      { status: "completed", input: "grep dm-send log.md", exitCode: 0 },
      { status: "completed", input: "printf '%s' 'Failed send' | bin/dm-send", exitCode: 1 },
      { status: "running", input: "printf '%s' 'Pending send' | bin/dm-send", exitCode: 0 },
    ].entries()) {
      const at = `2026-10-01T00:${String(8 + ordinal).padStart(2, "0")}:00.000Z`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${`send-${ordinal}`}, 'home', 'active', ${ordinal + 1}, 'command_execution',
          ${command.status}, ${at}, ${toJson({ input: command.input, exitCode: command.exitCode, completedAt: at })}
        )
      `;
      expect(yield* readReply).toEqual({ text: "Sent reply", at: "2026-10-01T00:08:00.000Z" });
    }
    const { lastReply: _, ...oldBot } = (yield* listBots({ baseDir })).bots[0]!;
    expect((yield* decodeBot(oldBot)).lastReply).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each(["cancelled", "interrupted", "completed"] as const)(
  "keeps the visible owner reply when a hidden wake is %s, including restart continuation",
  (status) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-visible-reply-" });
      const botDir = path.join(baseDir, "bots", "helper");
      yield* fs.makeDirectory(botDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(botDir, "bot.json"),
        toJson({ name: "Helper", homeThreadId: "home" }),
      );
      yield* insertThread(sql, { id: "home", createdAt: "2026-10-01T00:00:00.000Z" });
      yield* insertRun(sql, { id: "owner", threadId: "home", ordinal: 1, status });
      yield* insertMessage(sql, {
        id: "owner-question",
        threadId: "home",
        runId: "owner",
        createdAt: "2026-10-01T00:01:00.000Z",
      });
      yield* insertMessage(sql, {
        id: "owner-progress",
        threadId: "home",
        runId: "owner",
        role: "assistant",
        text: "Checking",
        createdAt: "2026-10-01T00:02:00.000Z",
      });
      yield* insertMessage(sql, {
        id: "owner-reply",
        threadId: "home",
        runId: "owner",
        role: "assistant",
        text: "Visible owner reply",
        createdAt: "2026-10-01T00:03:00.000Z",
      });
      const readReply = listBots({ baseDir }).pipe(
        Effect.map((result) => result.bots[0]!.lastReply),
      );
      const visible = { text: "Visible owner reply", at: "2026-10-01T00:03:00.000Z" };
      expect(yield* readReply).toEqual(visible);
      for (const [ordinal, incoming] of [
        { createdBy: "agent" as const, senderThreadId: "worker" },
        { createdBy: "agent" as const, scheduledTaskId: "schedule" },
        { createdBy: "agent" as const, creationSource: "server" },
      ].entries()) {
        const runId = `hidden-${ordinal}`;
        yield* insertRun(sql, { id: runId, threadId: "home", ordinal: ordinal + 2, status });
        if (incoming.creationSource === "server") {
          yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = ${toJson({ restartContinuationOfRunId: "owner" })} WHERE run_id = ${runId}`;
        }
        yield* insertMessage(sql, {
          id: `${runId}-incoming`,
          threadId: "home",
          runId,
          createdAt: "2026-10-01T00:04:00.000Z",
          ...incoming,
        });
        yield* insertMessage(sql, {
          id: `${runId}-progress`,
          threadId: "home",
          runId,
          role: "assistant",
          text: "Hidden intermediate progress",
          createdAt: "2026-10-01T00:05:00.000Z",
        });
        expect(yield* readReply).toEqual(visible);
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("previews the reply of a background completion that continues an owner request", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-continued-reply-" });
    const botDir = path.join(baseDir, "bots", "helper");
    yield* fs.makeDirectory(botDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(botDir, "bot.json"),
      toJson({ name: "Helper", homeThreadId: "home" }),
    );
    yield* insertThread(sql, { id: "home", createdAt: "2026-10-01T00:00:00.000Z" });
    const readReply = listBots({ baseDir }).pipe(Effect.map((result) => result.bots[0]!.lastReply));
    const notification = {
      source: { kind: "background_command" },
      outcome: "completed",
      summary: "Command finished",
    };
    const turn = (
      ordinal: number,
      incoming: Partial<Parameters<typeof insertMessage>[1]>,
      reply: string,
    ) =>
      Effect.gen(function* () {
        const runId = `run-${ordinal}`;
        yield* insertRun(sql, { id: runId, threadId: "home", ordinal, status: "completed" });
        yield* insertMessage(sql, {
          id: `${runId}-incoming`,
          threadId: "home",
          runId,
          createdAt: `2026-10-01T00:0${ordinal}:00.000Z`,
          ...incoming,
        });
        yield* insertMessage(sql, {
          id: `${runId}-reply`,
          threadId: "home",
          runId,
          role: "assistant",
          text: reply,
          createdAt: `2026-10-01T00:0${ordinal}:30.000Z`,
        });
      });
    const completion = { createdBy: "agent" as const, creationSource: "provider", notification };

    yield* turn(1, {}, "Holding the draft");
    yield* turn(2, { createdBy: "agent", creationSource: "server", text: "/compact" }, "");
    yield* turn(3, completion, "Here is the one-pager");
    const delivered = { text: "Here is the one-pager", at: "2026-10-01T00:03:30.000Z" };
    expect(yield* readReply).toEqual(delivered);
    yield* turn(4, { createdBy: "agent", scheduledTaskId: "schedule" }, "Poll reply");
    yield* turn(5, completion, "Poll follow-up");
    expect(yield* readReply).toEqual(delivered);
    yield* turn(
      6,
      {
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: { parentRunId: "run-1", generation: 1, taskIds: [] },
      },
      "Meeting summary",
    );
    expect(yield* readReply).toEqual({ text: "Meeting summary", at: "2026-10-01T00:06:30.000Z" });
    yield* turn(7, {}, "Two PRs are open");
    yield* turn(
      8,
      { ...completion, notification: { ...notification, source: { kind: "monitor" } } },
      "Nothing needs you.",
    );
    expect(yield* readReply).toEqual({ text: "Two PRs are open", at: "2026-10-01T00:07:30.000Z" });
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each(["mcp__t3-code__notify_owner", "t3-code.notify_owner"])(
  "previews a background final reply only after %s completes",
  (toolName) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-notified-reply-" });
      const botDir = path.join(baseDir, "bots", "helper");
      yield* fs.makeDirectory(botDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(botDir, "bot.json"),
        toJson({ name: "Helper", homeThreadId: "home" }),
      );
      yield* insertThread(sql, { id: "home", createdAt: "2026-10-01T00:00:00.000Z" });
      yield* insertRun(sql, { id: "owner", threadId: "home", ordinal: 1, status: "completed" });
      yield* insertMessage(sql, {
        id: "owner-question",
        threadId: "home",
        runId: "owner",
        createdAt: "2026-10-01T00:01:00.000Z",
      });
      yield* insertMessage(sql, {
        id: "owner-reply",
        threadId: "home",
        runId: "owner",
        role: "assistant",
        text: "Older owner reply",
        createdAt: "2026-10-01T00:02:00.000Z",
      });
      yield* insertRun(sql, { id: "poll", threadId: "home", ordinal: 2, status: "running" });
      yield* insertMessage(sql, {
        id: "poll-prompt",
        threadId: "home",
        runId: "poll",
        scheduledTaskId: "poll-schedule",
        createdAt: "2026-10-01T00:03:00.000Z",
      });
      yield* insertMessage(sql, {
        id: "poll-progress",
        threadId: "home",
        runId: "poll",
        role: "assistant",
        text: "Preparing agenda",
        createdAt: "2026-10-01T00:04:00.000Z",
      });
      yield* insertMessage(sql, {
        id: "poll-final",
        threadId: "home",
        runId: "poll",
        role: "assistant",
        text: "Zoom agenda prepared",
        createdAt: "2026-10-01T00:05:00.000Z",
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          'notification', 'home', 'poll', 1, 'dynamic_tool', 'completed',
          '2026-10-01T00:04:30.000Z', ${toJson({ toolName })}
        )
      `;
      const readReply = listBots({ baseDir }).pipe(
        Effect.map((result) => result.bots[0]!.lastReply),
      );
      const ownerReply = { text: "Older owner reply", at: "2026-10-01T00:02:00.000Z" };
      const notifiedReply = { text: "Zoom agenda prepared", at: "2026-10-01T00:05:00.000Z" };
      expect(yield* readReply).toEqual(ownerReply);
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'poll'`;
      expect(yield* readReply).toEqual(notifiedReply);
      for (const status of ["pending", "running", "failed", "interrupted"]) {
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET status = ${status} WHERE turn_item_id = 'notification'`;
        expect(yield* readReply).toEqual(ownerReply);
      }
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET status = 'completed' WHERE turn_item_id = 'notification'`;
      for (const otherTool of [
        "notify_owner",
        "mcp__other__notify_owner",
        "t3-code.notify_owner_extra",
        "t3-code.thread_send",
      ]) {
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${toJson({ toolName: otherTool })} WHERE turn_item_id = 'notification'`;
        expect(yield* readReply).toEqual(ownerReply);
      }
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${toJson({ toolName })} WHERE turn_item_id = 'notification'`;
      for (const [column, value] of [
        ["thread_id", "other-thread"],
        ["run_id", "owner"],
      ] as const) {
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET ${sql.update({ [column]: value })} WHERE turn_item_id = 'notification'`;
        expect(yield* readReply).toEqual(ownerReply);
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET thread_id = 'home', run_id = 'poll' WHERE turn_item_id = 'notification'`;
      }
      for (const [ordinal, incoming] of [
        { scheduledTaskId: "newer-poll" },
        { createdBy: "agent" as const, creationSource: "server" },
        { createdBy: "agent" as const, senderThreadId: "other-bot" },
      ].entries()) {
        const runId = `unnotified-${ordinal}`;
        yield* insertRun(sql, {
          id: runId,
          threadId: "home",
          ordinal: ordinal + 3,
          status: "completed",
        });
        yield* insertMessage(sql, {
          id: `${runId}-prompt`,
          threadId: "home",
          runId,
          createdAt: "2026-10-01T00:06:00.000Z",
          ...incoming,
        });
        yield* insertMessage(sql, {
          id: `${runId}-reply`,
          threadId: "home",
          runId,
          role: "assistant",
          text: "Unnotified newer reply",
          createdAt: "2026-10-01T00:07:00.000Z",
        });
        expect(yield* readReply).toEqual(notifiedReply);
      }
      yield* insertMessage(sql, {
        id: "poll-streaming",
        threadId: "home",
        runId: "poll",
        role: "assistant",
        streaming: true,
        text: "Streaming reply",
        createdAt: "2026-10-01T00:08:00.000Z",
      });
      expect(yield* readReply).toEqual(notifiedReply);
      yield* insertMessage(sql, {
        id: "compact-prompt",
        threadId: "home",
        runId: "poll",
        createdBy: "agent",
        creationSource: "server",
        text: "/compact",
        createdAt: "2026-10-01T00:09:00.000Z",
      });
      expect(yield* readReply).toEqual(ownerReply);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("reports a held queue only while held runs remain queued", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-queue-" });
    const botDir = path.join(baseDir, "bots", "helper");
    yield* fs.makeDirectory(botDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(botDir, "bot.json"),
      toJson({ name: "Helper", homeThreadId: "home" }),
    );
    yield* insertThread(sql, { id: "home", createdAt: "2026-10-01T00:00:00.000Z" });
    yield* insertRun(sql, { id: "held", threadId: "home", ordinal: 1, status: "queued" });
    const readHeld = listBots({ baseDir }).pipe(
      Effect.map((result) => result.bots[0]!.homeThreadQueueHeld),
    );
    expect(yield* readHeld).toBeUndefined();
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{"queueHeld":true}' WHERE run_id = 'held'`;
    expect(yield* readHeld).toBe(true);
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{"queueHeld":false}' WHERE run_id = 'held'`;
    expect(yield* readHeld).toBeUndefined();
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed', payload_json = '{"queueHeld":true}' WHERE run_id = 'held'`;
    expect(yield* readHeld).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("distinguishes archived home threads from deleted and absent ones", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-home-" });
    const root = path.join(baseDir, "bots");
    for (const id of ["active", "archived", "deleted", "absent"]) {
      yield* fs.makeDirectory(path.join(root, id), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, id, "bot.json"),
        toJson({ name: id, homeThreadId: `${id}-home` }),
      );
    }
    yield* insertThread(sql, { id: "active-home", createdAt: "2026-10-01T00:00:00.000Z" });
    yield* insertThread(sql, { id: "archived-home", createdAt: "2026-10-01T00:00:00.000Z" });
    yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = '2026-10-01T00:01:00.000Z' WHERE thread_id = 'archived-home'`;
    yield* insertThread(sql, {
      id: "deleted-home",
      createdAt: "2026-10-01T00:00:00.000Z",
      deletedAt: "2026-10-01T00:01:00.000Z",
    });

    const { bots } = yield* listBots({ baseDir });
    expect(Object.fromEntries(bots.map((bot) => [bot.id, bot.homeThreadMissing]))).toEqual({
      absent: true,
      active: false,
      archived: false,
      deleted: true,
    });
    expect(Object.fromEntries(bots.map((bot) => [bot.id, bot.homeThreadArchived]))).toEqual({
      absent: false,
      active: false,
      archived: true,
      deleted: false,
    });
    const { homeThreadArchived: _, ...oldBot } = bots.find((bot) => bot.id === "archived")!;
    expect((yield* decodeBot(oldBot)).homeThreadArchived).toBeUndefined();
    yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = NULL WHERE thread_id = 'archived-home'`;
    expect(
      (yield* listBots({ baseDir })).bots.find((bot) => bot.id === "archived")!.homeThreadArchived,
    ).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("reads current bot home pause state without transcripts or cached pause flags", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-idle-pause-" });
    const botDir = path.join(baseDir, "bots", "helper");
    const configPath = path.join(botDir, "bot.json");
    yield* fs.makeDirectory(botDir, { recursive: true });
    yield* fs.writeFileString(path.join(baseDir, "bots", "BOTS.md"), "");
    const config = { name: "Helper", homeThreadId: "home", triageThreadId: "triage" };
    yield* fs.writeFileString(configPath, toJson(config));
    yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        const home = ThreadId.make("home");
        expect(yield* bots.isHomeThreadPaused(home)).toBe(false);
        yield* fs.writeFileString(configPath, toJson({ ...config, paused: true }));
        expect(yield* bots.isHomeThreadPaused(home)).toBe(true);
        expect(yield* bots.isHomeThreadPaused(ThreadId.make("ordinary"))).toBe(false);
        expect(yield* bots.isHomeThreadPaused(ThreadId.make("triage"))).toBe(false);
        yield* fs.writeFileString(
          configPath,
          toJson({ ...config, pausedUntil: "1970-01-01T00:00:01.000Z" }),
        );
        expect(yield* bots.isHomeThreadPaused(home)).toBe(true);
        yield* TestClock.adjust("1 second");
        expect(yield* bots.isHomeThreadPaused(home)).toBe(false);
        yield* bots.setPaused({ botId: "helper", paused: true });
        expect(yield* bots.isHomeThreadPaused(home)).toBe(true);
        yield* bots.setPaused({ botId: "helper", paused: false });
        expect(yield* bots.isHomeThreadPaused(home)).toBe(false);
        yield* fs.writeFileString(configPath, "malformed");
        expect(yield* bots.isHomeThreadPaused(home)).toBe(true);
      }),
    );
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
        directoryReads = 0;
        configReads = 0;
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
      if (
        logLevel === "Warn" &&
        Array.isArray(message) &&
        message[0] === "Cannot read bot home threads"
      )
        warnings.push(message);
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
            pausedAt: "1970-01-01T00:00:00.000Z",
            pausedReason: "Paused from the Bots view",
            pausedScheduleIds: [],
          }
        : {}),
    });
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each([
  { paused: true },
  { pausedUntil: "2999-01-01T00:00:00Z" },
  { pausedUntil: "1969-01-01T00:00:00Z" },
])(
  "preserves disabled schedules when no resume ids were recorded for pause fields %j",
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
            "listed-disabled": false,
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

it.effect.each(["worker", "resume"] as const)(
  "restores remembered schedules after pause expiry through %s",
  (operation) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-expiry-" });
      const botDir = path.join(baseDir, "bots", "helper");
      const configPath = path.join(botDir, "bot.json");
      const config = {
        name: "Helper",
        homeThreadId: "home",
        scheduledTaskId: "manually-off",
        agentState: { cursor: "kept" },
      };
      yield* fs.makeDirectory(botDir, { recursive: true });
      yield* fs.writeFileString(
        configPath,
        toJson({
          ...config,
          pausedUntil: "1970-01-01T00:00:01.000Z",
          pausedReason: "Timed pause",
          pausedScheduleIds: ["remembered", "already-on", "removed"],
        }),
      );
      for (const schedule of [
        { id: "remembered", enabled: false },
        { id: "already-on", enabled: true },
        { id: "manually-off", enabled: false },
      ]) {
        yield* insertSchedule(sql, {
          ...schedule,
          threadId: "home",
          createdAt: "2026-10-01T00:00:00.000Z",
        });
      }
      const restored = yield* Deferred.make<void>();
      yield* withBots(
        { baseDir },
        Effect.gen(function* () {
          const bots = yield* BotService.BotService;
          const schedules = yield* ScheduledTaskService.ScheduledTaskService;
          const readEnabled = schedules
            .list()
            .pipe(
              Effect.map(({ tasks }) =>
                Object.fromEntries(tasks.map((task) => [task.id, task.enabled])),
              ),
            );
          expect((yield* bots.list()).bots[0]!.paused).toBe(true);
          expect(yield* readEnabled).toEqual({
            remembered: false,
            "already-on": true,
            "manually-off": false,
          });
          yield* TestClock.adjust(operation === "worker" ? "1 minute" : "1 second");
          if (operation === "worker") yield* Deferred.await(restored);
          if (operation === "resume") {
            yield* bots.setPaused({ botId: "helper", paused: false });
            expect((yield* readEnabled).remembered).toBe(true);
          }
          expect((yield* bots.list()).bots[0]!.paused).toBe(false);
          expect(yield* readEnabled).toEqual({
            remembered: true,
            "already-on": true,
            "manually-off": false,
          });
          expect(yield* fromJson(yield* fs.readFileString(configPath))).toEqual(config);
          yield* schedules.setEnabled({ id: ScheduledTaskId.make("remembered"), enabled: false });
          yield* bots.setPaused({ botId: "helper", paused: false });
          yield* bots.list();
          expect((yield* readEnabled).remembered).toBe(false);
          yield* fs.writeFileString(
            configPath,
            toJson({
              ...config,
              paused: true,
              pausedUntil: "1970-01-01T00:00:01.000Z",
              pausedScheduleIds: ["remembered"],
            }),
          );
          expect((yield* bots.list()).bots[0]!.paused).toBe(true);
          expect((yield* readEnabled).remembered).toBe(false);
        }),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (source, target) =>
            fs
              .rename(source, target)
              .pipe(
                Effect.tap(() =>
                  target === configPath ? Deferred.succeed(restored, undefined) : Effect.void,
                ),
              ),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("does not expire a pause renewed before the startup restore acquires the lock", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-renew-pause-" });
    const botDir = path.join(baseDir, "bots", "helper");
    const configPath = path.join(botDir, "bot.json");
    const config = { name: "Helper", homeThreadId: "home", pausedScheduleIds: ["remembered"] };
    yield* fs.makeDirectory(botDir, { recursive: true });
    yield* fs.writeFileString(
      configPath,
      toJson({ ...config, pausedUntil: "1969-01-01T00:00:00Z" }),
    );
    yield* insertSchedule(sql, {
      id: "remembered",
      threadId: "home",
      enabled: false,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    let reads = 0;
    const renewingFs = FileSystem.FileSystem.of({
      ...fs,
      readFileString: (...args) =>
        Effect.gen(function* () {
          if (args[0] === configPath && ++reads === 2) {
            yield* fs.writeFileString(configPath, toJson({ ...config, paused: true }));
          }
          return yield* fs.readFileString(...args);
        }),
    });
    yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        const schedules = yield* ScheduledTaskService.ScheduledTaskService;
        expect((yield* bots.list()).bots[0]!.paused).toBe(true);
        expect((yield* schedules.list()).tasks[0]!.enabled).toBe(false);
        expect(yield* fromJson(yield* fs.readFileString(configPath))).toEqual({
          ...config,
          paused: true,
        });
      }),
    ).pipe(Effect.provideService(FileSystem.FileSystem, renewingFs));
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
              if (
                logLevel === "Warn" &&
                Array.isArray(message) &&
                message[0] === "Cannot read bot home threads"
              )
                warnings.push(message);
            }),
          ],
          { mergeWithExisting: false },
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "restores expired pauses at startup, keeps failed bots visible, and retries independently",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-restore-failure-" });
      for (const id of ["broken", "healthy", "unreadable"]) {
        const botDir = path.join(baseDir, "bots", id);
        yield* fs.makeDirectory(botDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(botDir, "bot.json"),
          id === "unreadable"
            ? "{"
            : toJson({
                name: id,
                homeThreadId: id,
                pausedUntil: "1969-01-01T00:00:00Z",
                pausedScheduleIds: [id],
              }),
        );
        if (id !== "unreadable")
          yield* insertSchedule(sql, {
            id,
            threadId: id,
            enabled: false,
            createdAt: "2026-10-01T00:00:00.000Z",
          });
      }
      const brokenPath = path.join(baseDir, "bots", "broken", "bot.json");
      const restored = yield* Deferred.make<void>();
      const warnings: unknown[] = [];
      let failRestore = true;
      let writes = 0;
      yield* withBots(
        { baseDir },
        Effect.gen(function* () {
          const bots = yield* BotService.BotService;
          const schedules = yield* ScheduledTaskService.ScheduledTaskService;
          expect(
            Object.fromEntries(
              (yield* schedules.list()).tasks.map((task) => [task.id, task.enabled]),
            ),
          ).toEqual({ broken: false, healthy: true });
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toMatchObject([
            "Cannot restore expired bot pause",
            { botId: "broken" },
          ]);
          const startupWrites = writes;
          expect((yield* bots.list()).bots.map((bot) => [bot.id, bot.paused])).toEqual([
            ["broken", false],
            ["healthy", false],
          ]);
          expect(writes).toBe(startupWrites);
          expect(yield* fromJson(yield* fs.readFileString(brokenPath))).toMatchObject({
            pausedScheduleIds: ["broken"],
          });
          failRestore = false;
          yield* TestClock.adjust("1 minute");
          yield* Deferred.await(restored);
          expect((yield* schedules.list()).tasks.every((task) => task.enabled)).toBe(true);
          expect(yield* fromJson(yield* fs.readFileString(brokenPath))).toEqual({
            name: "broken",
            homeThreadId: "broken",
          });
        }),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (source, target) =>
            Effect.gen(function* () {
              writes++;
              if (target === brokenPath && failRestore)
                return yield* new PlatformError.PlatformError(
                  new PlatformError.SystemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                  }),
                );
              yield* fs.rename(source, target);
              if (target === brokenPath) yield* Deferred.succeed(restored, undefined);
            }),
        }),
        Effect.provide(
          Logger.layer(
            [
              Logger.make(({ logLevel, message }) => {
                if (
                  logLevel === "Warn" &&
                  Array.isArray(message) &&
                  message[0] === "Cannot restore expired bot pause"
                )
                  warnings.push(message);
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("serializes an enable already reading bot state with a concurrent pause", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-enable-race-" });
    const botDir = path.join(baseDir, "bots", "helper");
    const configPath = path.join(botDir, "bot.json");
    yield* fs.makeDirectory(botDir, { recursive: true });
    yield* fs.writeFileString(configPath, toJson({ name: "Helper", homeThreadId: "home" }));
    yield* insertSchedule(sql, {
      id: "wake",
      threadId: "home",
      enabled: false,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const checking = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let blockRead = false;
    yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        const schedules = yield* ScheduledTaskService.ScheduledTaskService;
        blockRead = true;
        const enabling = yield* schedules
          .setEnabled({ id: ScheduledTaskId.make("wake"), enabled: true })
          .pipe(Effect.forkChild);
        yield* Deferred.await(checking);
        const pausing = yield* bots
          .setPaused({ botId: "helper", paused: true })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(enabling);
        yield* Fiber.join(pausing);
        expect((yield* schedules.list()).tasks[0]?.enabled).toBe(false);
        expect(yield* fromJson(yield* fs.readFileString(configPath))).toMatchObject({
          paused: true,
          pausedScheduleIds: ["wake"],
        });
        yield* bots.setPaused({ botId: "helper", paused: false });
        expect((yield* schedules.list()).tasks[0]?.enabled).toBe(true);
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: (filePath, options) =>
          fs.readFileString(filePath, options).pipe(
            Effect.tap(() => {
              if (filePath !== configPath || !blockRead) return Effect.void;
              blockRead = false;
              return Deferred.succeed(checking, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              );
            }),
          ),
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "serializes task deletion with a pause and allows transition deletes to bypass the lock",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-delete-race-" });
      const botDir = path.join(baseDir, "bots", "helper");
      const configPath = path.join(botDir, "bot.json");
      yield* fs.makeDirectory(botDir, { recursive: true });
      yield* fs.writeFileString(configPath, toJson({ name: "Helper", homeThreadId: "home" }));
      for (const id of ["wake", "bypass"]) {
        yield* insertSchedule(sql, {
          id,
          threadId: "home",
          enabled: true,
          createdAt: "1969-01-01T00:00:00.000Z",
        });
      }
      const pausing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const deleting = yield* Deferred.make<void>();
      const deleted = yield* Deferred.make<void>();
      let blockRead = false;
      yield* withBots(
        { baseDir },
        Effect.gen(function* () {
          const bots = yield* BotService.BotService;
          const schedules = yield* ScheduledTaskService.ScheduledTaskService;
          blockRead = true;
          const pause = yield* bots
            .setPaused({ botId: "helper", paused: true })
            .pipe(Effect.forkChild);
          yield* Deferred.await(pausing);
          const deletion = yield* Effect.gen(function* () {
            yield* Deferred.succeed(deleting, undefined);
            yield* schedules.delete({ id: ScheduledTaskId.make("wake") });
            yield* Deferred.succeed(deleted, undefined);
          }).pipe(Effect.forkChild);
          yield* Deferred.await(deleting);
          expect(yield* Deferred.isDone(deleted)).toBe(false);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pause);
          yield* Fiber.join(deletion);
          expect(yield* fromJson(yield* fs.readFileString(configPath))).toMatchObject({
            paused: true,
            pausedScheduleIds: ["bypass", "wake"],
          });
          yield* schedules.withBotPauseLock(
            schedules
              .delete({ id: ScheduledTaskId.make("bypass") })
              .pipe(Effect.provideService(BotSchedulePauseTransition, true)),
          );
          yield* bots.setPaused({ botId: "helper", paused: false });
          expect((yield* schedules.list()).tasks).toEqual([]);
          expect(yield* fromJson(yield* fs.readFileString(configPath))).toEqual({
            name: "Helper",
            homeThreadId: "home",
          });
        }),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (filePath, options) =>
            fs.readFileString(filePath, options).pipe(
              Effect.tap(() => {
                if (filePath !== configPath || !blockRead) return Effect.void;
                blockRead = false;
                return Deferred.succeed(pausing, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                );
              }),
            ),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("pushes pause, resume, home archive and unarchive invalidations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-push-" });
    const botDir = path.join(baseDir, "bots", "helper");
    yield* fs.makeDirectory(botDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(botDir, "bot.json"),
      toJson({ name: "Helper", homeThreadId: "home" }),
    );
    yield* insertSchedule(sql, {
      id: "wake",
      threadId: "home",
      enabled: false,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    yield* withBots(
      { baseDir, domainEvents: Stream.fromQueue(events) },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        const invalidations = yield* Queue.unbounded<{}>();
        yield* bots.streamChanges.pipe(
          Stream.runForEach((event) => Queue.offer(invalidations, event)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Queue.take(invalidations);
        for (const paused of [true, false]) {
          yield* bots.setPaused({ botId: "helper", paused });
          expect(yield* Queue.take(invalidations)).toEqual({});
          expect((yield* bots.list()).bots[0]?.paused).toBe(paused);
        }
        for (const type of ["thread.archived", "thread.unarchived"] as const) {
          yield* Queue.offer(events, {
            type,
            threadId: ThreadId.make("home"),
          } as OrchestrationV2DomainEvent);
          expect(yield* Queue.take(invalidations)).toEqual({});
        }
        const schedules = yield* ScheduledTaskService.ScheduledTaskService;
        const existing = (yield* schedules.list()).tasks[0]!;
        yield* schedules.upsert({ ...existing, id: ScheduledTaskId.make("new-wake") });
        yield* Queue.take(invalidations);
        expect((yield* bots.list()).bots[0]?.scheduledTaskIds?.toSorted()).toEqual([
          "new-wake",
          "wake",
        ]);
        yield* schedules.delete({ id: ScheduledTaskId.make("new-wake") });
        yield* Queue.take(invalidations);
        expect((yield* bots.list()).bots[0]?.scheduledTaskIds).toEqual(["wake"]);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "reuses worker membership while reading current titles and status, and invalidates new or deleted workers",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-workers-" });
      const botDir = path.join(baseDir, "bots", "helper");
      yield* fs.makeDirectory(botDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(botDir, "bot.json"),
        toJson({ name: "Helper", homeThreadId: "home" }),
      );
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      yield* insertThread(sql, {
        id: "first",
        createdAt: "2026-10-01T00:00:00.000Z",
        parentThreadId: "home",
      });
      yield* withBots(
        { baseDir, domainEvents: Stream.fromQueue(events) },
        Effect.gen(function* () {
          const bots = yield* BotService.BotService;
          const invalidations = yield* Queue.unbounded<{}>();
          yield* bots.streamChanges.pipe(
            Stream.runForEach((event) => Queue.offer(invalidations, event)),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Queue.take(invalidations);
          expect(
            (yield* bots.get({ botId: "helper" })).workers.map((worker) => worker.threadId),
          ).toEqual(["first"]);
          yield* sql`UPDATE orchestration_v2_projection_threads SET title = 'New title' WHERE thread_id = 'first'`;
          yield* insertRun(sql, {
            id: "first-run",
            threadId: "first",
            ordinal: 1,
            status: "failed",
          });
          expect((yield* bots.get({ botId: "helper" })).workers[0]).toMatchObject({
            title: "New title",
            status: "failed",
          });
          yield* insertThread(sql, {
            id: "second",
            createdAt: "2026-10-01T00:01:00.000Z",
            parentThreadId: "home",
          });
          expect(
            (yield* bots.get({ botId: "helper" })).workers.map((worker) => worker.threadId),
          ).toEqual(["first"]);
          for (const type of ["thread.created", "thread.deleted"] as const) {
            if (type === "thread.deleted")
              yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'first'`;
            yield* Queue.offer(events, {
              type,
              threadId: ThreadId.make("second"),
            } as OrchestrationV2DomainEvent);
            yield* Queue.offer(events, {
              type: "thread.archived",
              threadId: ThreadId.make("home"),
            } as OrchestrationV2DomainEvent);
            yield* Queue.take(invalidations);
            expect(
              (yield* bots.get({ botId: "helper" })).workers.map((worker) => worker.threadId),
            ).toEqual(type === "thread.created" ? ["first", "second"] : ["second"]);
          }
          yield* insertThread(sql, { id: "launched", createdAt: "2026-10-01T00:02:00.000Z" });
          yield* Queue.offer(events, {
            type: "thread.created",
            threadId: ThreadId.make("launched"),
          } as OrchestrationV2DomainEvent);
          yield* Queue.offer(events, {
            type: "thread.archived",
            threadId: ThreadId.make("home"),
          } as OrchestrationV2DomainEvent);
          yield* Queue.take(invalidations);
          expect(
            (yield* bots.get({ botId: "helper" })).workers.map((worker) => worker.threadId),
          ).toEqual(["second"]);
          yield* insertMessage(sql, {
            id: "launch-message",
            threadId: "launched",
            createdAt: "2026-10-01T00:02:00.000Z",
            senderThreadId: "home",
          });
          yield* Queue.offer(events, {
            type: "message.updated",
            threadId: ThreadId.make("launched"),
            payload: { role: "user", senderThreadId: ThreadId.make("home") },
          } as OrchestrationV2DomainEvent);
          yield* Queue.offer(events, {
            type: "thread.archived",
            threadId: ThreadId.make("home"),
          } as OrchestrationV2DomainEvent);
          yield* Queue.take(invalidations);
          expect(
            (yield* bots.get({ botId: "helper" })).workers.map((worker) => worker.threadId),
          ).toEqual(["second", "launched"]);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "pushes bot file creation, timed pause, schedule ids and deletion as tiny invalidations",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-files-" });
      const botDir = path.join(baseDir, "bots", "helper");
      const watchEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
      yield* withBots(
        { baseDir },
        Effect.gen(function* () {
          const bots = yield* BotService.BotService;
          const invalidations = yield* Queue.unbounded<{}>();
          yield* bots.streamChanges.pipe(
            Stream.runForEach((event) => Queue.offer(invalidations, event)),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Queue.take(invalidations);
          yield* fs.makeDirectory(botDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(botDir, "bot.json"),
            toJson({
              name: "Helper",
              homeThreadId: "home",
              pausedUntil: "2999-01-01T00:00:00Z",
              scheduledTaskId: "wake",
            }),
          );
          yield* Queue.offer(watchEvents, {
            _tag: "Create",
            path: path.join("bots", "helper", "bot.json"),
          });
          yield* TestClock.adjust("100 millis");
          expect(yield* Queue.take(invalidations)).toEqual({});
          expect((yield* bots.list()).bots[0]).toMatchObject({
            paused: true,
            pausedUntil: "2999-01-01T00:00:00Z",
            scheduledTaskIds: ["wake"],
          });
          expect(yield* bots.isHomeThread(ThreadId.make("home"))).toBe(true);
          yield* fs.remove(botDir, { recursive: true });
          yield* Queue.offer(watchEvents, { _tag: "Remove", path: botDir });
          yield* TestClock.adjust("100 millis");
          expect(yield* Queue.take(invalidations)).toEqual({});
          expect(yield* bots.list()).toEqual({ bots: [] });
          expect(yield* bots.isHomeThread(ThreadId.make("home"))).toBe(false);
        }),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          watch: () => Stream.fromQueue(watchEvents),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "notify_owner validates its caller and folds every notification of the current bot run",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bot-notify-" });
      yield* fs.makeDirectory(path.join(baseDir, "bots", "helper"), { recursive: true });
      yield* fs.writeFileString(
        path.join(baseDir, "bots", "helper", "bot.json"),
        toJson({ name: "Helper", homeThreadId: "home" }),
      );
      let activeRunId: RunId | null = RunId.make("wake-run");
      yield* withBots(
        {
          baseDir,
          readShell: () =>
            Effect.succeed({
              activeRunId,
              archivedAt: null,
              deletedAt: null,
            } as OrchestrationV2ThreadShell),
        },
        Effect.gen(function* () {
          const bots = yield* BotService.BotService;
          const server = yield* McpServer.McpServer;
          const scope: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("test-environment"),
            issuedAt: 0,
            requestNamespace: "test-session",
            capabilities: new Set(["orchestration"]),
            client: undefined,
            thread: {
              threadId: ThreadId.make("home"),
              providerSessionId: "session",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          };
          const client = McpSchema.McpServerClient.of({
            clientId: 1,
            protocolVersion: "2025-06-18",
            clientCapabilities: {},
            clientInfo: { name: "bot-notify-test", version: "1" },
            initializePayload: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "bot-notify-test", version: "1" },
            },
            getClient: Effect.die("unused"),
          });
          const call = (input: Record<string, unknown>, caller = scope) =>
            server
              .callTool({ name: "notify_owner", arguments: input })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
                Effect.provideService(McpSchema.McpServerClient, client),
              );
          const notification = { title: "Action needed", body: "Please review the deployment." };
          expect((yield* call(notification)).isError).toBe(false);
          expect(
            yield* bots.getOwnerNotification(ThreadId.make("home"), RunId.make("wake-run")),
          ).toEqual(notification);
          expect((yield* call({ title: "Merge?", body: "CI is green." })).isError).toBe(false);
          expect(
            yield* bots.getOwnerNotification(ThreadId.make("home"), RunId.make("wake-run")),
          ).toEqual({ body: "Action needed: Please review the deployment.\nMerge?: CI is green." });
          expect(
            yield* bots.getOwnerNotification(ThreadId.make("home"), RunId.make("next-run")),
          ).toBeUndefined();
          const outside = yield* call(
            { body: "Notify" },
            { ...scope, thread: { ...scope.thread!, threadId: ThreadId.make("worker") } },
          );
          expect(outside.isError).toBe(true);
          expect(toJson(outside.content)).toContain("requires a bot home thread");
          expect((yield* call({ body: "Notify" }, { ...scope, thread: undefined })).isError).toBe(
            true,
          );
          expect(
            (yield* call({ body: "Notify" }, { ...scope, capabilities: new Set() })).isError,
          ).toBe(true);
          expect(Exit.isFailure(yield* Effect.exit(call({ body: "x".repeat(301) })))).toBe(true);
          expect(
            Exit.isFailure(yield* Effect.exit(call({ title: "x".repeat(81), body: "Notify" }))),
          ).toBe(true);
          activeRunId = RunId.make("next-run");
          expect((yield* call({ body: "Second notification" })).isError).toBe(false);
          expect(
            yield* bots.getOwnerNotification(ThreadId.make("home"), RunId.make("wake-run")),
          ).toBeUndefined();
          expect(
            yield* bots.getOwnerNotification(ThreadId.make("home"), RunId.make("next-run")),
          ).toEqual({ body: "Second notification" });
          activeRunId = null;
          expect((yield* call({ body: "Notify" })).isError).toBe(true);
        }).pipe(
          Effect.provide(
            McpHttpServer.toolkitRegistration(OrchestratorToolkit, OrchestratorHandlers.layer).pipe(
              Layer.provide(
                Layer.mock(ThreadManagementService.ThreadManagementService)({
                  getThreadShell: (threadId) =>
                    Effect.succeed(liveThreadShell(threadId, { activeRunId })),
                }),
              ),
              Layer.provideMerge(McpServer.McpServer.layer),
              Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
              Layer.provide(Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({})),
              Layer.provide(Layer.mock(OpenItemService.OpenItemService)({})),
              Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
              Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
              Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("persists bot order across service restarts and appends new bots alphabetically", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-order-" });
    const root = path.join(baseDir, "bots");
    const addBot = (id: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(root, id), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, id, "bot.json"),
          toJson({ name: id, homeThreadId: id }),
        );
      });
    yield* addBot("alpha");
    yield* addBot("beta");
    yield* addBot("gamma");
    expect((yield* listBots({ baseDir })).bots.map((bot) => bot.id)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    const config = yield* fs.readFileString(path.join(root, "beta", "bot.json"));
    yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        yield* bots.reorderBots(["gamma", "missing", "beta", "gamma"]);
        expect((yield* bots.list()).bots.map((bot) => bot.id)).toEqual(["gamma", "beta", "alpha"]);
      }),
    );
    expect(JSON.parse(yield* fs.readFileString(path.join(root, "order.json")))).toEqual([
      "gamma",
      "missing",
      "beta",
    ]);
    expect(yield* fs.readFileString(path.join(root, "beta", "bot.json"))).toBe(config);
    yield* addBot("delta");
    yield* fs.remove(path.join(root, "gamma"), { recursive: true });
    expect((yield* listBots({ baseDir })).bots.map((bot) => bot.id)).toEqual([
      "beta",
      "alpha",
      "delta",
    ]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("publishes reorder changes and rejects invalid names without replacing the order", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-order-" });
    yield* fs.makeDirectory(path.join(baseDir, "bots"));
    yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        const subscribed = yield* Deferred.make<void>();
        const changed = yield* bots.streamChanges.pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.drop(1),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        yield* bots.reorderBots(["beta", "alpha"]);
        expect((yield* Fiber.join(changed)).length).toBe(1);
        const rejected = yield* bots.reorderBots(["../alpha"]).pipe(Effect.exit);
        expect(Exit.isFailure(rejected)).toBe(true);
        expect(
          JSON.parse(yield* fs.readFileString(path.join(baseDir, "bots", "order.json"))),
        ).toEqual(["beta", "alpha"]);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("reports unreadable bot order instead of silently discarding a saved order", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-order-" });
    yield* fs.makeDirectory(path.join(baseDir, "bots"));
    yield* fs.writeFileString(path.join(baseDir, "bots", "order.json"), "{}");
    expect(Exit.isFailure(yield* listBots({ baseDir }).pipe(Effect.exit))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("summarizes what the bots did since the owner last spoke and offers open findings", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-morning-" });
    const root = path.join(baseDir, "bots");
    for (const [id, homeThreadId] of [
      ["helper", "home"],
      ["quiet", "quiet-home"],
    ] as const) {
      yield* fs.makeDirectory(path.join(root, id), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, id, "bot.json"),
        toJson({ name: id === "helper" ? "Helper" : "Quiet", homeThreadId }),
      );
    }
    yield* fs.makeDirectory(path.join(root, "memory"));
    const findingsPath = path.join(root, "memory", "findings.md");
    yield* fs.writeFileString(
      findingsPath,
      [
        "# Findings",
        "Format: `<date> | <bot> | pattern|proposal|none | <what, evidence> | <fix or stream, cost>`",
        "2026-10-05 | helper | pattern | stale finding | old fix",
        "2026-10-08 | helper | pattern | re-asked twice | dedupe asks, 1h",
        "2026-10-08 | quiet | proposal | nightly digest | stream digest, small",
        "2026-10-08 | quiet | none | nothing new | -",
        "2026-10-08 | agent | pattern | not a bot | -",
      ].join("\n"),
    );
    const before = yield* fs.readFileString(findingsPath);

    yield* insertRun(sql, { id: "evening", threadId: "home", ordinal: 1, status: "completed" });
    yield* insertMessage(sql, {
      id: "goodnight",
      threadId: "home",
      runId: "evening",
      text: "Goodnight",
      createdAt: "2026-10-07T20:00:00.000Z",
    });
    yield* insertMessage(sql, {
      id: "evening-reply",
      threadId: "home",
      runId: "evening",
      role: "assistant",
      text: "Night.",
      createdAt: "2026-10-07T20:01:00.000Z",
    });
    for (const [ordinal, wake] of [
      { id: "wake-1", notify: true, reply: "Merged the fix.", at: "2026-10-08T02:00" },
      { id: "wake-2", notify: true, reply: "**Two** PRs need review.", at: "2026-10-08T04:00" },
      { id: "wake-3", notify: false, reply: "Nothing to report.", at: "2026-10-08T05:00" },
    ].entries()) {
      yield* insertRun(sql, {
        id: wake.id,
        threadId: "home",
        ordinal: ordinal + 2,
        status: "completed",
      });
      yield* insertMessage(sql, {
        id: `${wake.id}-prompt`,
        threadId: "home",
        runId: wake.id,
        createdBy: "agent",
        scheduledTaskId: "wake",
        text: "Wake up.",
        createdAt: `${wake.at}:00.000Z`,
      });
      yield* insertMessage(sql, {
        id: `${wake.id}-progress`,
        threadId: "home",
        runId: wake.id,
        role: "assistant",
        text: "Looking.",
        createdAt: `${wake.at}:01.000Z`,
      });
      yield* insertMessage(sql, {
        id: `${wake.id}-reply`,
        threadId: "home",
        runId: wake.id,
        role: "assistant",
        text: wake.reply,
        createdAt: `${wake.at}:02.000Z`,
      });
      if (wake.notify) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${`${wake.id}-notify`}, 'home', ${wake.id}, 1, 'dynamic_tool', 'completed',
            ${`${wake.at}:01.500Z`}, ${toJson({ toolName: "t3-code.notify_owner" })}
          )
        `;
      }
    }

    const readMorning = withBots(
      { baseDir },
      Effect.flatMap(BotService.BotService, (bots) => bots.morning()),
    );
    yield* TestClock.setTime(Date.parse("2026-10-08T01:59:00.000Z"));
    expect(yield* readMorning).toBeNull();
    yield* TestClock.setTime(Date.parse("2026-10-08T07:00:00.000Z"));
    yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        const morning = yield* bots.morning();
        expect(morning).toMatchObject({
          awaySince: "2026-10-07T20:00:00.000Z",
          bots: [
            {
              botId: "helper",
              name: "Helper",
              replyCount: 3,
              latestReply: "Two PRs need review.",
              latestAt: "2026-10-08T04:00:02.000Z",
            },
          ],
          findings: [
            { botId: "helper", kind: "pattern", what: "re-asked twice", fix: "dedupe asks, 1h" },
            {
              botId: "quiet",
              kind: "proposal",
              what: "nightly digest",
              fix: "stream digest, small",
            },
          ],
        });

        yield* insertMessage(sql, {
          id: "skip",
          threadId: "home",
          text: "Skip your finding: re-asked twice",
          createdAt: "2026-10-08T07:01:00.000Z",
        });
        yield* insertMessage(sql, {
          id: "accept",
          threadId: "quiet-home",
          text: "Go ahead with your finding: nightly digest (stream digest, small)",
          createdAt: "2026-10-08T07:02:00.000Z",
        });
        expect(yield* bots.morning()).toMatchObject({
          awaySince: "2026-10-07T20:00:00.000Z",
          findings: [],
        });

        yield* insertMessage(sql, {
          id: "morning",
          threadId: "quiet-home",
          text: "Morning",
          createdAt: "2026-10-08T07:03:00.000Z",
        });
        expect(yield* bots.morning()).toBeNull();
      }),
    );
    expect(yield* fs.readFileString(findingsPath)).toBe(before);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
