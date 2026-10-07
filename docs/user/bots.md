# Bots

A bot is a long-running agent that lives in one thread, its home thread, and wakes on its own schedules. **Bots** shows each bot as a single chat with your messages and the short reply the bot ends each turn with. Work the bot hands to other threads shows up as its workers.

## Add a bot

Each bot is a folder in the `bots` directory of your T3 home, for example `~/.t3/bots/librarian`. Set `T3CODE_BOTS_DIR` to use a different directory. The folder name is the bot's id.

Put a `bot.json` in the folder:

```json
{
  "name": "Librarian",
  "homeThreadId": "<id of the bot's thread>"
}
```

Add an optional `charter.md` describing the bot's job. Schedules that target the home thread belong to the bot automatically. Create them in **Settings → Scheduled Tasks**.

## Talk to a bot

Open **Bots** from the sidebar, the command palette, or **View → Open Bots** on desktop. On mobile, use the **Bots** section of the Home screen. Messages and images you send go to the home thread. Activity from schedules and other threads collapses into a summary you can expand. Tap a worker to open its thread.

When a bot is waiting on an approval or an answer, its chat says so and links to the home thread, where you respond. **Stop** ends the bot's current turn.

**About** shows the bot's model, schedules, charter and workers, and opens the full home thread when you need every tool call.

## Open items

When an agent needs a decision from you, it can add an open item to its thread instead of burying the question in a reply. Open items appear in a panel beside the thread (open it from the panel launcher or **Show open items** in the command palette) and, on mobile, from the **open** count above the composer. Each item can offer suggested answers, mark a recommended one, and say what the agent will do if you stay silent. Bots notify you when they add one, and the Bots list shows each bot's count.

Tap an option or type a reply to answer. Your answer is sent to the agent as a message, so it picks the work back up. **Drop** closes an item and **Reopen** brings a resolved item back; the agent is told either way. A thread with an open item is never auto-settled.

## Pause a bot

**Pause bot** in About turns off every schedule the bot owns. **Resume bot** turns back on the ones that were on when you paused. You can still message a paused bot.

## Notifications

Bots always notify when they reply. Tapping a bot's notification opens its chat. With **Agent threads** off, only bots notify; all other threads stay quiet. Turn on **Agent threads** in **Settings → General** (web and desktop) or **Settings → Notifications** (mobile).

## Long-running context

A bot's home thread compacts its context automatically when its context passes 250,000 tokens or 80% of the model's context window, whichever is lower, so the bot keeps working in the same thread. The chat marks the point with **Context reset** and the size before and after.
