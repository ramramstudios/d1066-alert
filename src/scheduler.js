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
 *   divisor of 60  -> "* / N * * * *"  (e.g. 15 -> every 15 min)
 *   60             -> "0 * * * *"      (every hour)
 *   multiple of 60 -> "0 * / H * * *"  (e.g. 120 -> every 2 hours)
 * Anything else falls back to hourly with a warning.
 */
export function cronExpressionFor(intervalMinutes) {
  const n = Math.round(intervalMinutes);
  if (n >= 1 && n < 60 && 60 % n === 0) return `*/${n} * * * *`;
  if (n >= 60 && n % 60 === 0) {
    const h = n / 60;
    return h === 1 ? '0 * * * *' : `0 */${h} * * *`;
  }
  logError(`reminderIntervalMinutes=${intervalMinutes} must be a divisor of 60 (e.g. 15, 30, 60) or a multiple of 60 (e.g. 120, 180); falling back to hourly.`);
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
      try {
        await sendToHandle(player.appleId, player.emoji);
      } catch {
        /* sender already logged */
      }
    }
  }

  return {
    get activeColor() {
      return activeColor;
    },

    /** Start (or restart) the recurring reminder job for a color (no immediate send). */
    start(color) {
      this.stop();
      activeColor = color;
      const expr = cronExpressionFor(config.reminderIntervalMinutes);
      task = cron.schedule(expr, () => {
        fireReminder(color).catch((err) => logError(`Reminder tick failed: ${err.message}`));
      });
      log(`Reminders started for ${color} (${config.players[color]?.emoji}) on schedule "${expr}".`);
    },

    /** Make `color` the active turn: (re)start its schedule AND send one reminder immediately. */
    setTurn(color) {
      this.start(color);
      return fireReminder(color).catch((err) => logError(`Immediate reminder failed: ${err.message}`));
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
