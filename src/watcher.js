// watcher.js — polls the Messages SQLite database for turn-change trigger words.
//
// We open ~/Library/Messages/chat.db READ-ONLY and never write to it. On modern
// macOS the human-readable text often lives in the `attributedBody` blob (a
// typedstream) rather than the `text` column, so we decode that as a fallback.
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { TURN_ORDER, macTimeNowNs, log, logError } from './store.js';

export const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');


/**
 * Best-effort decode of a Messages `attributedBody` typedstream blob.
 *
 * The message text is stored after the "NSString" class marker, introduced by a
 * `+` (0x2B) "C-string" type byte, followed by a typedstream-encoded length and
 * the UTF-8 bytes. This covers ordinary text messages (and certainly the short
 * trigger phrases we care about). If anything looks off we return null — a failed
 * decode just means "no trigger", which is safe.
 */
export function decodeAttributedBody(buffer) {
  if (!buffer || buffer.length === 0) return null;
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  const marker = data.indexOf('NSString', 0, 'latin1');
  if (marker === -1) return null;

  let p = data.indexOf(0x2b, marker); // first '+' after NSString
  if (p === -1) return null;
  p += 1;
  if (p >= data.length) return null;

  let length = data[p];
  p += 1;
  if (length === 0x81) {
    if (p + 2 > data.length) return null;
    length = data.readUInt16LE(p);
    p += 2;
  } else if (length === 0x82) {
    if (p + 4 > data.length) return null;
    length = data.readUInt32LE(p);
    p += 4;
  }
  if (length <= 0 || p + length > data.length) return null;

  return data.slice(p, p + length).toString('utf8');
}

/**
 * Return the color whose trigger phrase matches the entire message, or null.
 * The trigger phrase must be (nearly) the only thing in the message — leading/trailing
 * whitespace and trailing punctuation are stripped. E.g. "Red up!" and "  red up  " match,
 * but "red up please" doesn't.
 * @param {string} text The message text to scan.
 * @param {Object} triggers Map of color -> trigger phrase (e.g. { red: "red up", gold: "gold up", ... }).
 */
export function detectTrigger(text, triggers) {
  if (!text || !triggers) return null;
  // Normalize: trim, strip trailing punctuation, lowercase.
  let normalized = text.trim().replace(/[!?.,:;]*$/, '').toLowerCase();
  if (!normalized) return null;

  for (const color of TURN_ORDER) {
    const phrase = triggers[color];
    if (!phrase || normalized !== phrase.toLowerCase()) continue;
    return color;
  }
  return null;
}

/** Resolve the readable text of a row from either the text column or attributedBody. */
function rowText(row) {
  if (row.text && row.text.trim()) return row.text;
  return decodeAttributedBody(row.attributedBody);
}

/**
 * Poll the group chat for messages newer than `sinceDate` (Mac-absolute ns).
 *
 * @param {string} groupChatName The display name of the iMessage group.
 * @param {number} sinceDate Mac-absolute nanoseconds; only scan messages after this.
 * @param {Object} triggers Map of color -> trigger phrase (e.g. { red: "red up", ... }).
 * @param {string|null} outsidePlayerHandle Phone/email of the outside player's 1:1 thread (optional).
 * Returns { trigger, lastMessageDate }:
 *   trigger          — the color of the most recent trigger found, or null.
 *   lastMessageDate  — the highest message.date seen across all sources, to persist as cursor.
 *
 * Opening the DB can briefly fail if macOS has it locked; the caller decides
 * whether to retry on the next poll, so we surface errors by throwing.
 */
