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
  return { text, usage: { in: data.usage?.input_tokens || 0, out: data.usage?.output_tokens || 0 } };
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
  return { text, usage: { in: data.usage?.prompt_tokens || 0, out: data.usage?.completion_tokens || 0 } };
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

// ---- proactive TPM pacing (0.6.0 stage 1.1) ----------------------------------
// Groq's free tier also caps tokens-per-MINUTE per model, and auto-scoring a scrolling feed
// fires faster than that — the 0.5.0 load-test hit 39 rate-limit failures. Instead of firing
// until a 429, we gate each Groq call to stay under the per-minute budget: a per-model sliding
// 60s ledger holds recent (estimated, then reconciled) spend; a call waits until it fits. This
// trades speed (~4-6 videos/min on free Groq — the tier's hard ceiling) for zero 429s. The
// content engine's workers back-pressure naturally while a gated call is pending. Anthropic is
// paid with far higher limits, so it is never paced.
const TPM_BUDGET = {
  'llama-3.3-70b-versatile': 12000,
  'openai/gpt-oss-120b': 8000,
  'llama-3.1-8b-instant': 6000,
};
const TPM_WINDOW_MS = 60000;
const TPM_SAFETY = 0.9; // leave headroom so an under-estimate can't tip us over the real cap

const tpmLedger = {}; // model -> [{ at, tokens }] within the trailing window

// Rough pre-call cost: ~4 chars/token in, plus the output ceiling (gpt-oss reserves more).
function estimateTokens(req, model) {
  const chars = (req.system?.length || 0) + (req.user?.length || 0);
  const out = /gpt-oss/.test(model) ? 1400 : req.maxTokens || 900;
  return Math.ceil(chars / 4) + out;
}

function ledgerTokens(model, now) {
  const kept = (tpmLedger[model] || []).filter((e) => now - e.at < TPM_WINDOW_MS);
  tpmLedger[model] = kept;
  return kept.reduce((s, e) => s + e.tokens, 0);
}

// Wait until an est-cost call fits under the model's paced budget, then reserve it (so
// concurrent callers see the reservation immediately). Returns the ledger entry to reconcile
// to actual usage, or null for unpaced models / if we gave up waiting. A single call larger
// than the whole cap is let through alone once the window has drained.
async function awaitTokenBudget(model, estTokens, skipWait) {
  const budget = TPM_BUDGET[model];
  if (!budget) return null;
  const cap = budget * TPM_SAFETY;
  for (let guard = 0; guard < 240; guard++) {
    const now = Date.now();
    const used = ledgerTokens(model, now);
    // skipWait: an interactive (watch) call — reserve its spend so the feed pacer accounts for
    // it, but never make the user's clicked-into video wait behind bulk feed scoring.
    if (skipWait || used === 0 || used + estTokens <= cap) {
      const entry = { at: now, tokens: estTokens };
      (tpmLedger[model] = tpmLedger[model] || []).push(entry);
      return entry;
    }
    const oldest = tpmLedger[model][0];
    const wait = oldest ? Math.max(250, TPM_WINDOW_MS - (now - oldest.at) + 50) : 250;
    await sleep(Math.min(wait, 5000));
  }
  return null;
}

// Replace the reserved estimate with the real token count once the call returns. A failed call
// (429/error, no usage) contributes 0: it didn't spend real per-minute throughput, so it must not
// fill the pacing budget — otherwise a failing key (e.g. daily-cap 429s) accumulates phantom
// reservations and throttles every retry into a 60s wait, which reads as "hung, not scoring."
// Per-minute 429s are still handled by the reactive retry-after backoff in analyze(), not here.
function reconcileReservation(entry, out) {
  if (!entry) return;
  entry.tokens = out && out.usage ? (out.usage.in || 0) + (out.usage.out || 0) : 0;
}

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
      const reservation = await awaitTokenBudget(model, estimateTokens(req, model), payload.interactive);
      const out = await complete({ apiKey, model }, req);
      reconcileReservation(reservation, out);
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
        recordMetric('tokens', { provider, tin: out.usage?.in || 0, tout: out.usage?.out || 0 });
        // Track the model that actually spent (may be a fallback) against today's free-tier cap.
        if (provider === 'groq') recordDailyUsage(model, (out.usage?.in || 0) + (out.usage?.out || 0));
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

