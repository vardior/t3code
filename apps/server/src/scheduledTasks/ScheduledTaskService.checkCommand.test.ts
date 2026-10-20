import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskId, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const insertCheckedTask = (
  sql: SqlClient.SqlClient,
  input: { id: string; next: string; checkCommand: string },
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: input.id,
    title: input.id,
    prompt: "Act on the poll output.",
    enabled: 1,
    schedule_json: JSON.stringify({
      type: "interval",
      everyMs: 60_000,
      checkCommand: input.checkCommand,
    }),
    project_id: "project:test",
    thread_id: null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "agent",
    creation_source: "mcp",
    created_at: input.next,
    updated_at: input.next,
    next_run_at: input.next,
    last_run_at: null,
    last_run_status: "never",
    last_run_error: null,
    run_count: 0,
  })}`;

it.effect(
  "a quiet check starts no turn, output wakes the agent with it appended, and a failing check is a failed run",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      yield* insertCheckedTask(sql, { id: "quiet", next: now, checkCommand: "true" });
      yield* insertCheckedTask(sql, {
        id: "broken",
        next: now,
        checkCommand: "echo cannot reach slack >&2; exit 3",
      });
      yield* insertCheckedTask(sql, {
        id: "news",
        next: "2026-09-09T12:00:00.500Z",
        checkCommand: "printf '%s\\n' '- Slack: two new mentions'",
      });
      yield* TestClock.setTime(Date.parse(now) + 1_000);

      const launchedPrompts = yield* Ref.make<ReadonlyArray<string>>([]);
      const newsDispatched = yield* Deferred.make<void>();
      let dueWork = Effect.void;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer.pipe(Layer.provide(NodeServices.layer)),
              Layer.mergeAll(
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: (input) =>
                    Ref.update(launchedPrompts, (prompts) => [
                      ...prompts,
                      input.initialMessage?.text ?? "",
                    ]).pipe(
                      Effect.andThen(Deferred.succeed(newsDispatched, undefined)),
                      Effect.andThen(Effect.die(new Error("launch recorded"))),
                    ),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Layer.mock(Scheduler.Scheduler)({
                  register: <E, R>(_: string, work: Effect.Effect<void, E, R>) =>
                    Effect.gen(function* () {
                      const context = yield* Effect.context<R>();
                      dueWork = work.pipe(Effect.provideContext(context), Effect.orDie);
                    }),
                }),
              ),
            ),
          );
          const service = Context.get(context, ScheduledTaskService.ScheduledTaskService);
          const settled = yield* service.subscribeList().pipe(
            Stream.filter(({ tasks }) =>
              tasks.every(
                (task) =>
                  task.nextRunAt !== null &&
                  task.nextRunAt > now &&
                  task.lastRunStatus !== "running",
              ),
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* dueWork;
          yield* Deferred.await(newsDispatched);
          yield* Fiber.join(settled);
        }),
      );

      assert.deepEqual(yield* Ref.get(launchedPrompts), [
        "Act on the poll output.\n\n- Slack: two new mentions",
      ]);
      const rows = yield* sql<{
        task_id: string;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
      }>`SELECT task_id, last_run_status, last_run_error, next_run_at, run_count FROM scheduled_tasks`;
      const byId = new Map(rows.map((row) => [row.task_id, row]));
      const quiet = byId.get("quiet");
      assert.equal(quiet?.last_run_status, "never");
      assert.equal(quiet?.run_count, 0);
      assert.isTrue((quiet?.next_run_at ?? "") > now);
      const broken = byId.get("broken");
      assert.equal(broken?.last_run_status, "failed");
      assert.equal(broken?.run_count, 1);
      assert.isTrue(broken?.last_run_error?.includes("exited 3: cannot reach slack") === true);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("an edit that omits the check command keeps it, and null removes it", () =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    const input = yield* decodeUpsertInput({
      commandId: "checked-schedule",
      title: "Triage",
      prompt: "Act on the poll output.",
      enabled: true,
      schedule: { type: "interval", everyMs: 900_000 },
      checkCommand: "bin/cos-poll",
      projectId: "project-checked",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    const created = yield* service.upsert(input);
    assert.equal(created.task.checkCommand, "bin/cos-poll");

    const { checkCommand: _omitted, ...withoutCheck } = input;
    const edited = yield* service.upsert({
      ...withoutCheck,
      id: created.task.id,
      title: "Renamed",
    });
    assert.equal(edited.task.checkCommand, "bin/cos-poll");
    assert.equal((yield* service.list()).tasks[0]?.checkCommand, "bin/cos-poll");

    const cleared = yield* service.upsert({ ...input, id: created.task.id, checkCommand: null });
    assert.isUndefined(cleared.task.checkCommand);
    assert.isUndefined((yield* service.list()).tasks[0]?.checkCommand);
  }).pipe(
    Effect.provide(
      ScheduledTaskService.layer.pipe(
        Layer.provide(NodeServices.layer),
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
        Layer.provide(SqlitePersistence.layerMemory),
      ),
    ),
  ),
);

it.effect("Run now starts the turn even when the check is quiet", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    yield* insertCheckedTask(sql, {
      id: "manual",
      next: "2026-09-10T12:00:00.000Z",
      checkCommand: "true",
    });
    yield* TestClock.setTime(Date.parse(now));
    const launchedPrompts = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* Effect.exit(service.runNow({ id: ScheduledTaskId.make("manual") }));
    }).pipe(
      Effect.provide(
        ScheduledTaskService.layer.pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.mergeAll(
              NodeCrypto.layer,
              Scheduler.layer,
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/projects",
                isScratchProject: () => Effect.succeed(false),
              }),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                launch: (input) =>
                  Ref.update(launchedPrompts, (prompts) => [
                    ...prompts,
                    input.initialMessage?.text ?? "",
                  ]).pipe(Effect.andThen(Effect.die(new Error("launch recorded")))),
              }),
              Layer.mock(ThreadManagementService.ThreadManagementService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
            ),
          ),
        ),
      ),
    );
    assert.deepEqual(yield* Ref.get(launchedPrompts), ["Act on the poll output."]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("an approval-required task fails without executing its check", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertCheckedTask(sql, {
      id: "restricted",
      next: "2026-09-09T12:00:00.000Z",
      checkCommand: "echo news",
    });
    yield* sql`UPDATE scheduled_tasks SET runtime_mode = 'approval-required' WHERE task_id = 'restricted'`;
    const result = yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* service.runNow({ id: ScheduledTaskId.make("restricted") });
    }).pipe(
      Effect.provide(
        ScheduledTaskService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              Scheduler.layer,
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/projects",
                isScratchProject: () => Effect.succeed(false),
              }),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                launch: () => Effect.die("Unexpected dispatch"),
              }),
              Layer.mock(ThreadManagementService.ThreadManagementService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make(() => Effect.die("Unexpected check execution")),
              ),
            ),
          ),
        ),
      ),
    );
    assert.equal(result.task.lastRunStatus, "failed");
    assert.include(
      result.task.lastRunError ?? "",
      "Check commands require full-access runtime mode.",
    );
    assert.equal(result.task.runCount, 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const heldCheckSpawner = (entered: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  ChildProcessSpawner.make(() =>
    Deferred.succeed(entered, undefined).pipe(
      Effect.as(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Deferred.await(release).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make("news")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );

it.effect(
  "due tasks dispatch independently while a check is held, without overlapping the held task",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      yield* TestClock.setTime(Date.parse(now));
      yield* insertCheckedTask(sql, { id: "slow", next: now, checkCommand: "check" });
      yield* insertCheckedTask(sql, {
        id: "fast",
        next: "2026-09-09T12:00:00.001Z",
        checkCommand: "check",
      });
      yield* sql`UPDATE scheduled_tasks SET schedule_json = '{"type":"interval","everyMs":60000}' WHERE task_id = 'fast'`;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fastDispatched = yield* Deferred.make<void>();
      const slowDispatched = yield* Deferred.make<void>();
      const launched = yield* Ref.make<ReadonlyArray<string>>([]);
      let dueWork = Effect.void;
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* dueWork;
        yield* Deferred.await(entered);
        yield* TestClock.adjust("1 second");
        yield* dueWork;
        yield* Deferred.await(fastDispatched);
        assert.deepEqual(yield* Ref.get(launched), ["fast"]);
        const overlap = yield* service
          .runNow({ id: ScheduledTaskId.make("slow") })
          .pipe(Effect.flip);
        assert.include(String(overlap.cause), "already running");
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(slowDispatched);
        assert.deepEqual(yield* Ref.get(launched), ["fast", "slow"]);
      }).pipe(
        Effect.provide(
          ScheduledTaskService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                NodeCrypto.layer,
                Layer.mock(Scheduler.Scheduler)({
                  register: <E, R>(_: string, work: Effect.Effect<void, E, R>) =>
                    Effect.gen(function* () {
                      const context = yield* Effect.context<R>();
                      dueWork = work.pipe(Effect.provideContext(context), Effect.orDie);
                    }),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: (input) =>
                    Ref.update(launched, (ids) => [...ids, input.title]).pipe(
                      Effect.andThen(
                        input.title === "fast"
                          ? Deferred.succeed(fastDispatched, undefined)
                          : Deferred.succeed(slowDispatched, undefined),
                      ),
                      Effect.andThen(Effect.die("launch recorded")),
                    ),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.succeed(
                  ChildProcessSpawner.ChildProcessSpawner,
                  heldCheckSpawner(entered, release),
                ),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a task paused during its check does not dispatch or record a wake", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    yield* TestClock.setTime(Date.parse(now));
    yield* insertCheckedTask(sql, { id: "paused", next: now, checkCommand: "check" });
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const run = yield* Effect.forkChild(service.runNow({ id: ScheduledTaskId.make("paused") }));
      yield* Deferred.await(entered);
      yield* service.setEnabled({ id: ScheduledTaskId.make("paused"), enabled: false });
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(run);
      assert.isFalse(result.task.enabled);
      assert.equal(result.task.lastRunStatus, "never");
      assert.equal(result.task.runCount, 0);
      assert.isNull(result.task.lastRunAt);
      const persisted = (yield* service.list()).tasks[0];
      assert.isFalse(persisted?.enabled);
      assert.equal(persisted?.runCount, 0);
    }).pipe(
      Effect.provide(
        ScheduledTaskService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/projects",
                isScratchProject: () => Effect.succeed(false),
              }),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                launch: () => Effect.die("Unexpected dispatch"),
              }),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                sendToThread: () => Effect.die("Unexpected dispatch"),
              }),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                heldCheckSpawner(entered, release),
              ),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);
