import { botFindingDecisionMessage, type BotMorningFinding } from "@t3tools/contracts";
import * as Hash from "effect/Hash";

export const AWAY_THRESHOLD_MS = 6 * 60 * 60 * 1000;
export const MIN_FINDINGS_WINDOW_MS = 24 * 60 * 60 * 1000;

export const FINDING_DECISION_PREFIXES = (["accept", "skip"] as const).map((decision) =>
  botFindingDecisionMessage({ what: "", fix: "" }, decision),
);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;
const FINDING_KINDS = new Set<string>(["pattern", "proposal"]);

const isFindingKind = (kind: string): kind is BotMorningFinding["kind"] => FINDING_KINDS.has(kind);

const latestMomentOf = (date: string) =>
  DAY.test(date)
    ? Date.parse(`${date}T23:59:59.999Z`)
    : TIMESTAMP.test(date)
      ? Date.parse(date)
      : NaN;

export const findingsWindowStart = (awaySinceMs: number, nowMs: number) =>
  Math.min(awaySinceMs, nowMs - MIN_FINDINGS_WINDOW_MS);

export const parseBotFindings = (text: string, sinceMs: number) =>
  text.split("\n").flatMap((raw) => {
    const line = raw.trim();
    const [date = "", botId = "", kind = "", what = "", ...fix] = line
      .split("|")
      .map((field) => field.trim());
    if (fix.length === 0 || !botId || !what || !isFindingKind(kind)) return [];
    const at = latestMomentOf(date);
    if (!Number.isFinite(at) || at < sinceMs) return [];
    return [
      {
        id: (Hash.string(line) >>> 0).toString(36),
        botId,
        kind,
        what,
        fix: fix.join(" | "),
      },
    ];
  });
