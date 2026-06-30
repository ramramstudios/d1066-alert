// ai.js — OpenAI-style LLM completions for d1066-alert.
//
// This is a faithful port of tarot-chat's api/chat.js, trimmed to what this bot
// needs. The mechanism is identical:
//
//   1. A `context` object is assembled from a *matrix of conditions* (here: the
//      turn-change event — which color is up, whether they're the outside/DM
//      player, the configured question). tarot-chat's matrix keys on reading
//      phase, mode, astrology profile, knowledge base, etc.; the shape is the same.
//   2. That context is flattened into `instructions` (the system prompt) and
//      `input` (the user turn) by conditional assembly — each block is included
//      only when its condition holds, then `.filter(Boolean).join(...)`. This
//      mirrors tarot-chat's buildInstructions() / buildInput().
//   3. We POST { model, instructions, input } to the OpenAI Responses API with a
//      Bearer key (same endpoint and body shape tarot-chat uses).
//   4. We pull the text back out of the response with extractResponseText(), the
//      same output_text / output[].content[].text walk tarot-chat uses.
//
// No new dependencies: this relies on the global `fetch` (Node 18+, which the
// package's engines field already requires), exactly like tarot-chat.

import fs from 'node:fs';
import { RAG_PATH, logError } from './store.js';

const DEFAULT_MODEL = 'gpt-5-mini';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

// How many feed excerpts to fold into a single request as a voice anchor. Keeping
// this far below the corpus size means each fire samples a different subset, which is
// where the run-to-run variety comes from (alongside the model's roast/boast choice).
const RAG_SAMPLE_SIZE = 3;

// Cap each sampled post's length so a stray multi-paragraph post can't bloat a request.
const RAG_EXCERPT_MAX_CHARS = 600;

// Per-turn flavor. Each color may contribute a one-line "focus" the model is told
// about; absent entries are simply skipped. This is the d1066 analogue of
// tarot-chat's per-placement / per-mode context blocks — the conditional pieces
// the matrix selects from.
const TURN_FOCUS = {
  red: 'Red has the initiative this turn.',
  gold: 'Gold is consolidating this turn.',
  blue: 'Blue is maneuvering this turn.',
  silver: 'Silver is up this turn.',
};

/** AI replies are active only when explicitly enabled AND a key is present. */
export function isAiConfigured(config) {
  return Boolean(config?.ai?.enabled && config?.ai?.apiKey);
}

// Parsed RAG corpus, cached per file path so we read the (large) source once.
// Each usable post becomes { text, topics }.
const ragCache = new Map();

/** Normalize one corpus record (or raw text line) into a clean excerpt, or null to drop it. */
function toExcerpt(value) {
  // .txt lines arrive as strings; .json/.jsonl records as objects.
  const raw =
    typeof value === 'string'
      ? value
      : typeof value?.content === 'string'
        ? value.content
        : typeof value?.visible_text === 'string'
          ? value.visible_text
          : '';
  const text = raw.trim();
  // Skip empties, retweets, and bare links — none of them carry usable voice.
  if (!text || text.startsWith('RT @') || /^https?:\/\/\S+$/.test(text)) return null;
  const topics = Array.isArray(value?.topics) ? value.topics : [];
  return { text: text.slice(0, RAG_EXCERPT_MAX_CHARS), topics };
}

/**
 * Load the DJT post corpus used as a VOICE reference for the persona. Accepts a
 * plain-text feed (one post per line), a JSON array, or JSONL (one record per line);
 * records expose the post under `content` or `visible_text`. Tolerant of a missing or
 * garbled file: a bad corpus just means no style anchor, never a crash — the model
 * still answers in-character from the persona instructions alone.
 */
export function loadRagContext(filePath = RAG_PATH) {
  if (ragCache.has(filePath)) return ragCache.get(filePath);
  let entries = [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trimStart();
    let records;
    if (filePath.endsWith('.json') || trimmed.startsWith('[')) {
      // Whole-file JSON array.
      records = JSON.parse(raw);
    } else if (filePath.endsWith('.jsonl')) {
      // One JSON record per line.
      records = raw.split('\n').map((line) => {
        try {
          return JSON.parse(line.trim());
        } catch {
          return null;
        }
      });
    } else {
      // Plain text: one post per line.
      records = raw.split('\n');
    }
    entries = (Array.isArray(records) ? records : []).map(toExcerpt).filter(Boolean);
  } catch (err) {
    logError(`RAG context unreadable (${filePath}): ${err.message}. AI replies will use persona only.`);
    entries = [];
  }
  ragCache.set(filePath, entries);
  return entries;
}

