// store.js — shared helpers: paths, constants, config/state IO, time conversion.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT = path.resolve(__dirname, '..');
export const ENV_PATH = path.join(ROOT, '.env');
export const STATE_PATH = path.join(ROOT, 'state.json');
// RAG context for AI replies — DJT post corpus used as a VOICE reference. Default is
// the plain-text feed (one post per line); the loader also accepts .json/.jsonl.
export const RAG_PATH = path.join(ROOT, 'trumpbot', 'trump.txt');

// Turn order for Dragons of 1066. Also the set of valid colors / trigger keys.
export const TURN_ORDER = ['red', 'gold', 'blue', 'silver'];

// Fixed game constants — display names and emojis are the same for every install,
// so only personal/per-game values live in .env (see loadConfig()).
const PLAYER_DEFAULTS = {
  red:    { name: 'Red',    emoji: '🔴' },
  gold:   { name: 'Gold',   emoji: '🟡' },
  blue:   { name: 'Blue',   emoji: '🔵' },
  silver: { name: 'Silver', emoji: '⚪️' },
};

// Unix epoch (seconds) for 2001-01-01T00:00:00Z — the Mac "absolute time" reference.
const MAC_EPOCH_OFFSET_SECONDS = 978307200;

const DEFAULT_STATE = {
  currentTurn: null,
  lastTriggeredAt: '',
  lastMessageDate: 0,
};

function timestamp() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

/** Timestamped logger so launchd logs are readable. */
export function log(...args) {
  console.log(`[${timestamp()}]`, ...args);
}

