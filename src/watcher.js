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

// Map of lowercase trigger phrase -> color. "<color> up" sets the turn to that color.
const TRIGGERS = TURN_ORDER.map((color) => ({ color, phrase: `${color} up` }));

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

/** Return the color whose trigger phrase appears latest in the text, or null. */
export function detectTrigger(text) {
  if (!text) return null;
  const haystack = text.toLowerCase();
  let best = null;
  let bestIndex = -1;
  for (const { color, phrase } of TRIGGERS) {
    const idx = haystack.lastIndexOf(phrase);
    if (idx > bestIndex) {
      bestIndex = idx;
      best = color;
    }
  }
  return best;
}

/** Resolve the readable text of a row from either the text column or attributedBody. */
function rowText(row) {
  if (row.text && row.text.trim()) return row.text;
  return decodeAttributedBody(row.attributedBody);
}

/**
 * Poll the group chat for messages newer than `sinceDate` (Mac-absolute ns).
 *
 * Returns { trigger, lastMessageDate }:
 *   trigger          — the color of the most recent trigger found, or null.
 *   lastMessageDate  — the highest message.date seen, to persist as the new cursor.
 *
 * Opening the DB can briefly fail if macOS has it locked; the caller decides
 * whether to retry on the next poll, so we surface errors by throwing.
 */
export function pollForTriggers(groupChatName, sinceDate) {
  let db;
  try {
    db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 4000');

    const rows = db
      .prepare(
        `SELECT m.ROWID    AS rowid,
                m.text     AS text,
                m.attributedBody AS attributedBody,
                m.date     AS date
           FROM message m
           JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
           JOIN chat c                ON c.ROWID        = cmj.chat_id
          WHERE c.display_name = ?
            AND m.date > ?
          ORDER BY m.date ASC`,
      )
      .all(groupChatName, sinceDate);

    let lastMessageDate = sinceDate;
    let trigger = null;

    for (const row of rows) {
      if (row.date > lastMessageDate) lastMessageDate = row.date;
      const detected = detectTrigger(rowText(row));
      if (detected) {
        trigger = detected; // ASC order => last match wins (most recent trigger)
        log(`Trigger detected: "${detected} up" in "${groupChatName}"`);
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
