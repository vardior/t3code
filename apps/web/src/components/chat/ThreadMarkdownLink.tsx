import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useEnvironmentIds } from "../../state/environments";

export function ThreadMarkdownLink(props: {
  readonly target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  readonly children: ReactNode;
}) {
  const knownEnvironmentIds = useEnvironmentIds();
  if (!knownEnvironmentIds.includes(props.target.environmentId)) {
    return <span>{props.children}</span>;
  }
  return (
    <Link to="/$environmentId/$threadId" params={props.target}>
      {props.children}
    </Link>
  );
}
