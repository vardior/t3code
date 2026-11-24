import type { ScopedThreadRef } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useGT } from "gt-react";
import { ExternalLinkIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { changeRequestTermKind } from "./changeRequestTerm";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";

export function PullRequestNumberLink({
  detail,
  threadRef,
  className,
  openOnHostText,
  showIcon,
}: {
  detail: { readonly url: string; readonly provider: string; readonly number: number };
  threadRef?: ScopedThreadRef | null;
  className: string;
  openOnHostText?: string;
  showIcon?: boolean;
}) {
  const gt = useGT();
  const openLink = useOpenLink(threadRef);
  const host = sourceControlClients.get(detail.provider);
  const openLabel = openOnHostText ?? openOnHostLabel(host);
  const open = (event: MouseEvent) => {
    event.stopPropagation();
    void openLink(detail.url, { event }).catch(console.error);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={open}
            onAuxClick={(event) => {
              if (event.button === 1) open(event);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void showPullRequestLinkContextMenu({
                url: detail.url,
                openLabel,
                position: { x: event.clientX, y: event.clientY },
                source: contextMenuSourceOf(event),
              });
            }}
            className={cn("shrink-0 cursor-pointer underline-offset-2 hover:underline", className)}
            aria-label={gt(
              "Open {term, select, mr {merge request} cr {change request} other {pull request}} #{number} on host",
              { term: changeRequestTermKind(host.changeRequest), number: detail.number },
            )}
          >
            #{detail.number}
            {showIcon ? <ExternalLinkIcon aria-hidden className="size-2.5" /> : null}
          </button>
        }
      />
      <TooltipPopup side="top">{openLabel}</TooltipPopup>
    </Tooltip>
  );
}
