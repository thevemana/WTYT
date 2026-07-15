// WTYT — background service worker. Owns the LLM call so the API key never touches
// page context and CORS is a non-issue (host_permissions cover it).
// Supports two providers — Anthropic (Claude) and Groq (open models: GPT-OSS, Llama).
// Same prompt, same JSON contract; only the HTTP shape differs per provider.
// Groq is OpenAI-compatible and has a usable free tier, so it's the no-paid-key path.

const SYSTEM_PROMPT = `You are WTYT (Watch The YouTube Things), a ruthless triage assistant. Given a YouTube video's metadata, transcript, and (sometimes) its top comments, you decide whether a time-poor viewer should WATCH it, READ a distillation instead, or SKIP it.

Score on three axes, each 0-100:

1. watch_score — how much the video's value depends on actually WATCHING it.
   0 = an essay read aloud over a static image or stock b-roll; nothing visual matters.
   100 = a visual masterpiece where the visuals carry meaning that prose cannot
   (think "Every Frame a Painting", a Pale Blue Dot-style piece, precision sports
   breakdowns with on-screen annotation). Content that needs visual detail for
   understanding scores high.

2. generic_score — how generic and low-effort the content is, regardless of who or what
   made it. This measures QUALITY, not authorship. Signals: hollow superlatives, listicle
   padding, factual vagueness, filler that pads runtime, unnatural cadence, scripts that
   never commit to a specific claim, interchangeable "content" with no point of view.
   0 = a specific, substantive piece with a real point of view (a lazy human video still
   scores high here; a sharp AI-assisted one scores low). 100 = interchangeable filler.

3. readability_score — how fully the video's essence survives being turned into a
   short written distillation. Talky, information-dense videos score high; vibes,
   performances, and visual demonstrations score low.

Then judge two more things:

4. ai_provenance + ai_confidence — was this made by a human, made WITH ai assistance, or
   fully AI-GENERATED? Return ai_provenance: "human" | "ai_assisted" | "ai_generated".
   Detecting this from a transcript is HARD and easy to get wrong. Only set
   ai_confidence:"high" when MULTIPLE strong signals agree (unmistakable synthetic-voice
   cadence, telltale generic-AI phrasing, and a total absence of lived human specificity).
   Use "med" when some signals point that way but you are not sure; use "low" when there is
   little to go on. Only "high" is ever shown to the user, so reserve it. When unsure, return
   "human" with ai_confidence:"low" — a wrong "AI-generated" label is far worse than a missed one.

5. is_music — true if this is primarily a music video, song, live set, or performance where
   the point is to LISTEN, not watch or read. If true, set verdict "listen".

Verdict rules:
- "watch": genuinely visual AND worth the time (high watch_score, low generic_score).
- "read": informative but not visual — the viewer should read your distillation and reclaim the time.
- "listen": primarily music/audio — just listen; watchability and readability don't apply.
- "skip": low value, redundant, or generic filler.

If top comments are provided, use them as a cross-check on your scores: commenters
reliably call out AI voices, stolen/re-uploaded content, factual errors, and clickbait —
and specific, substantive discussion is evidence of genuine content. Report this in
community_check: whether the comments support your assessment, and a short note on
what they add or contradict. If no comments are provided, omit community_check.

If the transcript is missing, judge only from metadata, say so, and keep scores conservative.

Respond with ONLY a JSON object, no markdown fences, exactly this shape:
{
  "watch_score": <0-100>,
  "generic_score": <0-100>,
  "readability_score": <0-100>,
  "ai_provenance": "human" | "ai_assisted" | "ai_generated",
  "ai_confidence": "low" | "med" | "high",
  "is_music": <boolean>,
  "verdict": "watch" | "read" | "listen" | "skip",
  "one_liner": "<max 120 chars: what this video is and why the verdict>",
  "key_takeaways": ["<2-4 short bullets of the actual substance>"],
  "read_instead": "<3-5 sentence distillation IF verdict is read, else empty string>",
  "community_check": { "agrees": <boolean>, "note": "<max 140 chars>" }
}`;

// ---- provider routing ---------------------------------------------------------

