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

const DEFAULT_MODEL = 'gpt-5-mini';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

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

/**
 * Assemble the per-turn context — the inputs to the matrix of conditions — for a
 * turn-change (or a manual test). `color` may be null (no active turn yet).
 */
export function buildTurnContext(color, config, phase = 'turn-change') {
  const player = (color && config?.players?.[color]) || {};
  return {
    phase,
    turn: color || null,
    emoji: player.emoji || '',
    isOutsidePlayer: Boolean(color) && color === config?.outsidePlayerColor,
    question: config?.ai?.prompt || '1+2=?',
  };
}

/**
 * Build the system prompt by layering rules, the way tarot-chat's buildInstructions
 * falls back through its rule set. Blocks with no content drop out.
 */
export function buildInstructions(context) {
  return [
    'You are the Dragons of 1066 turn herald, a terse assistant wired into an iMessage game group.',
    'Answer the question you are given directly and briefly: a single short line, plain text, no markdown, no preamble.',
    context.turn ? `It is currently ${context.turn}'s turn.` : '',
  ]
    .filter(Boolean)
    .join(' ');
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
    context.turn ? `Active player: ${context.turn} ${context.emoji}`.trim() : '',
    focus || '',
    context.isOutsidePlayer ? 'This player is playing from outside the group chat.' : '',
    '',
    `Question: ${context.question}`,
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