// ---- usage metrics (0.5.0) ---------------------------------------------------
// Opt-in, counts + tokens only, no content. Every write funnels through recordMetric so
// this single background context serializes the read-modify-write (the opChain mutex) —
// several tabs firing page-views/tokens/clicks at once can't clobber each other's
// increments. src/metrics.js is the thin client that forwards events here.

const M_PREFIX = 'wtytm:';
const M_CURRENT = M_PREFIX + 'current';
const M_INSTALL = M_PREFIX + 'install';
const SESSION_IDLE_MS = 30 * 60 * 1000; // new session after 30 min idle (industry standard)
const SURFACES = ['home', 'search', 'watch', 'playlist', 'other'];

const sget = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
const sset = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));
const srem = (keys) => new Promise((r) => chrome.storage.local.remove(keys, r));

// Serialize store mutations so async read-modify-write gaps can't drop increments.
let opChain = Promise.resolve();
function serialize(fn) {
  const next = opChain.then(fn, fn);
  opChain = next.catch(() => {});
  return next;
}

async function metricsEnabled() {
  const items = await sget({ metricsEnabled: true });
  return items.metricsEnabled !== false; // default ON (consented testing cohort)
}

const zeroSurfaces = () => SURFACES.reduce((o, s) => ((o[s] = 0), o), {});
const asSurface = (s) => (SURFACES.includes(s) ? s : 'other');
const asProvider = (p) => (p === 'anthropic' ? 'anthropic' : 'groq');

function newSession(id, now) {
  return {
    id, date: new Date(now).toISOString().slice(0, 10), startedAt: now, lastAt: now,
    pageViews: zeroSurfaces(),
    triaged: zeroSurfaces(),
    cache: { hits: 0, misses: 0 },
    tokens: { anthropic: { in: 0, out: 0 }, groq: { in: 0, out: 0 } },
    failures: { anthropic: 0, groq: 0 },
    notesSaved: 0, summariesRead: 0, savedNoteReads: 0,
    buttons: {},
  };
}

// Resolve the active session id, rotating to a fresh one after the idle window. Runs inside
// serialize() so the current-pointer read/write stays atomic against other ops.
async function resolveSession(now) {
  const items = await sget(M_CURRENT);
  const cur = items[M_CURRENT];
  if (cur && now - cur.lastAt <= SESSION_IDLE_MS) {
    await sset({ [M_CURRENT]: { id: cur.id, lastAt: now } });
    return cur.id;
  }
  const id = crypto.randomUUID();
  await sset({ [M_CURRENT]: { id, lastAt: now } });
  return id;
}

function applyEvent(s, event, opts) {
  switch (event) {
    case 'pageView': s.pageViews[asSurface(opts.surface)]++; break;
    case 'triaged': s.triaged[asSurface(opts.surface)]++; break;
    case 'cacheHit': s.cache.hits++; break;
    case 'cacheMiss': s.cache.misses++; break;
    case 'tokens': {
      const p = asProvider(opts.provider);
      s.tokens[p].in += Number(opts.tin) || 0;
      s.tokens[p].out += Number(opts.tout) || 0;
      break;
    }
    case 'failure': s.failures[asProvider(opts.provider)]++; break;
    case 'noteSaved': s.notesSaved++; break;
    case 'summaryRead': s.summariesRead++; break;
    case 'savedNoteRead': s.savedNoteReads = (s.savedNoteReads || 0) + 1; break;
    case 'button': if (opts.name) s.buttons[opts.name] = (s.buttons[opts.name] || 0) + 1; break;
  }
}

