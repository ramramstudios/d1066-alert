# Dragons of 1066 — iMessage Turn Reminder Bot

A small, fully-local macOS automation that watches your **Dragons of 1066** iMessage
group chat for turn-change trigger words and sends **recurring emoji reminders** to the
group — plus, optionally, a personal nudge to a player who isn't in the group chat.

Everything runs on your Mac via the Messages app and the local Messages database.
No third-party APIs, no servers, no cloud. Messages send from **your own Apple ID**.

Detect turn changes and fire reminders on a schedule you set:
```
red up    → 🔴 reminder sent
gold up   → 🟡 reminder sent
blue up   → 🔵 reminder sent
silver up → ⚪️ reminder sent   (optional: also 1:1 to the outside player)
```

---

## How it works

| Piece | What it does |
| --- | --- |
| `src/watcher.js` | Polls `~/Library/Messages/chat.db` (read-only) at a configurable interval for new messages in the group chat and detects trigger words. |
| `src/scheduler.js` | Runs [`node-cron`](https://www.npmjs.com/package/node-cron) reminder jobs at a configurable interval for the active color. |
| `src/sender.js` | Sends iMessages through the Messages app via AppleScript (`osascript`). |
| `src/index.js` | Loads state, resumes the current turn, wires the poller + scheduler together. |
| `state.json` | Remembers the current turn between restarts (and where it left off reading). |
| `.env` | Your settings (group name; optional outside player + phone). **Not committed.** |

When a trigger is detected, the bot updates `state.json`, cancels the old reminder
job, and starts a new one for the new color. On login/restart it reads `state.json`
and resumes wherever the game was.

---

## Setup

### 1. Install dependencies

```bash
cd ~/swe/d1066-alert
npm install
```

> `better-sqlite3` is a native module. It usually installs a prebuilt binary; if it
> needs to compile, install Xcode Command Line Tools first: `xcode-select --install`.

### 2. Create your config

```bash
cp .env.example .env
```

Then edit `.env`. **Only `GROUP_CHAT_NAME` is always required:**

```bash
# ── Required ──
GROUP_CHAT_NAME=Dragons of 1066      # exact name of the group in Messages

# ── Optional: outside player (one player not in the group chat) ──
# Set COLOR + PHONE to give that player a private 1:1 reminder on their turn (NAME optional).
# Leave color + phone blank if everyone is in the group chat — the bot just posts to the group.
OUTSIDE_PLAYER_COLOR=silver          # red | gold | blue | silver
OUTSIDE_PLAYER_PHONE=+15551234567    # full international format

# ── Optional: trigger words ──
# What your group says to change turns (case-insensitive, anywhere in a message).
TRIGGER_RED=red up
TRIGGER_GOLD=gold up
TRIGGER_BLUE=blue up
TRIGGER_SILVER=silver up

# ── Optional: timing (defaults shown) ──
REMINDER_INTERVAL_MINUTES=60         # 60 = hourly; other values must divide into 60
POLL_INTERVAL_MINUTES=5              # how often to check the group for triggers
```

- **`GROUP_CHAT_NAME`** — must exactly match the group's name in Messages (see note below). The only always-required value.
- **`OUTSIDE_PLAYER_COLOR` / `OUTSIDE_PLAYER_PHONE`** — *optional.* Only for when one player
  isn't in the group chat and you want them DM'd on their turn. Set the **color**
  (`red`/`gold`/`blue`/`silver`) and **phone** (full international format like `+15551234567`, or an
  iMessage email). **Leave both blank if everyone is in the group chat** — the bot then just posts
  the emoji to the group, nothing else changes.
- **`TRIGGER_RED` / `TRIGGER_GOLD` / `TRIGGER_BLUE` / `TRIGGER_SILVER`** — *optional.* What the group
  says to change turns (case-insensitive, as a standalone message). Defaults are `red up`, `gold up`,
  etc. Customize these if your group uses different words — e.g. `@red`, `RED TEAM`, etc.
- **`REMINDER_INTERVAL_MINUTES`** — how often reminders fire (in minutes). Must divide evenly into 60
  (e.g. 15, 20, 30, 60); other values fall back to 60. Defaults to 60.
- **`POLL_INTERVAL_MINUTES`** — how often the bot checks for new trigger words (in minutes). Defaults to 5.
- Player **names and emojis** (🔴 🟡 🔵 ⚪️) are fixed game constants in `src/store.js` — no need to set them.

> **The group chat must have a name.** AppleScript targets the group by its display
> name. In Messages, open the conversation → click the participants at the top →
> **Change Name** (or it already shows "Dragons of 1066"). Use that exact string.

### 3. Grant macOS permissions

This bot needs two privacy permissions. Both live in **System Settings → Privacy & Security**.

**a) Full Disk Access** — to read the Messages database (`chat.db`).

