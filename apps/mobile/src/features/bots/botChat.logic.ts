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
  readonly text: string;
  readonly pendingRequestId: string | null;
  readonly error: string | null;
};

export function initialBotComposer(scope: string): BotComposerState {
  return { scope, text: "", pendingRequestId: null, error: null };
}

type BotComposerAction =
  | { readonly type: "edit"; readonly text: string }
  | { readonly type: "send"; readonly requestId: string; readonly attachmentCount?: number }
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
    return state.pendingRequestId === null ? { ...state, text: action.text, error: null } : state;
  }
  if (action.type === "send") {
    if (state.pendingRequestId !== null || (!state.text.trim() && !action.attachmentCount))
      return state;
    return { ...state, pendingRequestId: action.requestId, error: null };
  }
  if (action.scope !== state.scope || action.requestId !== state.pendingRequestId) return state;
  return {
    ...state,
    text: action.success ? "" : state.text,
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
