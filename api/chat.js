// POST /api/chat — forwards a bounded conversation to Groq and returns the reply.
// The Groq key only ever lives in process.env on the server.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

export const LIMITS = Object.freeze({
  maxUserChars: 4000, // longest single message a user can send
  maxHistoryMessages: 20, // most recent messages kept as context
  maxHistoryChars: 24000, // total context budget (newest messages win)
  maxStoredMessageChars: 8000, // older/assistant messages are clipped to this
  maxBodyBytes: 200_000,
  upstreamTimeoutMs: 25_000,
  maxCompletionTokens: 2048,
});

const SYSTEM_PROMPT = [
  'You are Orbit, a friendly, general-purpose AI assistant.',
  'Help with questions on any topic, writing and editing, brainstorming, explaining concepts, and follow-up questions.',
  'Be clear and concise by default, and go deeper when the user asks.',
  'Use Markdown (short paragraphs, lists, tables, fenced code blocks) when it makes an answer easier to read.',
  'If you are unsure, or something may have changed since your training, say so instead of guessing.',
].join(' ');

class ClientError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function resolveModel() {
  const model = (process.env.GROQ_MODEL || '').trim();
  return /^[\w.:/-]{1,128}$/.test(model) ? model : DEFAULT_MODEL;
}

function readBody(req) {
  let body;
  try {
    body = req.body; // Vercel parses JSON bodies; accessing it can throw on bad JSON
  } catch {
    throw new ClientError(400, 'The request body is not valid JSON.');
  }
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      throw new ClientError(400, 'The request body is not valid JSON.');
    }
  }
  if (!body || typeof body !== 'object') throw new ClientError(400, 'Send a JSON body with a "messages" array.');
  if (JSON.stringify(body).length > LIMITS.maxBodyBytes) throw new ClientError(413, 'That request is too large. Start a new chat and try again.');
  return body;
}

export function boundHistory(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new ClientError(400, 'Send at least one message.');

  const recent = raw.slice(-LIMITS.maxHistoryMessages).map((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      throw new ClientError(400, 'Each message needs a role of "user" or "assistant" and text content.');
    }
    return { role: m.role, content: m.content.trim() };
  }).filter((m) => m.content);

  const last = recent[recent.length - 1];
  if (!last || last.role !== 'user') throw new ClientError(400, 'The last message must be a non-empty user message.');
  if (last.content.length > LIMITS.maxUserChars) {
    throw new ClientError(400, `Messages are limited to ${LIMITS.maxUserChars.toLocaleString('en-US')} characters.`);
  }

  // Walk backwards from the newest message, keeping as much context as fits the budget.
  const kept = [last];
  let total = last.content.length;
  for (let i = recent.length - 2; i >= 0; i--) {
    const content = recent[i].content.slice(0, LIMITS.maxStoredMessageChars);
    if (total + content.length > LIMITS.maxHistoryChars) break;
    total += content.length;
    kept.unshift({ role: recent[i].role, content });
  }
  // Start the context on a user turn so the model never sees an orphaned reply first.
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
  return kept;
}

function upstreamError(status, data, model) {
  const code = data?.error?.code || '';
  const detail = typeof data?.error?.message === 'string' ? data.error.message.slice(0, 300) : '';
  if (status === 401 || status === 403) {
    return [502, { error: 'Groq rejected the API key. Check GROQ_API_KEY in your environment variables.' }];
  }
  if (status === 429) {
    return [429, { error: 'Groq’s rate limit was reached. Wait a few seconds and try again.' }];
  }
  if (status === 404 || /model_(not_found|decommissioned)/.test(code)) {
    return [502, { error: `The model “${model}” isn’t available on Groq. Set GROQ_MODEL to a supported model.` }];
  }
  if (code === 'context_length_exceeded') {
    return [400, { error: 'This conversation is too long for the model. Start a new chat and try again.' }];
  }
  if (status >= 500) {
    return [502, { error: 'Groq is having trouble right now. Please try again in a moment.' }];
  }
  return [502, { error: detail ? `Groq couldn’t complete the request: ${detail}` : 'Groq couldn’t complete the request.' }];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Use POST to send a message.' });
  }

  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) {
    return send(res, 500, { error: 'The server is missing GROQ_API_KEY. Add it as an environment variable and redeploy.' });
  }

  let history;
  try {
    history = boundHistory(readBody(req).messages);
  } catch (err) {
    if (err instanceof ClientError) return send(res, err.status, { error: err.message });
    throw err;
  }

  const model = resolveModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.upstreamTimeoutMs);

  try {
    const upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
        temperature: 0.7,
        max_completion_tokens: LIMITS.maxCompletionTokens,
      }),
      signal: controller.signal,
    });
    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      console.error(`Groq error ${upstream.status}:`, data?.error?.code || data?.error?.message || 'unknown');
      const [status, payload] = upstreamError(upstream.status, data, model);
      return send(res, status, payload);
    }

    const choice = data?.choices?.[0];
    const reply = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
    if (!reply) return send(res, 502, { error: 'Groq returned an empty response. Please try again.' });

    return send(res, 200, { reply, model: data.model || model, truncated: choice.finish_reason === 'length' });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return send(res, 504, { error: 'Groq took too long to respond. Please try again.' });
    }
    console.error('Groq request failed:', err?.message || err);
    return send(res, 502, { error: 'Couldn’t reach Groq. Check your connection and try again.' });
  } finally {
    clearTimeout(timer);
  }
}