/** Pick up to `count` excerpts at random — the seed of per-fire variety. */
export function sampleRag(entries, count = RAG_SAMPLE_SIZE) {
  if (!Array.isArray(entries) || entries.length <= count) return entries || [];
  const pool = [...entries];
  const picked = [];
  while (picked.length < count && pool.length) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return picked;
}

/** Capitalize a color into a team display name as a fallback (e.g. "gold" -> "Gold"). */
function titleCase(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Assemble the per-turn context for a turn-change/reminder (or a manual test). The
 * team color is the seed: it selects the team name folded into the prompt template
 * and rides along with a random sample of the RAG voice corpus. `color` may be null.
 */
export function buildTurnContext(color, config, phase = 'turn-change') {
  const player = (color && config?.players?.[color]) || {};
  const team = player.name || titleCase(color) || 'the table';
  // Recurring reminders nag the slow player; turn changes (and tests) roast-or-boast.
  const template =
    (phase === 'reminder' && config?.ai?.reminderPrompt) ||
    config?.ai?.prompt ||
    "roast or boast {team}, it's up to you DJT";
  const question = template
    .replace(/\{team\}/gi, team)
    .replace(/\{color\}/gi, color || '');
  return {
    phase,
    turn: color || null,
    team,
    emoji: player.emoji || '',
    isOutsidePlayer: Boolean(color) && color === config?.outsidePlayerColor,
    question,
    rag: sampleRag(loadRagContext(config?.ai?.contextFile)),
  };
}

/**
 * Build the system prompt by layering rules, the way tarot-chat's buildInstructions
 * falls back through its rule set. Blocks with no content drop out.
 */
export function buildInstructions(context) {
  const styleRefs = (context.rag || [])
    .map((e, i) => `  ${i + 1}. ${e.text}`)
    .join('\n');
  return [
    'You are Donald J. Trump, posting to an iMessage group that is playing the game Dragons of 1066.',
    'Write in your unmistakable Truth Social voice: blunt, boastful, heavy on superlatives, ALL-CAPS bursts, and exclamation points. Sign off as "President DJT".',
    'You decide whether to ROAST or BOAST the named team — entirely your call, mix it up.',
    'Output ONE short post (1–2 punchy sentences), plain text only: no markdown, no preamble, no quotation marks around the whole thing.',
    context.turn ? `It is currently the ${context.team} team's turn.` : '',
    styleRefs
      ? `Below are real posts of yours, provided ONLY so you match the cadence and tone. Do NOT reuse their subjects or current-events references — the only subject is the ${context.team} team:\n${styleRefs}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build the user input by the same conditional-assembly pattern as tarot-chat's
 * buildInput(): each line is included only when its condition holds, then joined.
 * The configured question is always last so it reads as the actual ask.
 */
export function buildInput(context) {
  const focus = context.turn ? TURN_FOCUS[context.turn] : '';
  return [
    context.phase ? `Event: ${context.phase}.` : '',
    context.turn ? `Active team: ${context.team} ${context.emoji}`.trim() : '',
    focus || '',
    context.isOutsidePlayer ? 'This player is playing from outside the group chat.' : '',
    '',
    context.question,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Pull the assistant text out of an OpenAI Responses API payload. Ported verbatim
 * from tarot-chat: prefer the flattened `output_text`, else walk `output[].content[]`.
 */
export function extractResponseText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  const output = Array.isArray(data.output) ? data.output : [];

  output.forEach((item) => {
    if (typeof item.text === 'string') parts.push(item.text);
    if (typeof item.content === 'string') parts.push(item.content);

    if (Array.isArray(item.content)) {
      item.content.forEach((content) => {
        if (typeof content.text === 'string') parts.push(content.text);
        if (typeof content.content === 'string') parts.push(content.content);
      });
    }
  });

  return parts.join('\n').trim();
}

/**
 * Run one completion. Builds instructions + input from `context`, POSTs to the
 * OpenAI Responses API, and returns { text, model, responseId }. Throws on any
 * HTTP error or empty output so the caller can log and fall back gracefully.
 */
export async function requestCompletion(context, config) {
  const ai = config?.ai || {};
  const model = ai.model || DEFAULT_MODEL;
  const instructions = buildInstructions(context);
  const input = buildInput(context);

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ai.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, instructions, input }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI request failed with ${response.status}`);
  }

  const text = extractResponseText(data);
  if (!text) {
    throw new Error('OpenAI returned no text output');
  }

  return { text, model: data.model || model, responseId: data.id || null };
}

export { DEFAULT_MODEL };
