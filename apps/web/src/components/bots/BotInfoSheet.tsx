import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BotSummary, EnvironmentId, ScheduledTask, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { relativeLabel, scheduleLabel } from "../settings/ScheduledTasksSettings";
import { Button } from "../ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function BotInfoSheet(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPausedChange: () => void;
}) {
  const [pauseOverride, setPauseOverride] = useState<{ bot: BotSummary; paused: boolean } | null>(
    null,
  );
  const paused = pauseOverride?.bot === props.bot ? pauseOverride.paused : props.bot.paused;
  const navigate = useNavigate();
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.bot.homeThreadId));
  const tasksQuery = useEnvironmentQuery(
    props.open
      ? serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const detail = useEnvironmentQuery(
    props.open
      ? serverEnvironment.bots.get({
          environmentId: props.environmentId,
          input: { botId: props.bot.id },
        })
      : null,
  );
  const schedules = (tasksQuery.data?.tasks ?? []).filter((task) =>
    props.bot.scheduledTaskIds.includes(task.id),
  );

  const openThread = (threadId: ThreadId) => {
    props.onOpenChange(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: props.environmentId, threadId },
    });
  };

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>{props.bot.name}</SheetTitle>
          <SheetDescription>
            {shell?.modelSelection.model ?? "Model unknown"}
            {paused ? " · Paused" : null}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6 text-sm">
          <InfoSection title="Schedule">
            {tasksQuery.error !== null ? (
              <p className="text-destructive">Could not load schedules: {tasksQuery.error}</p>
            ) : schedules.length === 0 ? (
              <p className="text-muted-foreground">No schedule.</p>
            ) : (
              schedules.map((task) => (
                <ScheduleRow
                  key={task.id}
                  task={task}
                  environmentId={props.environmentId}
                  botPaused={paused}
                />
              ))
            )}
            {paused ? (
              <p className="text-muted-foreground">Resume the bot to change its schedules.</p>
            ) : null}
            <PauseBotButton
              bot={props.bot}
              environmentId={props.environmentId}
              paused={paused}
              onPausedUpdate={(paused) => setPauseOverride({ bot: props.bot, paused })}
              onPausedChange={props.onPausedChange}
            />
          </InfoSection>

          <InfoSection title="Charter">
            {detail.data?.charter ? (
              <ChatMarkdown
                cwd={undefined}
                environmentId={props.environmentId}
                text={detail.data?.charter}
              />
            ) : (
              <p className="text-muted-foreground">
                {detail.error ?? (detail.data === null ? "Loading…" : "No charter.md.")}
              </p>
            )}
          </InfoSection>

          <InfoSection title="Workers">
            {(detail.data?.workers.length ?? 0) === 0 ? (
              <p className="text-muted-foreground">
                {detail.error ?? (detail.data === null ? "Loading…" : "No workers yet.")}
              </p>
            ) : (
              (detail.data?.workers ?? []).toReversed().map((worker) => (
                <button
                  key={worker.threadId}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
                  onClick={() => openThread(worker.threadId)}
                >
                  <span className="min-w-0 flex-1 truncate">{worker.title}</span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {worker.status ?? "not started"}
                  </span>
                </button>
              ))
            )}
          </InfoSection>

          <Button variant="outline" onClick={() => openThread(props.bot.homeThreadId)}>
            Open raw thread
          </Button>
        </div>
      </SheetPopup>
    </Sheet>
  );
}

function InfoSection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function PauseBotButton(props: {
  readonly paused: boolean;
  readonly onPausedUpdate: (paused: boolean) => void;
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly onPausedChange: () => void;
}) {
  const setPaused = useAtomCommand(serverEnvironment.bots.setPaused, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const paused = props.paused;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    props.onPausedUpdate(!paused);
    const result = await setPaused({
      environmentId: props.environmentId,
      input: { botId: props.bot.id, paused: !paused },
    });
    setBusy(false);
    if (result._tag === "Success") props.onPausedChange();
    else props.onPausedUpdate(paused);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: paused ? "Could not resume bot" : "Could not pause bot",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <Button variant="outline" disabled={busy} onClick={() => void toggle()}>
      {paused ? "Resume bot" : "Pause bot"}
    </Button>
  );
}

function ScheduleRow(props: {
  readonly task: ScheduledTask;
  readonly environmentId: EnvironmentId;
  readonly botPaused: boolean;
}) {
  const navigate = useNavigate();
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "bot schedule toggle",
  });
  const [busy, setBusy] = useState(false);

  const toggle = async (enabled: boolean) => {
    if (busy || props.botPaused) return;
    setBusy(true);
    const result = await setEnabled({
      environmentId: props.environmentId,
      input: { id: props.task.id, enabled },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update schedule",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col text-left"
        onClick={() =>
          void navigate({
            to: "/settings/scheduled-tasks",
            search: { environmentId: props.environmentId, taskId: props.task.id },
          })
        }
      >
        <span className="truncate font-medium">{props.task.title}</span>
        <span className="truncate text-muted-foreground text-xs">
          {scheduleLabel(props.task.schedule)} · {props.task.modelSelection.model} ·{" "}
          {scheduleStatus(props.task)}
        </span>
        {props.task.lastRunStatus === "failed" || props.task.lastRunError ? (
          <span className="line-clamp-2 text-destructive text-xs">
            Last run failed: {props.task.lastRunError || "Unknown error"}
          </span>
        ) : null}
      </button>
      <Switch
        aria-label={`${props.task.enabled ? "Pause" : "Resume"} schedule ${props.task.title}`}
        checked={props.task.enabled}
        disabled={busy || props.botPaused}
        onCheckedChange={(checked) => void toggle(checked)}
      />
    </div>
  );
}

function scheduleStatus(task: ScheduledTask) {
  if (!task.enabled) return "paused";
  if (!task.checkCommand) return `next ${relativeLabel(task.nextRunAt)}`;
  if (!task.lastRunAt) return "checks first, never woke";
  return `checks first, last woke ${relativeLabel(task.lastRunAt)}`;
}
