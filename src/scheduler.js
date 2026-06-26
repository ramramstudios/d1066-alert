// scheduler.js — manages the recurring reminder job with node-cron.
//
// One job runs at a time. Changing turns stops the old job and starts a fresh one
// for the new color. Each tick sends the active player's emoji to the group chat,
// and — when it's the outside player's turn — a personalized 1:1 to their Apple ID.
import cron from 'node-cron';
import { log, logError } from './store.js';
import { sendToGroup, sendToHandle } from './sender.js';

/**
 * Build a cron expression for an N-minute interval.
 *   60            -> "0 * * * *"     (top of every hour)
 *   divisor of 60 -> "* / N * * * *"  (e.g. 15 -> every 15 min, on the clock)
 * Anything else falls back to hourly with a warning, since cron's minute field
 * can't express arbitrary intervals cleanly.
 */
export function cronExpressionFor(intervalMinutes) {
  const n = Math.round(intervalMinutes);
  if (n === 60) return '0 * * * *';
  if (n >= 1 && n < 60 && 60 % n === 0) return `*/${n} * * * *`;
  logError(`reminderIntervalMinutes=${intervalMinutes} isn't a divisor of 60; falling back to hourly.`);
  return '0 * * * *';
}

export function createScheduler(config) {
  let task = null;
  let activeColor = null;

  /** Send one round of reminders for the given color. */
  async function fireReminder(color) {
    const player = config.players[color];
    if (!player) {
      logError(`No player config for color "${color}"; skipping reminder.`);
      return;
    }

    // Group chat always gets just the emoji.
    try {
      await sendToGroup(config.groupChatName, player.emoji);
    } catch {
      /* sender already logged; keep going so the outside player still gets pinged */
    }

    // The outside player gets a personalized 1:1 only when the active color is theirs.
    if (color === config.outsidePlayerColor && player.appleId) {
      const greeting = config.outsidePlayerName ? `${config.outsidePlayerName}, your turn` : 'Your turn';
      const note = `${greeting} in Dragons of 1066! ${player.emoji}`;
      try {
        await sendToHandle(player.appleId, note);
      } catch {
        /* sender already logged */
      }
    }
  }

  return {
    get activeColor() {
      return activeColor;
    },

    /** Start (or restart) the reminder job for a color. */
    start(color) {
      this.stop();
      activeColor = color;
      const expr = cronExpressionFor(config.reminderIntervalMinutes);
      task = cron.schedule(expr, () => {
        fireReminder(color).catch((err) => logError(`Reminder tick failed: ${err.message}`));
      });
      log(`Reminders started for ${color} (${config.players[color]?.emoji}) on schedule "${expr}".`);
    },

    /** Stop the current reminder job, if any. */
    stop() {
      if (task) {
        task.stop();
        task = null;
        log(`Reminders stopped${activeColor ? ` for ${activeColor}` : ''}.`);
      }
      activeColor = null;
    },

    /** Send one reminder immediately (used by --send-test and optional confirmations). */
    fireNow(color) {
      return fireReminder(color);
    },
  };
}
