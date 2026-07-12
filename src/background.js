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

2. ai_slop_score — likelihood this is low-effort AI-generated content-farm output.
   Signals: generic phrasing, hollow superlatives, repetitive filler, listicle padding,
   factual vagueness, unnatural narration cadence, scripts that never commit to a
   specific claim. 0 = clearly a human with a point of view. 100 = certain slop.

3. readability_score — how fully the video's essence survives being turned into a
   short written distillation. Talky, information-dense videos score high; vibes,
   performances, and visual demonstrations score low.

Verdict rules:
- "watch": genuinely visual AND worth the time (high watch_score, low ai_slop_score).
- "read": informative but not visual — the viewer should read your distillation and reclaim the time.
- "skip": low value, redundant, or slop.

If top comments are provided, use them as a cross-check on your scores: commenters
reliably call out AI voices, stolen/re-uploaded content, factual errors, and clickbait —
and specific, substantive discussion is evidence of genuine content. Report this in
community_check: whether the comments support your assessment, and a short note on
what they add or contradict. If no comments are provided, omit community_check.

If the transcript is missing, judge only from metadata, say so, and keep scores conservative.

Respond with ONLY a JSON object, no markdown fences, exactly this shape:
{
  "watch_score": <0-100>,
  "ai_slop_score": <0-100>,
  "readability_score": <0-100>,
  "verdict": "watch" | "read" | "skip",
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
  if (!['watch', 'read', 'skip'].includes(analysis.verdict)) {
    throw new Error('model returned invalid verdict');
  }
  return analysis;
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
    return { error: `Anthropic API: ${detail}` };
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
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).error?.message || detail; } catch { /* keep */ }
    return { error: `Groq API: ${detail}` };
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

async function analyze(payload) {
  const settings = payload.settings || {};
  const { apiKey, model } = settings;
  if (!apiKey) return { error: 'No API key configured' };
  const provider = providerOf(settings);

  const out = await completeFor(provider)(
    { apiKey, model },
    { system: SYSTEM_PROMPT, user: buildUserContent(payload), maxTokens: 900 }
  );
  if (out.error) return { error: out.error };
  try {
    const analysis = parseAnalysis(out.text);
    // Deterministic guards — model-independent, so smaller open models can't drift:
    // read_instead only belongs on a "read" verdict; community_check only when we
    // actually sent comments (otherwise weaker models invent comment sentiment).
    if (analysis.verdict !== 'read') analysis.read_instead = '';
    if (!payload.comments?.length) delete analysis.community_check;
    return { analysis };
  } catch (e) {
    return { error: e.message };
  }
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
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// First install → open the onboarding once.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
  }
});
