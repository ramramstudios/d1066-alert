// store.js — shared helpers: paths, constants, config/state IO, time conversion.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT = path.resolve(__dirname, '..');
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const STATE_PATH = path.join(ROOT, 'state.json');

// Turn order for Dragons of 1066. Also the set of valid colors / trigger keys.
export const TURN_ORDER = ['red', 'gold', 'blue', 'silver'];

// Unix epoch (seconds) for 2001-01-01T00:00:00Z — the Mac "absolute time" reference.
const MAC_EPOCH_OFFSET_SECONDS = 978307200;

const DEFAULT_STATE = {
  currentTurn: null,
  lastTriggeredAt: '',
  lastMessageDate: 0,
};

/** Timestamped logger so launchd logs are readable. */
export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

export function logError(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

/** Current time as Mac absolute time in nanoseconds (matches message.date on modern macOS). */
export function macTimeNowNs() {
  return Math.round((Date.now() / 1000 - MAC_EPOCH_OFFSET_SECONDS) * 1e9);
}

/** Convert a Mac-absolute-time nanosecond value (message.date) to a JS Date. */
export function macNsToDate(ns) {
  if (!ns) return null;
  return new Date((Number(ns) / 1e9 + MAC_EPOCH_OFFSET_SECONDS) * 1000);
}

/** Load and validate config.json, throwing a clear, actionable error if it's wrong. */
export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `config.json not found at ${CONFIG_PATH}.\n` +
        `Create it by copying the template:  cp config.example.json config.json\n` +
        `then fill in your group chat name and the outside player's Apple ID.`,
    );
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }

  if (!config.groupChatName || typeof config.groupChatName !== 'string') {
    throw new Error('config.json: "groupChatName" must be a non-empty string.');
  }
  if (!config.players || typeof config.players !== 'object') {
    throw new Error('config.json: "players" object is missing.');
  }
  for (const color of TURN_ORDER) {
    const p = config.players[color];
    if (!p || typeof p.emoji !== 'string' || !p.emoji) {
      throw new Error(`config.json: players.${color}.emoji is missing.`);
    }
  }
  if (!TURN_ORDER.includes(config.outsidePlayerColor)) {
    throw new Error(
      `config.json: "outsidePlayerColor" must be one of ${TURN_ORDER.join(', ')} (got ${config.outsidePlayerColor}).`,
    );
  }
  const outsidePlayer = config.players[config.outsidePlayerColor];
  if (!outsidePlayer.appleId) {
    throw new Error(
      `config.json: players.${config.outsidePlayerColor}.appleId is null, but outsidePlayerColor points to it. ` +
        `Set the outside player's Apple ID (email or phone) there.`,
    );
  }

  // Normalize intervals to sane positive numbers.
  config.reminderIntervalMinutes = Number(config.reminderIntervalMinutes) || 60;
  config.pollIntervalMinutes = Number(config.pollIntervalMinutes) || 5;

  return config;
}

/** Load state.json, creating it from defaults if missing or corrupt. */
export function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    saveState(DEFAULT_STATE);
    return { ...DEFAULT_STATE };
  }
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { ...DEFAULT_STATE, ...state };
  } catch (err) {
    logError(`state.json was unreadable (${err.message}); resetting to defaults.`);
    saveState(DEFAULT_STATE);
    return { ...DEFAULT_STATE };
  }
}

/** Persist state atomically (write tmp + rename) so a crash can't corrupt it. */
export function saveState(state) {
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, STATE_PATH);
}
