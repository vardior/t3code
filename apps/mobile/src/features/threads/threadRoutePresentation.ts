import type { ReactNode } from "react";

import type { ThreadFeedEntry } from "../../lib/threadActivity";

export interface ThreadRoutePresentation {
  readonly header: ReactNode;
  readonly feed: (entries: ReadonlyArray<ThreadFeedEntry>) => ReadonlyArray<ThreadFeedEntry>;
  readonly workingLabel: string | null;
}