// Anthropic model IDs all start with "claude"; everything else routes to Groq.
// Robust against a stale saved provider (e.g. a pre-swap "gemini") — derive from the model.
function providerOf(settings) {
  const p = settings.provider;
  if (p === 'anthropic' || p === 'groq') return p;
  return String(settings.model || '').startsWith('claude') ? 'anthropic' : 'groq';
}

function buildUserContent(payload) {
  const v = payload.video || {};
  const lines = [
    `Title: ${v.title || 'unknown'}`,
    `Channel: ${v.channel || 'unknown'}`,
    `Duration: ${v.duration || 'unknown'}`,
    `Views: ${v.viewsText || 'unknown'}`,
    '',
  ];
  if (payload.transcript?.text) {
    lines.push(`Transcript (${payload.transcript.source}):`, payload.transcript.text);
  } else {
    lines.push('TRANSCRIPT UNAVAILABLE — judge from metadata only.');
  }
  if (payload.comments?.length) {
    lines.push('', `Top ${payload.comments.length} comments (with like counts):`);
    for (const c of payload.comments) {
      lines.push(`- [${c.likes} likes] ${String(c.text).slice(0, 300)}`);
    }
  }
  return lines.join('\n');
}

function parseAnalysis(text) {
  let raw = (text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('model returned no JSON');
  const analysis = JSON.parse(raw.slice(start, end + 1));
  if (!['watch', 'read', 'listen', 'skip'].includes(analysis.verdict)) {
    throw new Error('model returned invalid verdict');
  }
  // Normalize the provenance fields so a drifting open model can't break the contract.
  if (!['human', 'ai_assisted', 'ai_generated'].includes(analysis.ai_provenance)) {
    analysis.ai_provenance = 'human';
  }
  if (!['low', 'med', 'high'].includes(analysis.ai_confidence)) {
    analysis.ai_confidence = 'low';
  }
  // Small open models sometimes emit a stringified boolean; treat "true" as true.
  analysis.is_music = analysis.is_music === true || analysis.is_music === 'true';
  return analysis;
}

// A secondary "and also…" tag needs a stronger score than the 60 used for color-coding —
// only flag a genuinely strong cross-axis, not a merely-decent one.
const SECONDARY_THRESHOLD = 65;

// Deterministic post-processing applied to every model response so the analysis contract
// holds regardless of which (possibly small, possibly drifting) model produced it.
function finalizeAnalysis(analysis, payload) {
  // Music → LISTEN: watch/read/generic axes don't apply, so null them out.
  if (analysis.is_music) analysis.verdict = 'listen';
  if (analysis.verdict === 'listen') {
    analysis.is_music = true;
    analysis.watch_score = null;
    analysis.readability_score = null;
    analysis.generic_score = null;
  }
  // read_instead only belongs on a "read" verdict; community_check only when we actually
  // sent comments (otherwise weaker models invent comment sentiment).
  if (analysis.verdict !== 'read') analysis.read_instead = '';
  if (!payload.comments?.length) delete analysis.community_check;
  // Secondary tag computed here, not asked of the model — drift-proof across providers.
  // cards.js maps these values to labels; keep the two in sync.
  analysis.secondary_tag = null;
  if (analysis.verdict === 'watch' && Number(analysis.readability_score) >= SECONDARY_THRESHOLD) {
    analysis.secondary_tag = 'strong_read';
  } else if (analysis.verdict === 'read' && Number(analysis.watch_score) >= SECONDARY_THRESHOLD) {
    analysis.secondary_tag = 'watchable';
  }
  return analysis;
}

// ---- retry helpers -----------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pull a retry delay from a 429: prefer the Retry-After header (seconds), else parse
// Groq's "Please try again in 7.3s" out of the error message. Returns ms (0 if none).
function parseRetryAfter(header, message) {
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  const m = /try again in ([\d.]+)\s*s/i.exec(message || '');
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
}

// ---- Anthropic ---------------------------------------------------------------

async function anthropicComplete({ apiKey, model }, { system, user, maxTokens, probe }) {
  const body = probe
    ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
    : { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).error?.message || detail; } catch { /* keep */ }
    return { error: `Anthropic API: ${detail}`, status: res.status, retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), detail) };
  }
  if (probe) return { ok: true };
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text };
}

// ---- Groq (OpenAI-compatible) ------------------------------------------------

