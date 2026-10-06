import { EnvironmentId, ThreadId } from "@t3tools/contracts";

export function botStatusLabel(
  status: {
    readonly working: boolean;
    readonly paused: boolean;
    readonly lastActivity: string | null;
  },
  now = Date.now(),
) {
  if (status.working) return "Working…";
  if (status.paused) return "Paused";
  if (!status.lastActivity) return "Idle";
  const at = Date.parse(status.lastActivity);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1_440)}d ago`;
}

type BotComposerState = {
  readonly scope: string;
  readonly pendingRequestId: string | null;
  readonly error: string | null;
};

export function initialBotComposer(scope: string): BotComposerState {
  return { scope, pendingRequestId: null, error: null };
}

type BotComposerAction =
  | { readonly type: "edit" }
  | { readonly type: "send"; readonly requestId: string; readonly hasContent: boolean }
  | {
      readonly type: "settled";
      readonly scope: string;
      readonly requestId: string;
      readonly success: boolean;
      readonly error: string | null;
    };

export function botComposerReducer(
  state: ReturnType<typeof initialBotComposer>,
  action: BotComposerAction,
) {
  if (action.type === "edit") {
    return { ...state, error: null };
  }
  if (action.type === "send") {
    if (state.pendingRequestId !== null || !action.hasContent) return state;
    return { ...state, pendingRequestId: action.requestId, error: null };
  }
  if (action.scope !== state.scope || action.requestId !== state.pendingRequestId) return state;
  return {
    ...state,
    pendingRequestId: null,
    error: action.error,
  };
}

export function botChatScrollReducer(
  followingEnd: boolean,
  action: { readonly type: "disclosure"; readonly atEnd: boolean } | { readonly type: "drag" },
) {
  return action.type === "drag" ? false : followingEnd || action.atEnd;
}

export function botThreadLinkTarget(href: string, knownEnvironmentIds: ReadonlyArray<string>) {
  try {
    const url = new URL(href);
    if (url.origin !== "https://t3.invalid") return null;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length !== 2 || !knownEnvironmentIds.includes(parts[0]!)) return null;
    return { environmentId: EnvironmentId.make(parts[0]!), threadId: ThreadId.make(parts[1]!) };
  } catch {
    return null;
  }
}

export function botMarkdownThreadLinks(
  markdown: string,
  knownEnvironmentIds: ReadonlyArray<string>,
) {
  return markdown.replace(
    /\[([^\]]+)\]\((https:\/\/t3\.invalid\/[^\s)]+)\)/g,
    (link, label: string, href: string) =>
      botThreadLinkTarget(href, knownEnvironmentIds) ? link : label,
  );
}
