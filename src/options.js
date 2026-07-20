const DEFAULTS = {
  provider: 'groq', // free, no-credit-card path — the right default for a first-run user
  anthropicKey: '',
  groqKey: '',
  apiKey: '', // legacy pre-v2 Anthropic key
  model: 'llama-3.3-70b-versatile',
  maxVideos: 25,
  commentViewThreshold: 100000,
  autoAnalyze: true, // legacy — migrate to the four per-surface flags below
  autoScoreVideos: null,
  autoScorePlaylists: null,
  // Per-surface Auto/Manual (0.6.0). null = unset → migrate from the legacy flags; default auto.
  autoHome: null,
  autoSearch: null,
  autoPlaylist: null,
  autoWatch: null,
  metricsEnabled: true, // opt-in usage counts; on by default during testing
};

const $ = (id) => document.getElementById(id);

// In-memory copies of each provider's key so switching providers never loses one.
const keys = { anthropic: '', groq: '' };
let provider = 'groq';
let model = DEFAULTS.model;

// ---- rendering ----------------------------------------------------------------

function renderProviderCards() {
  document.querySelectorAll('.provider-card').forEach((card) => {
    const on = card.dataset.provider === provider;
    card.classList.toggle('selected', on);
    card.querySelector('input').checked = on;
  });
}

function renderModelCards() {
  const list = WTYT_MODELS.models[provider];
  const container = $('modelCards');
  container.textContent = '';
  for (const m of list) {
    const card = document.createElement('label');
    card.className = 'model-card';
    card.dataset.model = m.id;
    const tag = m.tag ? ` <span class="tag ${m.tagClass}">${m.tag}</span>` : '';
    // Static, trusted template strings from our own catalog — safe to use innerHTML here.
    // Compact horizontal tile: exactly 3 lines (name+badge / one-line explainer / stats).
    card.innerHTML =
      `<div class="name">${m.name}${tag}</div>` +
      `<div class="short">${m.best}</div>` +
      `<div class="stats">${m.quality} · ${m.speed} · ${m.cost}</div>`;
    card.addEventListener('click', () => { selectModel(m.id); persistChoice(); });
    container.append(card);
  }
  // Ensure the selected model belongs to this provider.
  if (!list.some((m) => m.id === model)) model = WTYT_MODELS.defaultModel[provider];
  selectModel(model);
  $('costNote').innerHTML = WTYT_MODELS.costNote[provider];
}

function selectModel(id) {
  model = id;
  document.querySelectorAll('.model-card').forEach((c) => c.classList.toggle('selected', c.dataset.model === id));
}

// Provider + model are single-click choices, so persist them the instant they change — no
// "Save" step. (The key and numeric knobs still save explicitly.) This removes the trap
// where a highlighted-but-unsaved model card diverged from the model analysis actually used.
function persistChoice() {
  saveAll();
  renderRunway(); // model/provider changed → its daily cap did too
}

function renderKeySection() {
  $('apiKey').value = keys[provider];
  $('apiKey').placeholder = WTYT_MODELS.keyPlaceholder[provider];
  $('keyHint').innerHTML = WTYT_MODELS.keyHint[provider];
}

function renderAll() {
  renderProviderCards();
  renderKeySection();
  renderModelCards();
  renderRunway();
}

// WT-053: show today's free-tier daily runway for the selected Groq model. Hidden for Claude
// (paid/unlimited) or an unknown model cap. Reflects the model actually selected in this page.
function renderRunway() {
  const note = $('runwayNote');
  if (!note) return;
  chrome.runtime.sendMessage({ type: 'getRunway', provider, model }, (r) => {
    if (chrome.runtime.lastError || !r || r.unlimited || r.unknownCap || r.provider !== 'groq') {
      note.hidden = true;
      return;
    }
    const pct = Math.round((r.remaining / r.cap) * 100);
    note.hidden = false;
    note.textContent =
      `Free-tier runway today: ≈ ${r.triagesLeft} more triages ` +
      `(${r.used.toLocaleString()} / ${r.cap.toLocaleString()} tokens used · ${pct}% left, resets 00:00 UTC).`;
  });
}

// ---- provider switching -------------------------------------------------------

function switchProvider(next) {
  if (next === provider) return;
  keys[provider] = $('apiKey').value.trim(); // capture before leaving
  provider = next;
  model = WTYT_MODELS.defaultModel[provider];
  renderAll();
  persistChoice();
}

document.querySelectorAll('.provider-card').forEach((card) => {
  card.addEventListener('click', () => switchProvider(card.dataset.provider));
});

// ---- misc controls ------------------------------------------------------------

$('toggleKey').addEventListener('click', () => {
  const field = $('apiKey');
  const showing = field.type === 'text';
  field.type = showing ? 'password' : 'text';
  $('toggleKey').textContent = showing ? 'Show' : 'Hide';
});

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = kind || '';
  if (kind === 'ok') setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
}

// ---- load / save --------------------------------------------------------------