async function groqComplete({ apiKey, model }, { system, user, maxTokens, probe }) {
  const body = probe
    ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
    : {
        model,
        max_tokens: maxTokens,
        temperature: 0.4,
        // Native JSON mode — Groq enforces valid JSON, so parsing is reliable.
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      };
  // gpt-oss is a reasoning model: without a low reasoning budget it spends the whole token
  // ceiling "thinking" and never emits the JSON (Groq then 400s with failed_generation).
  // Cap reasoning and give the body room to finish the object.
  if (!probe && /gpt-oss/.test(model)) {
    body.reasoning_effort = 'low';
    body.max_tokens = Math.max(maxTokens, 1400);
  }
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).error?.message || detail; } catch { /* keep */ }
    return { error: `Groq API: ${detail}`, status: res.status, retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), detail) };
  }
  if (probe) return { ok: true };
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  return { text };
}

function completeFor(provider) {
  return provider === 'groq' ? groqComplete : anthropicComplete;
}

// ---- orchestration -----------------------------------------------------------

// Free-tier open models fail in two recoverable ways: Groq rate-limits (429, with a
// "try again in Ns" the response tells us), and small models occasionally emit malformed
// JSON. Both clear on a short retry, so back off and try again rather than surfacing a raw
// error — the free path is the default, so it has to survive these.
const MAX_RETRIES = 2;
const MAX_BACKOFF_MS = 30000; // honor Groq's rate-limit waits (seen up to ~24s), but not absurd ones

// Groq's free tier caps tokens per DAY per model (e.g. ~100k on the 70B). When the chosen
// model is tapped out for the day — a 429 whose wait we won't sit through — fall through this
// chain to a model that still has budget, so the free path keeps working. Best judgment first.
const GROQ_FALLBACK = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'];

async function analyze(payload) {
  const settings = payload.settings || {};
  const { apiKey } = settings;
  if (!apiKey) return { error: 'No API key configured' };
  const provider = providerOf(settings);
  const complete = completeFor(provider);
  const req = { system: SYSTEM_PROMPT, user: buildUserContent(payload), maxTokens: 900 };

  // Only Groq gets a model chain; Anthropic just uses the chosen model.
  const chain = provider === 'groq'
    ? [settings.model, ...GROQ_FALLBACK.filter((m) => m !== settings.model)]
    : [settings.model];

  let lastError = 'Analysis failed';
  for (let mi = 0; mi < chain.length; mi++) {
    const model = chain[mi];
    let rateLimited = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const out = await complete({ apiKey, model }, req);
      if (out.error) {
        lastError = out.error;
        // Short window (per-minute limit): wait it out and retry the SAME model.
        if (out.status === 429 && out.retryAfterMs && out.retryAfterMs <= MAX_BACKOFF_MS && attempt < MAX_RETRIES) {
          await sleep(out.retryAfterMs + 250);
          continue;
        }
        // Long/again rate-limit (daily cap): don't wait — drop to the next model in the chain.
        if (out.status === 429) { rateLimited = true; break; }
        return { error: out.error };
      }
      try {
        const analysis = finalizeAnalysis(parseAnalysis(out.text), payload);
        if (model !== settings.model) analysis.model_fallback = model; // note the swap for the UI
        return { analysis };
      } catch (e) {
        lastError = e.message;
        if (attempt < MAX_RETRIES) { await sleep(400); continue; } // malformed JSON — retry
        return { error: lastError };
      }
    }
    if (!rateLimited) break; // a non-rate-limit failure won't be fixed by switching models
  }
  return { error: lastError };
}

// Cheapest possible round-trip to prove a key + model actually work.
async function testKey({ apiKey, model, provider }) {
  if (!apiKey) return { ok: false, error: 'No key provided' };
  const p = (provider === 'anthropic' || provider === 'groq')
    ? provider
    : (String(model || '').startsWith('claude') ? 'anthropic' : 'groq');
  const out = await completeFor(p)({ apiKey, model }, { probe: true });
  if (out.ok) return { ok: true };
  return { ok: false, error: out.error || 'Key test failed' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'analyze') {
    analyze(msg.payload).then(sendResponse).catch((e) => sendResponse({ error: String(e.message || e) }));
    return true; // async response
  }
  if (msg.type === 'testKey') {
    testKey(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async response
  }
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
  if (msg.type === 'openNotes') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/notes.html') });
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// First install → open the onboarding once.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
  }
});
