import {
  parseThreadLink,
  rewriteThreadLinks,
} from "@t3tools/client-runtime/state/bot-conversation";

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

export const BOT_THREAD_LINK_ORIGIN = "https://t3.invalid";

export function botThreadLinkTarget(href: string, knownEnvironmentIds: ReadonlyArray<string>) {
  const target = parseThreadLink(href, BOT_THREAD_LINK_ORIGIN);
  return target && knownEnvironmentIds.includes(target.environmentId) ? target : null;
}

export function botMarkdownThreadLinks(
  markdown: string,
  knownEnvironmentIds: ReadonlyArray<string>,
) {
  return rewriteThreadLinks(markdown, BOT_THREAD_LINK_ORIGIN).replace(
    /\[([^\]]+)\]\(((?:t3-thread:\/\/|https:\/\/t3\.invalid\/)[^\s)]+)\)/g,
    (link, label: string, href: string) =>
      botThreadLinkTarget(href, knownEnvironmentIds) ? link : label,
  );
}