export function pollForTriggers(groupChatName, sinceDate, triggers, outsidePlayerHandle = null) {
  let db;
  try {
    db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 4000');

    // Query 1: group chat, matched by display_name.
    const groupRows = db
      .prepare(
        `SELECT m.text AS text, m.attributedBody AS attributedBody, m.date AS date
           FROM message m
           JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
           JOIN chat c                ON c.ROWID        = cmj.chat_id
          WHERE c.display_name = ?
            AND m.date > ?
          ORDER BY m.date ASC`,
      )
      .all(groupChatName, sinceDate);

    // Query 2: outside player's 1:1 thread, matched by handle (phone or email).
    const dmRows = outsidePlayerHandle
      ? db
          .prepare(
            `SELECT m.text AS text, m.attributedBody AS attributedBody, m.date AS date
               FROM message m
               JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
               JOIN chat c                ON c.ROWID        = cmj.chat_id
               JOIN chat_handle_join chj  ON chj.chat_id    = c.ROWID
               JOIN handle h              ON h.ROWID        = chj.handle_id
              WHERE h.id   = ?
                AND m.date > ?
              ORDER BY m.date ASC`,
          )
          .all(outsidePlayerHandle, sinceDate)
      : [];

    // Merge both sources and sort by date so the last trigger seen wins.
    const allRows = [...groupRows, ...dmRows].sort((a, b) => a.date - b.date);

    let lastMessageDate = sinceDate;
    let trigger = null;

    for (const row of allRows) {
      if (row.date > lastMessageDate) lastMessageDate = row.date;
      const detected = detectTrigger(rowText(row), triggers);
      if (detected) {
        trigger = detected;
        log(`Trigger detected: "${triggers[detected]}"`);
      }
    }

    return { trigger, lastMessageDate };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

/**
 * Collect the readable text of every message sent since `sinceDate` — used by the
 * optional AI chat-capture feature to give the model recent context.
 *
 * Captures ALL messages, including the owner's own (is_from_me=1), and returns each
 * one's date so the caller can subtract the bot's own automated sends (which are also
 * is_from_me=1 and indistinguishable here) via sender.wasSentByBot. Reads the group
 * chat and, if configured, the outside player's 1:1 thread, like pollForTriggers.
 *
 * @param {string} groupChatName The display name of the iMessage group.
 * @param {number} sinceDate Mac-absolute nanoseconds; only collect messages after this.
 * @param {string|null} outsidePlayerHandle Phone/email of the outside player's 1:1 thread (optional).
 * Returns { messages, lastMessageDate }:
 *   messages         — array of { text, date } objects, oldest first.
 *   lastMessageDate  — the highest message.date seen, to advance the capture cursor.
 */
export function collectRecentMessages(groupChatName, sinceDate, outsidePlayerHandle = null) {
  let db;
  try {
    db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 4000');

    const groupRows = db
      .prepare(
        `SELECT m.text AS text, m.attributedBody AS attributedBody, m.date AS date
           FROM message m
           JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
           JOIN chat c                ON c.ROWID        = cmj.chat_id
          WHERE c.display_name = ?
            AND m.date > ?
          ORDER BY m.date ASC`,
      )
      .all(groupChatName, sinceDate);

    const dmRows = outsidePlayerHandle
      ? db
          .prepare(
            `SELECT m.text AS text, m.attributedBody AS attributedBody, m.date AS date
               FROM message m
               JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
               JOIN chat c                ON c.ROWID        = cmj.chat_id
               JOIN chat_handle_join chj  ON chj.chat_id    = c.ROWID
               JOIN handle h              ON h.ROWID        = chj.handle_id
              WHERE h.id   = ?
                AND m.date > ?
              ORDER BY m.date ASC`,
          )
          .all(outsidePlayerHandle, sinceDate)
      : [];

    const allRows = [...groupRows, ...dmRows].sort((a, b) => a.date - b.date);

    let lastMessageDate = sinceDate;
    const messages = [];
    for (const row of allRows) {
      if (row.date > lastMessageDate) lastMessageDate = row.date;
      const text = rowText(row);
      if (text && text.trim()) messages.push({ text: text.trim(), date: row.date });
    }

    return { messages, lastMessageDate };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

/**
 * Establish the starting cursor so we never replay old history on first run.
 * Returns a Mac-absolute-ns timestamp for "now".
 */
export function initialCursor() {
  const now = macTimeNowNs();
  log('No message cursor yet — starting from now; only new messages will be processed.');
  return now;
}

/** Quick connectivity check used by --send-test / startup diagnostics. */
export function checkDbAccess() {
  try {
    const db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
    db.prepare('SELECT 1').get();
    db.close();
    return true;
  } catch (err) {
    logError(
      `Cannot read chat.db (${err.message}). ` +
        `Grant this app/terminal Full Disk Access in System Settings → Privacy & Security.`,
    );
    return false;
  }
}
