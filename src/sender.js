// sender.js — sends iMessages through the macOS Messages app via osascript.
//
// Two send paths:
//   • sendToGroup  — targets a group conversation by its display name.
//   • sendToHandle — targets a single person by Apple ID (email) or phone number.
//
// We use execFile (not exec) so user-controlled strings never touch a shell, and
// we only have to escape for AppleScript's own string syntax.
import { execFile } from 'node:child_process';
import { log, logError, macTimeNowNs } from './store.js';

// ── Bot-send registry ─────────────────────────────────────────────────────────
// The chat-capture feature reads messages back out of chat.db, where the bot's own
// automated sends and the owner's hand-typed messages BOTH show up as is_from_me=1 —
// indistinguishable by the database alone. So we record every message the bot sends
// (only the bot sends through this module) and let callers subtract those from what
// they capture, matching on identical text within a send-time window.
const botSends = [];
const BOT_SEND_TTL_NS = 6 * 60 * 60 * 1e9; // forget our sends after 6h
const BOT_SEND_MATCH_WINDOW_NS = 5 * 60 * 1e9; // ±5 min tolerance between send + chat.db date

/** Record one automated send so the capture path can later exclude it. */
function recordBotSend(text) {
  const trimmed = (text || '').trim();
  if (trimmed) botSends.push({ text: trimmed, at: macTimeNowNs() });
}

/**
 * True if the bot itself sent this exact text at about this time — i.e. it's an
 * automated emoji/AI post echoing back from chat.db, not a real person's message.
 * Owner-typed messages (different text, or the same text at a different time) pass through.
 */
export function wasSentByBot(text, dateNs) {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  const cutoff = macTimeNowNs() - BOT_SEND_TTL_NS;
  while (botSends.length && botSends[0].at < cutoff) botSends.shift(); // prune old entries
  return botSends.some(
    (s) => s.text === trimmed && Math.abs(s.at - dateNs) <= BOT_SEND_MATCH_WINDOW_NS,
  );
}

/** Escape a JS string so it's safe inside an AppleScript "double-quoted" literal. */
function escapeForAppleScript(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Run an AppleScript source string, resolving on success and rejecting on error. */
function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Send a message to a named group chat.
 *
 * Messages exposes chats by their `name` (the conversation's display name). We pick
 * the first chat whose name matches. If the group has no custom name set, give it one
 * in the Messages UI (Conversation → rename) so this can find it.
 */
export async function sendToGroup(groupChatName, message) {
  const name = escapeForAppleScript(groupChatName);
  const body = escapeForAppleScript(message);
  const script = `
tell application "Messages"
  set matches to (every chat whose name is "${name}")
  if (count of matches) is 0 then
    error "No iMessage chat named '${name}' was found. Open the group in Messages and confirm its name."
  end if
  send "${body}" to item 1 of matches
end tell`;

  try {
    await runAppleScript(script);
    recordBotSend(message);
    log(`Sent to group "${groupChatName}": ${message}`);
  } catch (err) {
    logError(`Failed to send to group "${groupChatName}": ${err.stderr || err.message}`);
    throw err;
  }
}

/**
 * Send a message to a single person by Apple ID (email) or phone number,
 * over the iMessage service.
 */
export async function sendToHandle(appleId, message) {
  const handle = escapeForAppleScript(appleId);
  const body = escapeForAppleScript(message);
  const script = `
tell application "Messages"
  set targetService to id of 1st account whose service type = iMessage
  set targetBuddy to participant "${handle}" of account id targetService
  send "${body}" to targetBuddy
end tell`;

  try {
    await runAppleScript(script);
    recordBotSend(message);
    log(`Sent to ${appleId}: ${message}`);
  } catch (err) {
    logError(`Failed to send to ${appleId}: ${err.stderr || err.message}`);
    throw err;
  }
}

export { escapeForAppleScript };
