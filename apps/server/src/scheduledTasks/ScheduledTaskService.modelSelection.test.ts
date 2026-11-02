import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";

const decodeUpsert = Schema.decodeEffect(ScheduledTaskUpsertInput);

const storedSelection = Schema.decodeSync(ModelSelection)({
  instanceId: "codex",
  model: "gpt-5",
  options: [{ id: "reasoningEffort", value: "low" }],
});
const ownerSelection = Schema.decodeSync(ModelSelection)({
  instanceId: "codex-owner",
  model: "gpt-5.4",
  options: [{ id: "reasoningEffort", value: "high" }],
});
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
  { name: "scheduled-task-model-selection" },
  ProviderAdapterRegistry.layerFromAdapters(
    ["codex", "codex-owner"].map((id) => ({
      instanceId: ProviderInstanceId.make(id),
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("Provider execution is outside this dispatch test"),
    })),
  ),
  { databaseLayer: layerDatabase, runEffectWorker: false },
);

it.effect(
  "bound wakes persist the thread's current selection and unbound wakes retain the schedule selection",
  () =>
    Effect.gen(function* () {
      const launches: ThreadLaunchService.ThreadLaunchInput[] = [];
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Scheduler.layer,
        ThreadManagementService.layer.pipe(
          Layer.provide(layerOrchestrator),
          Layer.provide(
            ServerSettings.layerTest({
              providerInstances: {
                [ProviderInstanceId.make("codex")]: { driver: "codex", enabled: true },
                [ProviderInstanceId.make("codex-owner")]: { driver: "codex", enabled: true },
              },
            }),
          ),
          Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
        ),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            orchestrator.getThreadProjection(ThreadId.make("home")).pipe(
              Effect.orDie,
              Effect.map((projection) => {
                launches.push(input);
                return { threadId: ThreadId.make("unbound"), projection, resumed: false };
              }),
            ),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const threadId = ThreadId.make("home");
        const projectId = ProjectId.make("project:scheduled-model");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-home"),
          threadId,
          projectId,
          title: "Bot",
          modelSelection: storedSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const input = yield* decodeUpsert({
          title: "Wake",
          prompt: "Check your tasks",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId,
          threadId,
          modelSelection: storedSelection,
          workspaceStrategy: { type: "root" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        const bound = (yield* service.upsert(input)).task;
        for (const [expectedStatus, selection] of [
          ["starting", ownerSelection],
          [
            "queued",
            {
              ...ownerSelection,
              model: "gpt-5.5",
              options: [{ id: "reasoningEffort", value: "medium" }],
            },
          ],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`owner-model:${expectedStatus}`),
            threadId,
            modelSelection: selection,
          });
          yield* TestClock.adjust(1);
          const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
          const completed = (yield* service.runNow({ id: bound.id })).task;
          assert.equal(completed.lastRunStatus, "succeeded");
          const stored = yield* orchestrator
            .streamStoredEventsFrom({ threadId, afterSequence, eventType: "run.created" })
            .pipe(Stream.take(1), Stream.runCollect);
          const event = stored[0]?.event;
          assert.ok(event?.type === "run.created");
          assert.deepEqual(event.payload.modelSelection, selection);
          assert.equal(event.payload.status, expectedStatus);
          assert.deepEqual(
            (yield* orchestrator.getThreadProjection(threadId)).thread.modelSelection,
            selection,
          );
        }
        assert.equal(
          (yield* service.list()).tasks.find((task) => task.id === bound.id)?.runCount,
          2,
        );
        const unbound = (yield* service.upsert({ ...input, threadId: null })).task;
        assert.equal((yield* service.runNow({ id: unbound.id })).task.lastRunStatus, "succeeded");
        assert.deepEqual(launches[0]?.modelSelection, storedSelection);
        assert.deepEqual(launches[0]?.workspaceStrategy, input.workspaceStrategy);
      }).pipe(
        Effect.provide(
          ScheduledTaskService.layer.pipe(
            Layer.provide(ManagedPolicy.layerTest()),
            Layer.provide(dependencies),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDatabase, layerOrchestrator))),
);
