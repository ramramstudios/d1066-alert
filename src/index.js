// index.js — entry point. Loads config + state, resumes the current turn, polls the
// Messages DB for triggers, and runs the reminder scheduler.
//
// Modes:
//   node src/index.js              run continuously (poll + reminders)
//   node src/index.js --poll-once  run a single poll and exit (debugging)
//   node src/index.js --send-test  send a test message to the group + outside player (permission check)
import {
  TURN_ORDER,
  loadConfig,
  loadState,
  saveState,
  log,
  logError,
} from './store.js';
import { pollForTriggers, initialCursor, checkDbAccess } from './watcher.js';
import { createScheduler } from './scheduler.js';
import { sendToGroup, sendToHandle } from './sender.js';

async function sendTest(config) {
  log('Running --send-test (verifies Full Disk Access + Messages Automation)...');
  checkDbAccess();
  const outsideColor = config.outsidePlayerColor;
  const outsidePlayer = config.players[outsideColor];
  await sendToGroup(config.groupChatName, `🧪 d1066-alert test ${outsidePlayer.emoji}`);
  await sendToHandle(outsidePlayer.appleId, `🧪 d1066-alert test — turn pings will look like: Your turn in Dragons of 1066! ${outsidePlayer.emoji}`);
  log('Send test complete — check the group chat and the outside player.');
}

async function main() {
  const args = process.argv.slice(2);
  const config = loadConfig();

  if (args.includes('--send-test')) {
    await sendTest(config);
    return;
  }

  const state = loadState();
  const scheduler = createScheduler(config);

  // First run: start the cursor at "now" so we don't replay old chat history.
  if (!state.lastMessageDate || state.lastMessageDate <= 0) {
    state.lastMessageDate = initialCursor();
    saveState(state);
  }

  function onTrigger(color) {
    state.currentTurn = color;
    state.lastTriggeredAt = new Date().toISOString();
    saveState(state);
    scheduler.start(color); // stops any prior job and starts a fresh one
    log(`Turn changed to ${color} ${config.players[color]?.emoji}.`);
  }

  function runPoll() {
    try {
      const { trigger, lastMessageDate } = pollForTriggers(config.groupChatName, state.lastMessageDate);
      if (lastMessageDate !== state.lastMessageDate) {
        state.lastMessageDate = lastMessageDate;
        saveState(state);
      }
      if (trigger && trigger !== state.currentTurn) {
        onTrigger(trigger);
      } else if (trigger) {
        log(`Trigger for ${trigger} ignored — already the active turn.`);
      }
    } catch (err) {
      logError(`Poll failed (will retry next interval): ${err.message}`);
    }
  }

  // Resume an in-progress turn from persisted state.
  if (state.currentTurn && TURN_ORDER.includes(state.currentTurn)) {
    log(`Resuming current turn: ${state.currentTurn} ${config.players[state.currentTurn]?.emoji}`);
    scheduler.start(state.currentTurn);
  } else {
    log('No current turn set — waiting for a trigger word ("red up", "gold up", ...).');
  }

  if (args.includes('--poll-once')) {
    runPoll();
    log('Single poll complete.');
    scheduler.stop();
    return;
  }

  const pollMs = Math.max(1, config.pollIntervalMinutes) * 60 * 1000;
  log(`Watching "${config.groupChatName}" every ${config.pollIntervalMinutes} min; ` +
      `reminders every ${config.reminderIntervalMinutes} min.`);

  const pollTimer = setInterval(runPoll, pollMs);
  runPoll(); // poll immediately on startup

  function shutdown(signal) {
    log(`Received ${signal}; shutting down.`);
    clearInterval(pollTimer);
    scheduler.stop();
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('uncaughtException', (err) => {
  logError('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logError('Unhandled rejection:', reason);
});

main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
