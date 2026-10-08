import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { OpenItemError, type OpenItem } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { encodeThreadDeepLink } from "./notificationPayload";

const MAX_ANSWER_ACTIONS = 3;
const ANSWER_ACTION_PREFIX = "open-item-answer:";

export type NotifiedShell = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "title" | "archivedAt" | "openItems"
>;

export interface OpenItemNotificationTarget {
  readonly environmentId: string;
  readonly threadId: string;
  readonly itemId: string;
}

export const OpenItemNotificationData = Schema.Struct({
  kind: Schema.Literals(["open-item", "open-item-result", "open-item-retry"]),
  environmentId: Schema.String,
  threadId: Schema.String,
  itemId: Schema.String,
  title: Schema.String,
  choices: Schema.Array(Schema.String),
  deepLink: Schema.String,
  answer: Schema.optional(Schema.String),
});
export type OpenItemNotificationData = typeof OpenItemNotificationData.Type;

const decodeNotificationData = Schema.decodeUnknownOption(OpenItemNotificationData);
const isOpenItemError = Schema.is(OpenItemError);

export function openItemNotificationId(target: OpenItemNotificationTarget): string {
  return `open-item:${target.environmentId}:${target.itemId}`;
}

export function openItemAnswerChoices(
  item: Pick<OpenItem, "options" | "recommended">,
): ReadonlyArray<string> {
  const options = item.options ?? [];
  const recommended = options.filter((option) => option === item.recommended);
  return [...recommended, ...options.filter((option) => option !== item.recommended)].slice(
    0,
    MAX_ANSWER_ACTIONS,
  );
}

export function openItemAnswerActionId(index: number): string {
  return `${ANSWER_ACTION_PREFIX}${index}`;
}

export function openItemNotificationData(
  shell: NotifiedShell,
  item: OpenItem,
  choices: ReadonlyArray<string>,
): OpenItemNotificationData {
  return {
    kind: "open-item",
    environmentId: shell.environmentId,
    threadId: shell.id,
    itemId: item.id,
    title: item.title,
    choices: [...choices],
    deepLink:
      encodeThreadDeepLink({ environmentId: shell.environmentId, threadId: shell.id }) ?? "/",
  };
}

export function readOpenItemNotificationData(data: unknown): OpenItemNotificationData | null {
  return Option.getOrNull(decodeNotificationData(data));
}

export function openItemAnswerForAction(
  data: OpenItemNotificationData,
  actionIdentifier: string,
): string | null {
  if (!actionIdentifier.startsWith(ANSWER_ACTION_PREFIX)) return null;
  const index = Number(actionIdentifier.slice(ANSWER_ACTION_PREFIX.length));
  return Number.isInteger(index) ? (data.choices[index] ?? null) : null;
}

export function openItemNotificationVersion(shell: NotifiedShell, item: OpenItem): string {
  return `${shell.environmentId}:${item.id}:${item.updatedAt}`;
}

export interface OpenItemNotificationPlan {
  readonly post: ReadonlyArray<{ readonly shell: NotifiedShell; readonly item: OpenItem }>;
  readonly clear: ReadonlyArray<string>;
  readonly unmarkedEnvironments: ReadonlyArray<string>;
}

