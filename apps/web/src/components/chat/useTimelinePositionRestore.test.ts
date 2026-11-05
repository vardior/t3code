import type { LegendListRef } from "@legendapp/list/react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  navigationReleasesFollow,
  type TimelineNavigation,
  type TimelineViewport,
} from "./timelineViewport";
import {
  measuredEndOffset,
  settleListScroll,
  startTimelinePositionRestore,
} from "./useTimelinePositionRestore";

describe("settleListScroll", () => {
  it("hands off when a streaming reply keeps moving the end", async () => {
    vi.useFakeTimers();
    // The node test environment has no animation frames; fake ones run on the fake clock.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 16),
    );
    // Every correction lands, then the reply grows before the next frame.
    const element = { scrollTop: 0, scrollHeight: 5_000, clientHeight: 800 };
    const list = {
      getScrollableNode: () => element as unknown as HTMLElement,
      scrollToOffset: async ({ offset }: { offset: number }) => {
        element.scrollTop = offset;
        element.scrollHeight += 40;
      },
    };

    let settled = false;
    void settleListScroll(list, measuredEndOffset, () => false).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    vi.unstubAllGlobals();

    expect(settled).toBe(true);
  });
});

describe("startTimelinePositionRestore", () => {
  const previousThreadHeight = 748;
  const returningThreadHeight = 9_797;
  const viewportHeight = 748;
  const estimatedEndOffset = 3_152;
  const realEndOffset = returningThreadHeight - viewportHeight;

  function restoreUnmeasuredThreadToEnd() {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 16),
    );
    const element = {
      scrollTop: 0,
      scrollHeight: previousThreadHeight,
      clientHeight: viewportHeight,
    };
    setTimeout(() => {
      element.scrollHeight = returningThreadHeight;
    }, 4);
    const list = {
      getScrollableNode: () => element as unknown as HTMLElement,
      getState: () => ({ data: [{ id: "row-1" }] }),
      scrollToEnd: async () => {
        element.scrollTop = estimatedEndOffset;
      },
      scrollToOffset: async ({ offset }: { offset: number }) => {
        element.scrollTop = Math.min(offset, element.scrollHeight - element.clientHeight);
      },
    } as unknown as LegendListRef;
    const listeners = new Set<(navigation: TimelineNavigation) => void>();
    let endHolds = 0;
    const viewport: TimelineViewport = {
      scrollNode: element as unknown as HTMLElement,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      navigate: ({ releasesFollow }) => {
        for (const listener of listeners) listener({ source: "command", releasesFollow });
      },
      holdProgrammaticScroll: () => () => {},
      holdRestoreToEnd: () => {
        endHolds += 1;
        return () => {
          endHolds -= 1;
        };
      },
      restoringToEnd: () => endHolds > 0,
      followReleased: () => {},
      onFollowReleased: () => () => {},
    };
    const follow = { released: false };
    viewport.subscribe((navigation) => {
      const releases = navigationReleasesFollow(navigation, {
        contentScrollsUp: () => true,
        awayFromEnd: () => element.scrollHeight - element.clientHeight - element.scrollTop > 40,
        restoringToEnd: viewport.restoringToEnd,
      });
      if (releases) follow.released = true;
    });
    startTimelinePositionRestore({
      list,
      viewport,
      listIdentityKey: "thread-a",
      listOpenedOn: null,
      rememberedPosition: undefined,
      citationPending: false,
      releaseForFind: false,
      onPositioned: () => {},
    });
    const userInputBeforeFirstCorrection = async (navigation: TimelineNavigation) => {
      await vi.advanceTimersByTimeAsync(8);
      for (const listener of listeners) listener(navigation);
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    };
    return { element, follow, userInputBeforeFirstCorrection };
  }

  it("keeps following to the real end when the user clicks a returning thread that is still at its size estimate", async () => {
    const { element, follow, userInputBeforeFirstCorrection } = restoreUnmeasuredThreadToEnd();
    await userInputBeforeFirstCorrection({ source: "pointer", onScrollbar: false });

    expect(follow.released).toBe(false);
    expect(element.scrollTop).toBe(realEndOffset);
  });

  it("lets an upward wheel during the restore read history from where it is", async () => {
    const { element, follow, userInputBeforeFirstCorrection } = restoreUnmeasuredThreadToEnd();
    await userInputBeforeFirstCorrection({ source: "wheel", direction: "up" });

    expect(follow.released).toBe(true);
    expect(element.scrollTop).toBe(estimatedEndOffset);
  });
});
