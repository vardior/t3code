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

Open **Bots** in the sidebar, or the **Bots** section on the mobile Home screen. Messages you send go to the home thread. Activity from schedules and other threads collapses into a summary you can expand. Tap a worker to open its thread.

**About** shows the bot's model, schedules, charter and workers, and opens the full home thread when you need every tool call.

## Pause a bot

**Pause bot** in About turns off every schedule the bot owns. **Resume bot** turns back on the ones that were on when you paused. You can still message a paused bot.

## Notifications

Bots always notify when they reply. Tapping a bot's notification opens its chat. Threads that agents start on their own notify only when **Agent threads** is on in **Settings → General** (web and desktop) or **Settings → Notifications** (mobile).

## Long-running context

A bot's home thread compacts its context automatically after a turn uses more than 150,000 tokens, so the bot keeps working in the same thread. The chat marks the point with **Context reset** and the size before and after.
