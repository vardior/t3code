import type { RunId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import type { TimelineEntry } from "../session-logic";

export interface ChatViewPresentation {
  readonly header: ReactNode;
  readonly timelineEntries: (entries: ReadonlyArray<TimelineEntry>) => ReadonlyArray<TimelineEntry>;
  readonly workingLabel: string | null;
  readonly queuedRunIds: ReadonlySet<RunId>;
}