- System Settings → Privacy & Security → **Full Disk Access**
- Click **+**, press <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>G</kbd>, paste `/usr/local/bin/node`,
  add it, and toggle it **on**. (This is the `node` that launchd will run — confirm the
  path with `which node`.)
- For interactive testing from Terminal, also grant **Full Disk Access** to your
  terminal app (Terminal or iTerm).

**b) Automation (Messages)** — to send messages through the Messages app.

- The first time the bot sends, macOS pops up *"… wants to control Messages."* Click **OK**.
- To trigger that prompt deliberately, run the send test from your terminal:

  ```bash
  npm run send-test
  ```

  This sends a clearly-marked 🧪 test to the group and to the outside player, and surfaces the
  Automation prompt. Approve it. You can confirm afterward under
  System Settings → Privacy & Security → **Automation**.

> **launchd + permissions gotcha:** TCC ties these permissions to the binary doing the
> work (`node`) and/or the app that launched it. The reliable recipe is: (1) add
> `/usr/local/bin/node` to **Full Disk Access**, and (2) run `npm run send-test` once
> from Terminal and approve the **Automation** prompt. After that the launchd agent can
> send without a UI session. If reminders silently don't send, see Troubleshooting.

### 4. Run it

```bash
npm start
```

You should see timestamped logs. Post a trigger word in the group chat, wait for the
next poll, and confirm the turn changes in the logs. <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop.

