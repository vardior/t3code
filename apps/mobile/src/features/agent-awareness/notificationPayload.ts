import type { BotSummary } from "@t3tools/contracts";

type NotificationBot = Pick<BotSummary, "id" | "homeThreadId">;
type BotsForEnvironment = (environmentId: string) => ReadonlyArray<NotificationBot> | null;

function dataFromNotificationResponse(response: unknown): Record<string, unknown> | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const notification = (response as { readonly notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return null;
  }
  const request = (notification as { readonly request?: unknown }).request;
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const content = (request as { readonly content?: unknown }).content;
  if (typeof content !== "object" || content === null) {
    return null;
  }
  const data = (content as { readonly data?: unknown }).data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

function identifierFromNotificationResponse(response: unknown): string | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const notification = (response as { readonly notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return null;
  }
  const request = (notification as { readonly request?: unknown }).request;
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const identifier = (request as { readonly identifier?: unknown }).identifier;
  return typeof identifier === "string" ? identifier : null;
}

function encodeThreadDeepLink(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): string | null {
  if (input.environmentId.length === 0 || input.threadId.length === 0) {
    return null;
  }
  try {
    return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
  } catch {
    return null;
  }
}

function normalizeThreadDeepLink(value: string): string | null {
  if (
    value.trim() !== value ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }

  const parts = value.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "threads") {
    return null;
  }

  try {
    return encodeThreadDeepLink({
      environmentId: decodeURIComponent(parts[2] ?? ""),
      threadId: decodeURIComponent(parts[3] ?? ""),
    });
  } catch {
    return null;
  }
}

export function botRouteOnScreen(pathname: string) {
  const match = /^\/bots\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  try {
    return {
      environmentId: decodeURIComponent(match[1]),
      botId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

/**
 * The deep link a notification would have to carry to target the thread the
 * given route is showing, including its nested screens such as the file
 * inspector. Null when the route is not inside a thread or a known bot chat.
 */
export function threadDeepLinkOnScreen(
  pathname: string,
  bots?: ReadonlyArray<NotificationBot> | null,
): string | null {
  const botRoute = botRouteOnScreen(pathname);
  if (botRoute) {
    const bot = bots?.find((entry) => entry.id === botRoute.botId);
    return bot
      ? encodeThreadDeepLink({ environmentId: botRoute.environmentId, threadId: bot.homeThreadId })
      : null;
  }
  const match = /^\/threads\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return `/threads/${match[1]}/${match[2]}`;
}

export function agentNotificationRouteForBots(
  deepLink: string,
  botsForEnvironment: BotsForEnvironment,
): string {
  const normalized = normalizeThreadDeepLink(deepLink);
  if (normalized === null) return deepLink;
  const parts = normalized.split("/");
  const environmentId = decodeURIComponent(parts[2] ?? "");
  const threadId = decodeURIComponent(parts[3] ?? "");
  const bot = botsForEnvironment(environmentId)?.find((entry) => entry.homeThreadId === threadId);
  return bot
    ? `/bots/${encodeURIComponent(environmentId)}/${encodeURIComponent(bot.id)}`
    : deepLink;
}

export function agentNotificationUrlForBots(
  url: string,
  botsForEnvironment: BotsForEnvironment,
): string {
  const match = /^(t3code(?:-dev|-preview)?:\/{1,2})(threads\/.*)$/.exec(url);
  if (!match?.[1] || !match[2]) return url;
  const deepLink = `/${match[2]}`;
  const route = agentNotificationRouteForBots(deepLink, botsForEnvironment);
  return route === deepLink ? url : `${match[1]}${route.slice(1)}`;
}

export function extractAgentNotificationDeepLink(response: unknown): string | null {
  const data = dataFromNotificationResponse(response);
  const deepLink = data?.deepLink;
  if (typeof deepLink === "string") {
    const normalizedDeepLink = normalizeThreadDeepLink(deepLink);
    if (normalizedDeepLink) {
      return normalizedDeepLink;
    }
  }

  const environmentId = data?.environmentId;
  const threadId = data?.threadId;
  if (typeof environmentId === "string" && typeof threadId === "string") {
    return encodeThreadDeepLink({ environmentId, threadId });
  }
  return null;
}

export function routeAgentNotificationResponseOnce(input: {
  readonly handledResponseIds: Set<string>;
  readonly response: unknown;
  readonly navigate: (deepLink: string) => void;
  readonly botsForEnvironment?: BotsForEnvironment;
}): void {
  const responseId = identifierFromNotificationResponse(input.response);
  if (responseId && input.handledResponseIds.has(responseId)) {
    return;
  }
  const deepLink = extractAgentNotificationDeepLink(input.response);
  if (deepLink) {
    input.navigate(
      input.botsForEnvironment
        ? agentNotificationRouteForBots(deepLink, input.botsForEnvironment)
        : deepLink,
    );
  }
  if (responseId) {
    input.handledResponseIds.add(responseId);
  }
}
