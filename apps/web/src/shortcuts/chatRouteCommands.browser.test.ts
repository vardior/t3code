import { isMacPlatform } from "@t3tools/shared/keybindings";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { openCommandPalette } from "../commandPaletteBus";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { installChatRouteCommands } from "./chatRouteCommands";

vi.mock("../commandPaletteBus", { spy: true });

type Match = { readonly routeId: string; readonly pathname: string };

function routerAt(matches: Match[]) {
  const state = { matches: matches.map((match) => ({ ...match, params: {} })) };
  return {
    router: { state } as unknown as AnyRouter,
    navigate: (next: Match[]) => {
      state.matches = next.map((match) => ({ ...match, params: {} }));
    },
  };
}

const CHAT: Match[] = [
  { routeId: "__root__", pathname: "/" },
  { routeId: "/_chat", pathname: "/" },
];

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

function selectThread(threadKey: string) {
  useThreadSelectionStore.getState().clearSelection();
  useThreadSelectionStore.getState().toggleThread(threadKey);
}

describe("chat route commands", () => {
  it.each([
    { name: "Threads", matches: CHAT, search: {}, handled: true },
    {
      name: "Bots list",
      matches: [{ routeId: "/bots", pathname: "/bots" }],
      search: {},
      handled: true,
    },
    {
      name: "selected bot",
      matches: [{ routeId: "/bots", pathname: "/bots" }],
      search: { bot: "bot-1", env: "env-1" },
      handled: true,
    },
    {
      name: "pairing",
      matches: [{ routeId: "__root__", pathname: "/pair" }],
      search: {},
      handled: false,
    },
    {
      name: "Settings",
      matches: [...CHAT, { routeId: "/_chat/settings", pathname: "/settings" }],
      search: {},
      handled: false,
    },
  ])(
    "handles new-thread shortcuts in $name according to route scope",
    async ({ matches, search, handled }) => {
      const { router } = routerAt(matches);
      Object.assign(router.state, { location: { search } });
      using stack = new DisposableStack();
      stack.defer(installChatRouteCommands(router));
      const input = document.createElement("textarea");
      document.body.append(input);
      stack.defer(() => input.remove());

      for (const target of [window, input]) {
        vi.mocked(openCommandPalette).mockClear();
        const event = new KeyboardEvent("keydown", {
          key: "n",
          metaKey: isMacPlatform(navigator.platform),
          ctrlKey: !isMacPlatform(navigator.platform),
          cancelable: true,
          bubbles: true,
        });
        target.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(handled);
        if (handled) {
          await vi.waitFor(() =>
            expect(openCommandPalette).toHaveBeenCalledWith({ open: "new-thread-in" }),
          );
        } else {
          expect(openCommandPalette).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("clears a selection made after install, reading the store at keypress time", () => {
    const { router } = routerAt(CHAT);
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    stack.defer(() => useThreadSelectionStore.getState().clearSelection());

    selectThread("env:thread-1");
    const event = pressEscape();

    expect(event.defaultPrevented).toBe(true);
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
    // With nothing selected, Escape is left for other handlers.
    expect(pressEscape().defaultPrevented).toBe(false);
  });

  it("stays out of the way off the chat route and under modal pages", () => {
    const { router, navigate } = routerAt([{ routeId: "__root__", pathname: "/pair" }]);
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    stack.defer(() => useThreadSelectionStore.getState().clearSelection());
    selectThread("env:thread-1");

    expect(pressEscape().defaultPrevented).toBe(false);

    navigate([...CHAT, { routeId: "/_chat/settings", pathname: "/settings" }]);
    expect(pressEscape().defaultPrevented).toBe(false);
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(1);

    navigate([{ routeId: "/bots", pathname: "/bots" }]);
    expect(pressEscape().defaultPrevented).toBe(false);
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(1);

    navigate(CHAT);
    expect(pressEscape().defaultPrevented).toBe(true);
  });
});