chrome.storage.local.get(DEFAULTS, (items) => {
  // Guard a stale saved provider (e.g. a pre-swap "gemini") — anything but anthropic → free groq.
  provider = items.provider === 'anthropic' ? 'anthropic' : 'groq';
  keys.anthropic = items.anthropicKey || items.apiKey || '';
  keys.groq = items.groqKey || '';
  model = WTYT_MODELS.models[provider].some((m) => m.id === items.model)
    ? items.model
    : WTYT_MODELS.defaultModel[provider];
  $('maxVideos').value = items.maxVideos;
  $('commentViewThreshold').value = items.commentViewThreshold;
  // Per-surface toggles (0.4.2). Unset (null) means a pre-0.4.2 install — fall back to
  // the legacy single autoAnalyze flag so upgraded installs keep their prior behavior.
  const legacyVideos = items.autoScoreVideos ?? items.autoAnalyze;
  const legacyPlaylists = items.autoScorePlaylists ?? items.autoAnalyze;
  $('autoHome').checked = items.autoHome ?? legacyVideos ?? true;
  $('autoSearch').checked = items.autoSearch ?? true;
  $('autoPlaylist').checked = items.autoPlaylist ?? legacyPlaylists ?? true;
  $('autoWatch').checked = items.autoWatch ?? legacyVideos ?? true;
  $('metricsEnabled').checked = items.metricsEnabled !== false;
  renderAll();
  renderMetrics();
});

// Every setting auto-saves the moment it changes (0.4.3) — no Save button. Provider/model
// persist on click (persistChoice); these are the typed/toggled fields. 'change' fires on
// blur for text/number inputs, so the API key saves when you leave the field, not per keystroke.
function saveAll() {
  keys[provider] = $('apiKey').value.trim();
  const settings = {
    provider,
    anthropicKey: keys.anthropic,
    groqKey: keys.groq,
    apiKey: '', // retire the legacy field once migrated
    model,
    maxVideos: Math.max(1, Math.min(100, Number($('maxVideos').value) || DEFAULTS.maxVideos)),
    commentViewThreshold: Math.max(0, Number($('commentViewThreshold').value) || 0),
    autoHome: $('autoHome').checked,
    autoSearch: $('autoSearch').checked,
    autoPlaylist: $('autoPlaylist').checked,
    autoWatch: $('autoWatch').checked,
  };
  chrome.storage.local.set(settings, () => setStatus('Saved.', 'ok'));
}

['apiKey', 'maxVideos', 'commentViewThreshold', 'autoHome', 'autoSearch', 'autoPlaylist', 'autoWatch']
  .forEach((id) => $(id).addEventListener('change', saveAll));

$('reset').addEventListener('click', () => {
  WTYT_METRICS.bump('button', { name: 'reset' });
  // Restore behavioral defaults; deliberately KEEP the user's API keys (a key isn't a "default").
  provider = 'groq';
  model = WTYT_MODELS.defaultModel.groq;
  $('autoHome').checked = true;
  $('autoSearch').checked = true;
  $('autoPlaylist').checked = true;
  $('autoWatch').checked = true;
  $('maxVideos').value = DEFAULTS.maxVideos;
  $('commentViewThreshold').value = DEFAULTS.commentViewThreshold;
  renderAll();
  saveAll();
  setStatus('Reset to defaults.', 'ok');
});

$('testKey').addEventListener('click', () => {
  WTYT_METRICS.bump('button', { name: 'testKey' });
  const ks = $('keyStatus');
  const setKey = (t, k) => { ks.textContent = t; ks.className = 'key-status ' + (k || ''); };
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) { setKey('Enter a key first.', 'err'); return; }
  setKey('Testing…');
  $('testKey').disabled = true;
  chrome.runtime.sendMessage({ type: 'testKey', apiKey, model, provider }, (res) => {
    $('testKey').disabled = false;
    if (chrome.runtime.lastError) { setKey('Could not reach the worker.', 'err'); return; }
    if (res && res.ok) setKey('Key works ✓', 'ok');
    else setKey(res?.error || 'Key test failed.', 'err');
  });
});

$('savedNotes').addEventListener('click', () => {
  WTYT_METRICS.bump('button', { name: 'savedNotes' });
  chrome.tabs.create({ url: chrome.runtime.getURL('src/notes.html') });
});

$('clearCache').addEventListener('click', () => {
  WTYT_METRICS.bump('button', { name: 'clearCache' });
  chrome.storage.local.get(null, (items) => {
    // Only the wtyt: analysis cache — NOT wtytnote: (saved notes) or wtytm: (metrics).
    const cacheKeys = Object.keys(items).filter((k) => k.startsWith('wtyt:'));
    chrome.storage.local.remove(cacheKeys, () => setStatus(`Cleared ${cacheKeys.length} cached analyses.`, 'ok'));
  });
});

// ---- usage metrics UI (0.5.0) -------------------------------------------------

$('metricsEnabled').addEventListener('change', () => {
  chrome.storage.local.set({ metricsEnabled: $('metricsEnabled').checked }, () =>
    setStatus('Saved.', 'ok')
  );
});