> **Recommended: run this way for now.** `npm start` from Terminal gives the bot
> full access to `chat.db` (via Terminal's Full Disk Access grant), so both trigger
> detection and reminders work correctly. The launchd auto-start method below has a
> known limitation on macOS Monterey: `sandboxd` blocks the background process from
> reading `chat.db`, so polling and trigger detection don't work — only reminders fire.
> Until that's resolved, `npm start` is the reliable path.
>
> **Use the macOS Terminal app** (or iTerm), not the terminal built into VS Code. VS Code's
> integrated terminal doesn't inherit Terminal's Full Disk Access grant, so polling fails
> there for the same reason it fails under launchd.

---

## Run it automatically with launchd (reminders only — polling broken on Monterey)

> ⚠️ **Known issue:** On macOS Monterey, when the bot runs as a launchd background
> agent, `sandboxd` intercepts its access to `chat.db` even though `node` has Full
> Disk Access granted in System Settings. Reminders fire on schedule, but trigger words
> in the group chat are not detected — turns must be changed manually (see
> [Manually setting the turn](#manually-setting-the-turn)). `npm start` from Terminal
> does not have this limitation.

The launchd agent starts the bot at login and restarts it if it crashes.

### Install the agent

The plist already points at `/usr/local/bin/node` and this project folder. If your node
path or project location differ, edit `com.d1066.alert.plist` first (see the comments in it).

Copy it to `~/Library/LaunchAgents` and load it:

```bash
cp com.d1066.alert.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.d1066.alert.plist
```

Confirm it's running:

```bash
launchctl list | grep com.d1066.alert
```

You should see output like `12345	0	com.d1066.alert` (the exact PID varies).

### Check the logs

All output (including the bot's own timestamped lines) goes to:

```bash
tail -f ~/Library/Logs/d1066-alert.log
```

### Stop / unload the agent

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.d1066.alert.plist
```

To apply changes after editing code or the plist: `bootout` then `bootstrap` again.

---

## Manually setting the turn

The current turn lives in `state.json`. You normally never touch it — trigger words
drive it — but you can set it by hand. Stop the agent first (or it'll keep running with
the old in-memory turn until the next trigger), edit the file, then start it again:

```json
{
  "currentTurn": "blue",
  "lastTriggeredAt": "2026-06-25T18:00:00.000Z",
  "lastMessageDate": 0
}
```

- **`currentTurn`** — one of `red`, `gold`, `blue`, `silver`, or `null` for "no turn yet".
- **`lastTriggeredAt`** — informational ISO timestamp of the last turn change.
- **`lastMessageDate`** — the bot's read cursor into `chat.db` (Mac-absolute nanoseconds).
  Set it to `0` to have the bot re-baseline to "now" on next start (it won't replay old
  messages). Leave it alone otherwise.

Reload the agent (`unload` then `load`) to pick up a hand-edited turn.

---

## Trigger reference

**The trigger phrase must be the only thing in the message** (case-insensitive, leading/trailing
whitespace and trailing punctuation stripped). E.g. `red up`, `Red up!`, `  red up  ` all match,
but `red up please` or `feeling red up` don't. To use custom words (e.g. `@red`, `RED TEAM`), set
`TRIGGER_RED`, `TRIGGER_GOLD`, etc. in `.env`.

| Default trigger | Effect |
| --- | --- |
| `red up`    | Current turn → Red 🔴 |
| `gold up`   | Current turn → Gold 🟡 |
| `blue up`   | Current turn → Blue 🔵 |
| `silver up` | Current turn → Silver ⚪️ (outside player also gets a 1:1) |

- Group reminder message: just the emoji, e.g. `🔴`.
- The outside player's 1:1 message (only if configured, and only on their turn): just their color emoji, e.g. `⚪️`.

---

## Troubleshooting

**`Cannot read chat.db … Full Disk Access`** — `node` (and/or your terminal) isn't in
Full Disk Access. Re-check step 3a. After granting, fully quit and relaunch the terminal,
or `unload`/`load` the agent.

**`No iMessage chat named '…' was found`** — `GROUP_CHAT_NAME` doesn't match the group's
actual name in Messages, or the group has no name set. Rename the conversation in
Messages and match it exactly.

**Reminders never send (no error in logs)** — usually the Automation permission. Run
`npm run send-test` from Terminal and approve the prompt. Confirm under System Settings →
Privacy & Security → Automation that your terminal/`node` is allowed to control Messages.

**Triggers aren't detected** — confirm with a single poll:

```bash
npm run poll      # node src/index.js --poll-once
```

Post `red up`, then run it again. On modern macOS the message text lives in a binary
`attributedBody` blob; the watcher decodes it, but if your messages use unusual
formatting and a trigger is missed, send the trigger as plain text.

**Nothing happens on the very first run** — by design, the bot baselines its read cursor
to "now" on first start so it doesn't reprocess your entire chat history. Only messages
sent *after* it starts are considered.

---

## Privacy & safety

- **Everything is local.** The bot runs entirely on your Mac and reads from your local Messages
  database (`~/Library/Messages/chat.db`). No data leaves your machine; no external service sees
  your messages or conversations.
- **You own the data access.** The bot reads the same Messages database *you* (the Mac's owner) can
  already read directly — it's your own Mac, your own account. Running this automation isn't
  granting anyone new access; it's just automating something you could do manually yourself.
- **Messages are sent from your account.** All reminders are sent from your own Apple ID via
  the Messages app on your Mac. The receiver sees them as coming from you, because they do.
- **No writing to chat.db.** The bot opens the Messages database read-only; it never modifies,
  logs, or stores message content. It only scans for trigger words in real time.
- `.env` and `state.json` are git-ignored — they hold your configuration (optionally including
  a player's phone number) and chat cursor, and are never committed to version control.
