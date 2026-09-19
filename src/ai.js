// Server-side AI gateway. Provider keys live in Railway variables, never in the bot.
// Providers are tried in AI_PROVIDER_ORDER; the first one that answers wins.
const TIMEOUT = Number(process.env.AI_TIMEOUT_MS || 60000);
const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 1024);
const AI_NAME = process.env.AI_NAME || 'MAHNGUELOH VANTA';
const AI_OWNER = process.env.AI_OWNER || 'MAHNGUELOH';

const DEFAULT_SYSTEM = process.env.AI_SYSTEM_PROMPT ||
  `You are ${AI_NAME}, an AI assistant built by ${AI_OWNER}. ` +
  `When asked who you are, say you are ${AI_NAME}. ` +
  `You are direct, genuinely useful and concise; technical when the question calls for it, casual otherwise. ` +
  `If someone sincerely asks whether you are an AI, say yes.`;

async function fetchJson(url, opts) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT) });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const err = new Error((data && (data.error?.message || data.error)) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Providers want strictly alternating turns starting with "user".
function normalizeHistory(history) {
  const out = [];
  for (const m of Array.isArray(history) ? history.slice(-20) : []) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n' + m.content;
    else out.push({ role, content: m.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (out.length && out[out.length - 1].role === 'user') out.pop(); // next turn is the new prompt (user)
  return out;
}

const providers = {
  gemini: {
    enabled: () => !!process.env.GEMINI_API_KEY,
    async run({ system, history, prompt }) {
      const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
      const contents = [
        ...history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        { role: 'user', parts: [{ text: prompt }] }
      ];
      const data = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents })
      });
      const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (!text) throw new Error('Empty response from Gemini');
      return { text, provider: 'gemini', model };
    }
  },
  anthropic: {
    enabled: () => !!process.env.ANTHROPIC_API_KEY,
    async run({ system, history, prompt }) {
      const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
      const data = await fetchJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, messages: [...history, { role: 'user', content: prompt }] })
      });
      const text = (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!text) throw new Error('Empty response from Claude');
      return { text, provider: 'anthropic', model };
    }
  },
  // Any OpenAI-compatible API: DeepSeek, Groq, OpenRouter, OpenAI...
  // e.g. COMPAT_BASE_URL=https://api.deepseek.com  COMPAT_MODEL=deepseek-chat  COMPAT_API_KEY=...
  compat: {
    enabled: () => !!(process.env.COMPAT_API_KEY && process.env.COMPAT_BASE_URL && process.env.COMPAT_MODEL),
    async run({ system, history, prompt }) {
      const model = process.env.COMPAT_MODEL;
      const base = process.env.COMPAT_BASE_URL.replace(/\/+$/, '');
      const data = await fetchJson(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.COMPAT_API_KEY}` },
        body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: prompt }] })
      });
      const text = (data?.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new Error('Empty response');
      return { text, provider: 'compat', model };
    }
  }
};

function order() {
  return (process.env.AI_PROVIDER_ORDER || 'gemini,anthropic,compat')
    .split(',').map(s => s.trim()).filter(n => providers[n]);
}
function configuredProviders() { return order().filter(n => providers[n].enabled()); }

async function chat({ prompt, system, history }) {
  const active = configuredProviders();
  if (!active.length) { const e = new Error('No AI provider is configured on the server'); e.status = 503; throw e; }
  const args = { prompt, system: (system && String(system).trim()) || DEFAULT_SYSTEM, history: normalizeHistory(history) };
  const failures = [];
  for (const name of active) {
    try { return await providers[name].run(args); }
    catch (e) { failures.push(`${name}: ${e.message}`); console.error(`[ai] ${name} failed:`, e.message); }
  }
  const e = new Error('All AI providers failed');
  e.status = 502;
  e.details = failures;
  throw e;
}

module.exports = { chat, configuredProviders };