export function planOpenItemNotifications(input: {
  readonly shells: ReadonlyArray<NotifiedShell>;
  readonly since: Readonly<Record<string, string>>;
  readonly posted: ReadonlySet<string>;
  readonly shown: ReadonlyMap<string, OpenItemNotificationTarget>;
  readonly notifies: (shell: NotifiedShell) => boolean;
}): OpenItemNotificationPlan {
  const post: Array<{ readonly shell: NotifiedShell; readonly item: OpenItem }> = [];
  const unmarked = new Set<string>();
  const shellsByEnvironment = new Map<string, Map<string, NotifiedShell>>();
  for (const shell of input.shells) {
    const environmentShells = shellsByEnvironment.get(shell.environmentId) ?? new Map();
    environmentShells.set(shell.id, shell);
    shellsByEnvironment.set(shell.environmentId, environmentShells);
    const since = input.since[shell.environmentId];
    if (since === undefined) {
      unmarked.add(shell.environmentId);
      continue;
    }
    if (shell.archivedAt !== null || !input.notifies(shell)) continue;
    for (const item of shell.openItems) {
      if (
        item.status === "open" &&
        item.updatedAt > since &&
        !input.posted.has(openItemNotificationVersion(shell, item))
      ) {
        post.push({ shell, item });
      }
    }
  }
  const clear: Array<string> = [];
  for (const [notificationId, target] of input.shown) {
    const environmentShells = shellsByEnvironment.get(target.environmentId);
    if (environmentShells === undefined) continue;
    const shell = environmentShells.get(target.threadId);
    const item = shell?.openItems.find((candidate) => candidate.id === target.itemId);
    if (shell === undefined || shell.archivedAt !== null || item?.status !== "open") {
      clear.push(notificationId);
    }
  }
  return { post, clear, unmarkedEnvironments: [...unmarked] };
}

export type OpenItemAnswerOutcome =
  | { readonly type: "answered"; readonly answer: string }
  | {
      readonly type: "already-resolved";
      readonly status: OpenItem["status"] | null;
      readonly answer: string | null;
    }
  | { readonly type: "gone" }
  | { readonly type: "failed"; readonly message: string };

function alreadyResolvedTitle(
  outcome: Extract<OpenItemAnswerOutcome, { readonly type: "already-resolved" }>,
): string {
  if (outcome.status === "dropped") return "Already dropped";
  if (outcome.answer) return `Already answered: ${outcome.answer}`;
  return "Already answered";
}

function alreadyResolved(current: OpenItem | undefined): OpenItemAnswerOutcome {
  return {
    type: "already-resolved",
    status: current === undefined || current.status === "open" ? null : current.status,
    answer: current?.answer ?? null,
  };
}

export function openItemAnswerPrecheck(
  current: OpenItem | undefined,
): OpenItemAnswerOutcome | null {
  return current !== undefined && current.status !== "open" ? alreadyResolved(current) : null;
}

export function openItemAnswerOutcome(input: {
  readonly answer: string;
  readonly result:
    | { readonly _tag: "Success"; readonly value: OpenItem }
    | { readonly _tag: "Failure"; readonly error: unknown };
  readonly current: OpenItem | undefined;
}): OpenItemAnswerOutcome {
  if (input.result._tag === "Success") {
    return { type: "answered", answer: input.result.value.answer ?? input.answer };
  }
  const error = input.result.error;
  if (isOpenItemError(error)) {
    if (error.reason === "not_open") return alreadyResolved(input.current);
    if (error.reason === "not_found" || error.reason === "thread_unavailable") {
      return { type: "gone" };
    }
  }
  return {
    type: "failed",
    message: error instanceof Error && error.message ? error.message : "Something went wrong.",
  };
}

export interface OpenItemOutcomeContent {
  readonly title: string;
  readonly body: string;
  readonly data: OpenItemNotificationData;
}

export function openItemOutcomeContent(
  data: OpenItemNotificationData,
  answer: string,
  outcome: OpenItemAnswerOutcome,
): OpenItemOutcomeContent {
  const result = { ...data, kind: "open-item-result" as const, choices: [] };
  switch (outcome.type) {
    case "answered":
      return { title: `Answered: ${outcome.answer}`, body: data.title, data: result };
    case "already-resolved":
      return { title: alreadyResolvedTitle(outcome), body: data.title, data: result };
    case "gone":
      return { title: "This open item no longer exists", body: data.title, data: result };
    case "failed":
      return {
        title: `Couldn't answer: ${answer}`,
        body: `${outcome.message} Tap to open the app and try again.`,
        data: { ...data, kind: "open-item-retry", choices: [], answer },
      };
  }
}