export function logError(...args) {
  console.error(`[${timestamp()}]`, ...args);
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

/** Minimal .env reader: `KEY=value` lines, `#` comments, optional surrounding quotes. */
function parseEnvFile(filePath) {
  const out = {};
  for (const raw of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load config from the git-ignored .env file and assemble the runtime config object.
 * Only personal/per-game values come from .env; emojis, names and turn order are fixed
 * constants. Throws a clear, actionable error if a required value is missing.
 */
export function loadConfig() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(
      `.env not found at ${ENV_PATH}.\n` +
        `Create it by copying the template:  cp .env.example .env\n` +
        `then fill in GROUP_CHAT_NAME (and the OUTSIDE_PLAYER_* values if one player isn't in the group).`,
    );
  }

  const env = parseEnvFile(ENV_PATH);

  const groupChatName = (env.GROUP_CHAT_NAME || '').trim();
  if (!groupChatName) {
    throw new Error('.env: GROUP_CHAT_NAME is required (the exact name of your iMessage group).');
  }

  // The "outside player" (one player not in the group chat, who gets a private 1:1 reminder)
  // is OPTIONAL. Leave both values blank if everyone is in the group chat — the bot then just
  // posts the emoji to the group. To enable it, set both COLOR and PHONE.
  const rawColor = (env.OUTSIDE_PLAYER_COLOR || '').trim().toLowerCase();
  const rawHandle = (env.OUTSIDE_PLAYER_PHONE || '').trim(); // phone or iMessage email

  let outsidePlayerColor = null;
  if (rawColor || rawHandle) {
    if (!TURN_ORDER.includes(rawColor)) {
      throw new Error(
        `.env: OUTSIDE_PLAYER_COLOR must be one of ${TURN_ORDER.join(', ')} (got "${env.OUTSIDE_PLAYER_COLOR || ''}"). ` +
          `Leave the OUTSIDE_PLAYER_* values blank if everyone is in the group chat.`,
      );
    }
    if (!rawHandle) {
      throw new Error(
        '.env: OUTSIDE_PLAYER_PHONE is required when OUTSIDE_PLAYER_COLOR is set — the phone number ' +
          '(e.g. +15551234567) of the player not in the group chat. Leave both blank if everyone is in the group chat.',
      );
    }
    if (!rawHandle.includes('@') && !/^\+?\d{7,}$/.test(rawHandle)) {
      logError(
        `Warning: OUTSIDE_PLAYER_PHONE "${rawHandle}" doesn't look like a phone number; ` +
          `use full international format, e.g. +15551234567.`,
      );
    }
    outsidePlayerColor = rawColor;
  }

  // Assemble players: fixed emojis + names. The outside player's handle is stored
  // under `appleId` (Messages accepts a phone or email there).
  const players = {};
  for (const color of TURN_ORDER) {
    players[color] = { ...PLAYER_DEFAULTS[color], appleId: null };
  }
  if (outsidePlayerColor) {
    players[outsidePlayerColor].appleId = rawHandle;
  }

  // Build triggers: TRIGGER_RED, TRIGGER_GOLD, etc. (or defaults)
  const triggers = {};
  for (const color of TURN_ORDER) {
    const envKey = `TRIGGER_${color.toUpperCase()}`;
    triggers[color] = (env[envKey] || `${color} up`).trim().toLowerCase();
  }

  // AI completions (OPTIONAL). When an OPENAI_API_KEY is present (and AI_ENABLED
  // isn't turned off), a turn change ALSO asks the model a question and posts its
  // reply to the group. Leave OPENAI_API_KEY blank to disable entirely. The model
  // default is resolved in ai.js (DEFAULT_MODEL), so we keep the raw value here.
  const aiApiKey = (env.OPENAI_API_KEY || '').trim();
  const aiEnabledRaw = (env.AI_ENABLED || '').trim().toLowerCase();
  const aiEnabled = aiEnabledRaw === ''
    ? Boolean(aiApiKey) // default: on whenever a key is set
    : ['1', 'true', 'yes', 'on'].includes(aiEnabledRaw);
  // Sampling temperature (OPTIONAL). Higher = more varied wording. Only sent to the
  // API when set to a finite number — and note the GPT-5 family rejects it outright,
  // so this only helps on temperature-capable models (e.g. gpt-4o-mini, gpt-4.1-mini).
  const aiTemperatureRaw = (env.AI_TEMPERATURE || '').trim();
  const aiTemperature = aiTemperatureRaw === '' ? undefined : Number(aiTemperatureRaw);
  const ai = {
    enabled: aiEnabled,
    apiKey: aiApiKey,
    model: (env.OPENAI_MODEL || '').trim(), // '' → ai.js falls back to DEFAULT_MODEL
    temperature: Number.isFinite(aiTemperature) ? aiTemperature : undefined,
    // Prompt template sent on a turn change. `{team}` is filled with the active color's
    // display name (the per-turn "seed"); `{color}` with the raw color.
    prompt: (env.AI_PROMPT || '').trim() || "roast or boast {team}, it's up to you DJT",
    // Prompt template used on the recurring reminder ticks instead of `prompt` — a nag
    // about the player who still hasn't moved. Same `{team}`/`{color}` placeholders.
    reminderPrompt: (env.AI_REMINDER_PROMPT || '').trim() ||
      "we're STILL waiting on the low energy, SAD, WEAK {team} to move — we've NEVER seen anyone so lazy!",
    // RAG voice reference (DJT post corpus). Override with AI_CONTEXT_FILE
    // (.txt one-post-per-line, or .json/.jsonl with a content/visible_text field).
    contextFile: (env.AI_CONTEXT_FILE || '').trim() || RAG_PATH,
    // When true, before each AI post the bot reads everything OTHER players have said
    // in the group (and the outside player's 1:1) since its last post, and folds that
    // chatter into the prompt as extra context. Default off.
    captureChat: ['1', 'true', 'yes', 'on'].includes((env.AI_CAPTURE_CHAT || '').trim().toLowerCase()),
  };

  return {
    groupChatName,
    players,
    outsidePlayerColor, // null when everyone is in the group chat
    triggers,
    ai,
    reminderIntervalMinutes: Number(env.REMINDER_INTERVAL_MINUTES) || 60,
    pollIntervalMinutes: Number(env.POLL_INTERVAL_MINUTES) || 5,
  };
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