function recordMetric(event, opts = {}) {
  return serialize(async () => {
    if (!(await metricsEnabled())) return;
    const now = Date.now();
    const id = await resolveSession(now);
    const key = M_PREFIX + 'session:' + id;
    const items = await sget(key);
    const session = items[key] || newSession(id, now);
    applyEvent(session, event, opts);
    session.lastAt = now;
    await sset({ [key]: session });
  });
}

// Stamp a stable anonymous install id once (id survives updates; version tracks the build).
// No identity, no network — it just lets a tester's emailed report be deduped to one user.
function stampInstall() {
  return serialize(async () => {
    const version = chrome.runtime.getManifest().version;
    const items = await sget(M_INSTALL);
    const rec = items[M_INSTALL];
    if (!rec) await sset({ [M_INSTALL]: { id: crypto.randomUUID(), installedAt: Date.now(), version } });
    else if (rec.version !== version) await sset({ [M_INSTALL]: { ...rec, version } });
  });
}

// Deep-add numeric leaves of src into target (handles the nested tokens/buttons maps).
function addInto(target, src) {
  for (const k of Object.keys(src)) {
    if (typeof src[k] === 'number') target[k] = (target[k] || 0) + src[k];
    else if (src[k] && typeof src[k] === 'object') addInto((target[k] = target[k] || {}), src[k]);
  }
}

async function getMetricsSummary() {
  const items = await sget(null);
  const sessions = Object.keys(items)
    .filter((k) => k.startsWith(M_PREFIX + 'session:'))
    .map((k) => items[k])
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const totals = {
    pageViews: zeroSurfaces(), triaged: zeroSurfaces(),
    cache: { hits: 0, misses: 0 },
    tokens: { anthropic: { in: 0, out: 0 }, groq: { in: 0, out: 0 } },
    failures: { anthropic: 0, groq: 0 },
    notesSaved: 0, summariesRead: 0, savedNoteReads: 0, buttons: {},
  };
  for (const s of sessions) {
    addInto(totals.pageViews, s.pageViews || {});
    addInto(totals.triaged, s.triaged || {});
    addInto(totals.cache, s.cache || {});
    addInto(totals.tokens, s.tokens || {});
    addInto(totals.failures, s.failures || {});
    addInto(totals.buttons, s.buttons || {});
    totals.notesSaved += s.notesSaved || 0;
    totals.summariesRead += s.summariesRead || 0;
    totals.savedNoteReads += s.savedNoteReads || 0;
  }
  return { install: items[M_INSTALL] || null, sessionCount: sessions.length, totals, sessions };
}

// Reset clears the counters but KEEPS the install id — it's identity for dedup, not a stat.
function resetMetrics() {
  return serialize(async () => {
    const items = await sget(null);
    const keys = Object.keys(items).filter((k) => k.startsWith(M_PREFIX + 'session:') || k === M_CURRENT);
    if (keys.length) await srem(keys);
  });
}

// ---- daily free-tier runway (WT-053) -----------------------------------------
// Groq's free tier caps tokens-per-DAY per model (100k/200k/500k — see TPD_BUDGET). We tally
// real per-model spend for the current UTC day (Groq resets daily) so we can show the user
// roughly how many more triages they have before the free cap. This is the proactive heads-up
// WT-050's fallback chain never gave — a runway, not a reactive "limit reached" note. Only Groq
// has a meaningful daily cap; Anthropic is paid, so it reports as unlimited. Stored under its own
// wtytd: key so neither Clear-cache (wtyt:) nor Reset-stats (wtytm:) touches the real-budget tally.
const D_USAGE = 'wtytd:usage';
const TPD_BUDGET = {
  'llama-3.3-70b-versatile': 100000,
  'openai/gpt-oss-120b': 200000,
  'llama-3.1-8b-instant': 500000,
};
// Fallback per-triage estimate before the day has any real calls to average (input+output).
const DEFAULT_PER_TRIAGE = 3500;

