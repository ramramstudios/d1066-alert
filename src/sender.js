// sender.js — sends iMessages through the macOS Messages app via osascript.
//
// Two send paths:
//   • sendToGroup  — targets a group conversation by its display name.
//   • sendToHandle — targets a single person by Apple ID (email) or phone number.
//
// We use execFile (not exec) so user-controlled strings never touch a shell, and
// we only have to escape for AppleScript's own string syntax.
import { execFile } from 'node:child_process';
import { log, logError } from './store.js';

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
    log(`Sent to ${appleId}: ${message}`);
  } catch (err) {
    logError(`Failed to send to ${appleId}: ${err.stderr || err.message}`);
    throw err;
  }
}

export { escapeForAppleScript };
