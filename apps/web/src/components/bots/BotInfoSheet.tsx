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
}) {
  const navigate = useNavigate();
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.bot.homeThreadId));
  const tasksQuery = useEnvironmentQuery(
    props.open
      ? serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} })
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
          <SheetDescription>{shell?.modelSelection.model ?? "Model unknown"}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6 text-sm">
          <InfoSection title="Schedule">
            {tasksQuery.error !== null ? (
              <p className="text-destructive">Could not load schedules: {tasksQuery.error}</p>
            ) : schedules.length === 0 ? (
              <p className="text-muted-foreground">No schedule.</p>
            ) : (
              schedules.map((task) => (
                <ScheduleRow key={task.id} task={task} environmentId={props.environmentId} />
              ))
            )}
          </InfoSection>

          <InfoSection title="Charter">
            {props.bot.charter ? (
              <ChatMarkdown
                cwd={undefined}
                environmentId={props.environmentId}
                text={props.bot.charter}
              />
            ) : (
              <p className="text-muted-foreground">No charter.md.</p>
            )}
          </InfoSection>

          <InfoSection title="Workers">
            {props.bot.workers.length === 0 ? (
              <p className="text-muted-foreground">No workers yet.</p>
            ) : (
              props.bot.workers.toReversed().map((worker) => (
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

function ScheduleRow(props: {
  readonly task: ScheduledTask;
  readonly environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "bot schedule toggle",
  });
  const [busy, setBusy] = useState(false);

  const toggle = async (enabled: boolean) => {
    if (busy) return;
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
          {props.task.checkCommand
            ? `checks ${scheduleLabel(props.task.schedule).replace(/^Every /, "every ")} · ${props.task.lastRunAt ? `last woke ${relativeLabel(props.task.lastRunAt)}` : "never woke"}`
            : `${scheduleLabel(props.task.schedule)} · ${props.task.modelSelection.model} · ${props.task.enabled ? `next ${relativeLabel(props.task.nextRunAt)}` : "paused"}`}
        </span>
      </button>
      <Switch
        aria-label={props.task.enabled ? "Pause schedule" : "Resume schedule"}
        checked={props.task.enabled}
        disabled={busy}
        onCheckedChange={(checked) => void toggle(checked)}
      />
    </div>
  );
}
