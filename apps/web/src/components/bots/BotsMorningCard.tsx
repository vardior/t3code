import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  answerBotMorningFinding,
  BotMorningMemory,
  botMorningLine,
  dismissBotMorning,
  EMPTY_BOT_MORNING_MEMORY,
  type BotMorningDecision,
} from "@t3tools/client-runtime/state/bot-conversation";
import {
  AuthOrchestrationOperateScope,
  botFindingDecisionMessage,
  type BotMorningFinding,
  type BotSummary,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { newMessageId } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { useBotsData } from "./BotsDataProvider";

const STORAGE_KEY = "t3code:bot-morning";

export function BotsMorningCards() {
  const { queries } = useBotsData();
  const { environments } = useEnvironments();
  const [memory, setMemory] = useLocalStorage(
    STORAGE_KEY,
    EMPTY_BOT_MORNING_MEMORY,
    BotMorningMemory,
  );
  const supported = queries.filter((query) => query.supported);
  return supported.map((query) => (
    <BotsMorningCard
      key={query.environmentId}
      environmentId={query.environmentId}
      environmentLabel={
        supported.length > 1
          ? environments.find((environment) => environment.environmentId === query.environmentId)
              ?.label
          : undefined
      }
      bots={query.data?.bots ?? []}
      memory={memory}
      onDismiss={(key) => setMemory((current) => dismissBotMorning(current, key))}
      onAnswer={(key, decision) =>
        setMemory((current) => answerBotMorningFinding(current, key, decision))
      }
    />
  ));
}

function BotsMorningCard(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | undefined;
  readonly bots: ReadonlyArray<BotSummary>;
  readonly memory: BotMorningMemory;
  readonly onDismiss: (key: string) => void;
  readonly onAnswer: (key: string, decision: BotMorningDecision | null) => void;
}) {
  const { environmentId } = props;
  const morningAtom = serverEnvironment.bots.morning(environmentId);
  const result = useAtomValue(morningAtom);
  const navigate = useNavigate();
  useEffect(() => {
    const refresh = () => appAtomRegistry.refresh(morningAtom);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [morningAtom]);
  const bots = useMemo(() => new Map(props.bots.map((bot) => [bot.id, bot])), [props.bots]);
  const morning = result._tag === "Success" ? result.value : null;
  if (morning === null) return null;
  const dismissKey = `${environmentId}:${morning.awaySince}`;
  if (props.memory.dismissed.includes(dismissKey)) return null;
  return (
    <section
      aria-label="While you were away"
      className="w-full max-w-lg rounded-xl border border-border/70 bg-card/60 p-4 text-sm"
    >
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-medium text-muted-foreground">
          While you were away{props.environmentLabel ? ` · ${props.environmentLabel}` : ""}
        </h2>
        <Button variant="ghost-muted" size="xs" onClick={() => props.onDismiss(dismissKey)}>
          Dismiss
        </Button>
      </div>
      <ul className="mt-2 flex flex-col">
        {morning.bots.map((bot) => (
          <li key={bot.botId}>
            <button
              type="button"
              className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent/50"
              onClick={() =>
                void navigate({ to: "/bots", search: { env: environmentId, bot: bot.botId } })
              }
            >
              <span className="block truncate font-medium text-foreground">{bot.name}</span>
              <span className="line-clamp-2 text-muted-foreground">{botMorningLine(bot)}</span>
            </button>
          </li>
        ))}
      </ul>
      {morning.findings.map((finding) => (
        <BotsMorningFinding
          key={finding.id}
          environmentId={environmentId}
          finding={finding}
          bot={bots.get(finding.botId)}
          answer={props.memory.answered[`${environmentId}:${finding.id}`]}
          onAnswer={(decision) => props.onAnswer(`${environmentId}:${finding.id}`, decision)}
        />
      ))}
    </section>
  );
}

function BotsMorningFinding(props: {
  readonly environmentId: EnvironmentId;
  readonly finding: BotMorningFinding;
  readonly bot: BotSummary | undefined;
  readonly answer: BotMorningDecision | undefined;
  readonly onAnswer: (decision: BotMorningDecision | null) => void;
}) {
  const { environmentId, finding, bot, onAnswer } = props;
  const shell = useThreadShell(
    bot === undefined ? null : scopeThreadRef(environmentId, bot.homeThreadId),
  );
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn);
  const canDecide =
    useEnvironmentScope(environmentId, AuthOrchestrationOperateScope) && shell !== null;
  const decide = async (decision: BotMorningDecision) => {
    if (!canDecide) return;
    onAnswer(decision);
    const sent = await startThreadTurn({
      environmentId,
      input: {
        threadId: shell.id,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: botFindingDecisionMessage(finding, decision),
          attachments: [],
        },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        dispatchMode: "queue",
      },
    });
    if (sent._tag === "Failure") onAnswer(null);
  };
  return (
    <div className="mt-3 border-t border-border/70 pt-3">
      <p className="text-xs text-muted-foreground">
        {bot?.name ?? finding.botId} · {finding.kind}
      </p>
      <p className="text-foreground">{finding.what}</p>
      {finding.fix ? <p className="text-xs text-muted-foreground">{finding.fix}</p> : null}
      {props.answer !== undefined ? (
        <p className="mt-2 text-muted-foreground">
          {props.answer === "accept" ? "Going ahead" : "Skipped"}
        </p>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button size="sm" disabled={!canDecide} onClick={() => void decide("accept")}>
            Do it
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canDecide}
            onClick={() => void decide("skip")}
          >
            Skip
          </Button>
        </div>
      )}
    </div>
  );
}
