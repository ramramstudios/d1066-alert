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
  await sendToGroup(config.groupChatName, '🧪 d1066-alert test');
  const outsideColor = config.outsidePlayerColor;
  if (outsideColor) {
    const outsidePlayer = config.players[outsideColor];
    await sendToHandle(
      outsidePlayer.appleId,
      `🧪 d1066-alert test — turn pings will look like: ${outsidePlayer.emoji}`,
    );
    log('Send test complete — check the group chat and the outside player.');
  } else {
    log('Send test complete — group-only (no outside player configured).');
  }
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

  // Update the current turn from a detected trigger. When `activate` is true we also
  // (re)start the schedule and throw an orb immediately; during boot catch-up it's false,
  // so we just figure out whose turn it is without sending anything yet.
  function applyTrigger(color, { activate }) {
    state.currentTurn = color;
    state.lastTriggeredAt = new Date().toISOString();
    saveState(state);
    if (activate) {
      scheduler.setTurn(color); // restart schedule + throw one orb now
      log(`Turn changed to ${color} ${config.players[color]?.emoji}.`);
    }
  }

  function runPoll({ activate }) {
    try {
      const outsideHandle = config.outsidePlayerColor
        ? config.players[config.outsidePlayerColor].appleId
        : null;
      const { trigger, lastMessageDate } = pollForTriggers(config.groupChatName, state.lastMessageDate, config.triggers, outsideHandle);
      if (lastMessageDate !== state.lastMessageDate) {
        state.lastMessageDate = lastMessageDate;
        saveState(state);
      }
      if (trigger && trigger !== state.currentTurn) {
        applyTrigger(trigger, { activate });
      } else if (trigger && activate) {
        log(`Trigger for ${trigger} ignored — already the active turn.`);
      }
    } catch (err) {
      logError(`Poll failed (will retry next interval): ${err.message}`);
    }
  }

  if (args.includes('--poll-once')) {
    runPoll({ activate: false });
    log('Single poll complete.');
    return;
  }

  // Catch up on any triggers received while we were off, so we land on the TRUE current
  // turn before throwing the first orb. No orb is sent during catch-up.
  runPoll({ activate: false });

  // Now that we know whose turn it actually is, activate it and throw exactly one orb.
  if (state.currentTurn && TURN_ORDER.includes(state.currentTurn)) {
    log(`Resuming current turn: ${state.currentTurn} ${config.players[state.currentTurn]?.emoji}`);
    scheduler.setTurn(state.currentTurn);
  } else {
    log(`No current turn set — waiting for a trigger word (e.g. "${config.triggers.red}").`);
  }

  const pollMs = Math.max(1, config.pollIntervalMinutes) * 60 * 1000;
  log(`Watching "${config.groupChatName}" every ${config.pollIntervalMinutes} min; ` +
      `reminders every ${config.reminderIntervalMinutes} min.`);

  // From here on, live triggers change the turn and fire immediately.
  const pollTimer = setInterval(() => runPoll({ activate: true }), pollMs);

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
