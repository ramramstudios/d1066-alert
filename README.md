# Dragons of 1066 — iMessage Turn Reminder Bot

A small, fully-local macOS automation that watches your **Dragons of 1066** iMessage
group chat for turn-change trigger words and sends **hourly emoji reminders** to the
group — plus a personal nudge to the one player who isn't in the group chat.

Everything runs on your Mac via the Messages app and the local Messages database.
No third-party APIs, no servers, no cloud. Messages send from **your own Apple ID**.

```
red up    → 🔴 reminders every hour
gold up   → 🟡 reminders every hour
blue up   → 🔵 reminders every hour
silver up → ⚪️ reminders every hour   (not in the group chat → also gets a 1:1 ping)
```

---

## How it works

| Piece | What it does |
| --- | --- |
| `src/watcher.js` | Every 5 min, reads `~/Library/Messages/chat.db` (read-only) for new messages in the group chat and looks for `<color> up`. |
| `src/scheduler.js` | Runs the hourly [`node-cron`](https://www.npmjs.com/package/node-cron) reminder job for the active color. |
| `src/sender.js` | Sends iMessages through the Messages app via AppleScript (`osascript`). |
| `src/index.js` | Loads state, resumes the current turn, wires the poller + scheduler together. |
| `state.json` | Remembers the current turn between restarts (and where it left off reading). |
| `config.json` | Your settings (group name, players, the outside player's Apple ID). **Not committed.** |

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
cp config.example.json config.json
```

Then edit `config.json`:

```json
{
  "groupChatName": "Dragons of 1066",
  "players": {
    "red":    { "name": "Red",    "emoji": "🔴", "appleId": null },
    "gold":   { "name": "Gold",   "emoji": "🟡", "appleId": null },
    "blue":   { "name": "Blue",   "emoji": "🔵", "appleId": null },
    "silver": { "name": "Silver", "emoji": "⚪️", "appleId": "player@example.com" }
  },
  "outsidePlayerColor": "silver",
  "reminderIntervalMinutes": 60,
  "pollIntervalMinutes": 5
}
```

- **`groupChatName`** — must exactly match the group's name in Messages (see note below).
- **`outsidePlayerColor`** — which color belongs to the player who isn't in the group chat.
- **`players.<color>.appleId`** — set this for `outsidePlayerColor` to that player's iMessage email or
  phone number (e.g. `"+15551234567"`). The other colors can stay `null`.
- **`reminderIntervalMinutes`** — keep `60` for hourly. Other values must divide evenly
  into 60 (e.g. 15, 20, 30); anything else falls back to hourly.

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

### 4. Try it in the foreground first

```bash
npm start
```

You should see timestamped logs. Post `red up` in the group chat (or have someone do
it), wait for the next poll, and confirm the turn changes in the logs. <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop.

---

## Run it automatically with launchd

The launchd agent starts the bot at login and restarts it if it crashes.

### Install the agent

The plist already points at `/usr/local/bin/node` and this project folder. If your node
path or project location differ, edit `com.d1066.alert.plist` first (see the comments in it).

Symlink it into `~/Library/LaunchAgents` (symlink = edits here stay in sync), then load it:

```bash
ln -sf "$PWD/com.d1066.alert.plist" ~/Library/LaunchAgents/com.d1066.alert.plist
launchctl load -w ~/Library/LaunchAgents/com.d1066.alert.plist
```

> On newer macOS you can equivalently use:
> `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.d1066.alert.plist`

Confirm it's running:

```bash
launchctl list | grep com.d1066.alert
```

### Check the logs

All output (including the bot's own timestamped lines) goes to:

```bash
tail -f ~/Library/Logs/d1066-alert.log
```

### Stop / unload the agent

```bash
launchctl unload -w ~/Library/LaunchAgents/com.d1066.alert.plist
# newer macOS equivalent:
# launchctl bootout gui/$(id -u)/com.d1066.alert
```

To apply changes after editing code or the plist: `unload` then `load` again.

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

Case-insensitive; detected anywhere in a group-chat message:

| Type this in the group | Effect |
| --- | --- |
| `red up`    | Current turn → Red 🔴 |
| `gold up`   | Current turn → Gold 🟡 |
| `blue up`   | Current turn → Blue 🔵 |
| `silver up` | Current turn → Silver ⚪️ (outside player also gets a 1:1) |

- Group reminder message: just the emoji, e.g. `🔴`.
- The outside player's 1:1 message (only on their turn): `Your turn in Dragons of 1066! ⚪️`.

---

## Troubleshooting

**`Cannot read chat.db … Full Disk Access`** — `node` (and/or your terminal) isn't in
Full Disk Access. Re-check step 3a. After granting, fully quit and relaunch the terminal,
or `unload`/`load` the agent.

**`No iMessage chat named '…' was found`** — `groupChatName` doesn't match the group's
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

- `config.json` and `state.json` are git-ignored — they hold your Apple IDs and chat
  cursor and are never committed.
- `chat.db` is opened **read-only**; the bot never writes to your Messages database.
- All messages are sent from your own Apple ID via the Messages app on your Mac.