const sumSurfaces = (o) => (o ? Object.values(o).reduce((a, b) => a + b, 0) : 0);
const shortId = (id) => (id ? id.slice(0, 8) + '…' : 'n/a');

function metricsRows(s) {
  const t = s.totals;
  const pv = t.pageViews, tr = t.triaged;
  const inst = s.install
    ? `${shortId(s.install.id)} · v${s.install.version || '?'}` +
      (s.install.installedAt ? ` · since ${new Date(s.install.installedAt).toLocaleDateString()}` : '')
    : 'not stamped yet';
  const btns = Object.entries(t.buttons || {});
  return [
    ['Install', inst],
    ['Sessions', String(s.sessionCount)],
    ['Page views', `${sumSurfaces(pv)}  ·  home ${pv.home} · search ${pv.search} · watch ${pv.watch} · playlist ${pv.playlist} · other ${pv.other}`],
    ['Videos triaged', `${sumSurfaces(tr)}  ·  home ${tr.home} · search ${tr.search} · watch ${tr.watch} · playlist ${tr.playlist} · other ${tr.other}`],
    ['Served from cache', `${t.cache.hits} hits · ${t.cache.misses} misses`],
    ['Tokens (Groq)', `${t.tokens.groq.in} in / ${t.tokens.groq.out} out`],
    ['Tokens (Claude)', `${t.tokens.anthropic.in} in / ${t.tokens.anthropic.out} out`],
    ['Scoring failures', `Groq ${t.failures.groq} · Claude ${t.failures.anthropic}`],
    ['Notes saved (saves)', String(t.notesSaved)],
    ['Summaries read (any)', String(t.summariesRead)],
    ['Saved notes reopened', String(t.savedNoteReads || 0)],
    ['Buttons', btns.length ? btns.map(([k, v]) => `${k} ${v}`).join(' · ') : '—'],
  ];
}

async function renderMetrics() {
  const box = $('metricsReadout');
  box.textContent = '';
  const s = await WTYT_METRICS.getSummary();
  if (!s) { box.append(el('div', 'mnote', 'Usage data unavailable.')); return; }
  for (const [k, v] of metricsRows(s)) {
    const row = el('div', 'mrow');
    row.append(el('span', 'mk', k), el('span', 'mv', v));
    box.append(row);
  }
  const note = el('div', 'mnote');
  note.textContent = s.sessionCount
    ? 'Counts are aggregated across all sessions on this browser. Nothing leaves until you email or copy it.'
    : 'No activity recorded yet — browse YouTube with WTYT on and this fills in.';
  box.append(note);
}

// Small DOM helper (options.js has no shared one).
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function reportText(s) {
  const t = s.totals, pv = t.pageViews, tr = t.triaged;
  const inst = s.install
    ? `${s.install.id} · v${s.install.version || '?'}` +
      (s.install.installedAt ? ` · since ${new Date(s.install.installedAt).toISOString().slice(0, 10)}` : '')
    : 'n/a';
  const btns = Object.entries(t.buttons || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
  return [
    'WTYT usage report',
    `Install: ${inst}`,
    `Sessions: ${s.sessionCount}`,
    `Page views: home ${pv.home} · search ${pv.search} · watch ${pv.watch} · playlist ${pv.playlist} · other ${pv.other}`,
    `Videos triaged: ${sumSurfaces(tr)} (home ${tr.home} · search ${tr.search} · watch ${tr.watch} · playlist ${tr.playlist} · other ${tr.other})`,
    `Cache: ${t.cache.hits} hits · ${t.cache.misses} misses`,
    `Tokens — Groq: ${t.tokens.groq.in} in / ${t.tokens.groq.out} out · Claude: ${t.tokens.anthropic.in} in / ${t.tokens.anthropic.out} out`,
    `Failures — Groq: ${t.failures.groq} · Claude: ${t.failures.anthropic}`,
    `Notes saved: ${t.notesSaved} · Summaries read: ${t.summariesRead} · Saved notes reopened: ${t.savedNoteReads || 0}`,
    `Buttons: ${btns}`,
  ].join('\n');
}

$('exportMetrics').addEventListener('click', async () => {
  const s = await WTYT_METRICS.getSummary();
  if (!s) { setStatus('No usage data to send.', 'err'); return; }
  const href =
    'mailto:wtyt@vemana.in?subject=' + encodeURIComponent('WTYT usage report') +
    '&body=' + encodeURIComponent(reportText(s));
  window.location.href = href;
});

$('copyMetrics').addEventListener('click', async () => {
  const s = await WTYT_METRICS.getSummary();
  if (!s) { setStatus('No usage data to copy.', 'err'); return; }
  try {
    await navigator.clipboard.writeText(JSON.stringify(s, null, 2));
    setStatus('Full usage JSON copied.', 'ok');
  } catch {
    setStatus('Copy failed — clipboard blocked.', 'err');
  }
});

$('resetMetrics').addEventListener('click', async () => {
  if (!confirm('Reset all usage stats on this browser? Your anonymous install id is kept.')) return;
  await WTYT_METRICS.reset();
  await renderMetrics();
  setStatus('Usage stats reset.', 'ok');
});