const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

// Add a model's actual token spend to today's tally (resetting on a new UTC day). Serialized so
// concurrent analyze() calls can't clobber the read-modify-write. Called only for Groq spend.
function recordDailyUsage(model, tokens) {
  if (!tokens) return;
  return serialize(async () => {
    const now = Date.now();
    const day = utcDay(now);
    const items = await sget(D_USAGE);
    let rec = items[D_USAGE];
    if (!rec || rec.day !== day) rec = { day, models: {} };
    const m = rec.models[model] || { tokens: 0, calls: 0 };
    m.tokens += tokens;
    m.calls += 1;
    rec.models[model] = m;
    await sset({ [D_USAGE]: rec });
  });
}

// Runway for the caller's current provider: total cap, used today, remaining, and an estimate of
// triages left (remaining / avg-tokens-per-triage, averaged from today's real calls when we have
// them, else a sane default). Anthropic → unlimited (paid). Called by the widget + settings.
//
// Aggregated across the WHOLE Groq fallback chain, not just the selected model: the scorer
// auto-falls-back (selected → gpt-oss → 8B), so the user's real runway before they run out of free
// tier is the sum of remaining across every model it will actually reach. Keying on the selected
// model alone (the 0.7.0.1 bug) meant backup-model spend landed in another bucket, so the number
// sat stuck and never turned amber even as the fallbacks burned through their budgets.
async function getRunway({ provider, model } = {}) {
  const p = (provider === 'anthropic' || provider === 'groq')
    ? provider
    : (String(model || '').startsWith('claude') ? 'anthropic' : 'groq');
  if (p !== 'groq') return { provider: p, unlimited: true };
  const chain = [model, ...GROQ_FALLBACK.filter((mm) => mm !== model)].filter((mm) => TPD_BUDGET[mm]);
  if (!chain.length) return { provider: 'groq', model, unknownCap: true };
  const day = utcDay(Date.now());
  const items = await sget(D_USAGE);
  const rec = items[D_USAGE];
  const models = rec && rec.day === day ? rec.models : {};
  let cap = 0, used = 0, calls = 0;
  for (const mm of chain) {
    cap += TPD_BUDGET[mm];
    const entry = models[mm];
    if (entry) { used += entry.tokens; calls += entry.calls; }
  }
  const remaining = Math.max(0, cap - used);
  const perTriage = calls ? Math.max(500, Math.round(used / calls)) : DEFAULT_PER_TRIAGE;
  return {
    provider: 'groq', model, cap, used, remaining,
    perTriage, triagesLeft: Math.floor(remaining / perTriage), day,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'analyze') {
    analyze(msg.payload)
      .then((res) => {
        if (res && res.error) {
          console.warn('WTYT scoring failed:', res.error); // surfaces the real API reason (e.g. daily-cap 429)
          recordMetric('failure', { provider: providerOf(msg.payload.settings || {}) });
        }
        sendResponse(res);
      })
      .catch((e) => {
        recordMetric('failure', { provider: providerOf(msg.payload.settings || {}) });
        sendResponse({ error: String(e.message || e) });
      });
    return true; // async response
  }
  if (msg.type === 'metric') { recordMetric(msg.event, msg.opts || {}); return false; }
  if (msg.type === 'getMetrics') { getMetricsSummary().then(sendResponse); return true; }
  if (msg.type === 'getRunway') { getRunway(msg).then(sendResponse); return true; }
  if (msg.type === 'resetMetrics') { resetMetrics().then(() => sendResponse({ ok: true })); return true; }
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

// First install → open the onboarding once. Every install/update also stamps the
// anonymous install id (created once, version refreshed on upgrade).
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
  }
  stampInstall();
});
