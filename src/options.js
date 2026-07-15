const DEFAULTS = {
  provider: 'groq', // free, no-credit-card path — the right default for a first-run user
  anthropicKey: '',
  groqKey: '',
  apiKey: '', // legacy pre-v2 Anthropic key
  model: 'llama-3.3-70b-versatile',
  maxVideos: 25,
  commentViewThreshold: 100000,
  concurrency: 2,
  homeConcurrency: 2,
  autoAnalyze: true, // legacy single flag, kept as the fallback for the two below
  autoScoreVideos: null, // null = "unset" — fall back to legacy autoAnalyze (see load below)
  autoScorePlaylists: null,
  homeBatch: 16,
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
  $('autoScoreVideos').checked = items.autoScoreVideos ?? items.autoAnalyze;
  $('autoScorePlaylists').checked = items.autoScorePlaylists ?? items.autoAnalyze;
  $('homeBatch').value = items.homeBatch;
  renderAll();
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
    concurrency: DEFAULTS.concurrency,
    homeConcurrency: DEFAULTS.homeConcurrency,
    // autoAnalyze kept in sync as the fallback any pre-0.4.2 code path (or a not-yet-reloaded
    // content script) reads.
    autoAnalyze: $('autoScoreVideos').checked,
    autoScoreVideos: $('autoScoreVideos').checked,
    autoScorePlaylists: $('autoScorePlaylists').checked,
    homeBatch: Math.max(1, Math.min(100, Number($('homeBatch').value) || DEFAULTS.homeBatch)),
  };
  chrome.storage.local.set(settings, () => setStatus('Saved.', 'ok'));
}

['apiKey', 'maxVideos', 'commentViewThreshold', 'homeBatch', 'autoScoreVideos', 'autoScorePlaylists']
  .forEach((id) => $(id).addEventListener('change', saveAll));

$('reset').addEventListener('click', () => {
  // Restore behavioral defaults; deliberately KEEP the user's API keys (a key isn't a "default").
  provider = 'groq';
  model = WTYT_MODELS.defaultModel.groq;
  $('autoScoreVideos').checked = true;
  $('autoScorePlaylists').checked = true;
  $('homeBatch').value = DEFAULTS.homeBatch;
  $('maxVideos').value = DEFAULTS.maxVideos;
  $('commentViewThreshold').value = DEFAULTS.commentViewThreshold;
  renderAll();
  saveAll();
  setStatus('Reset to defaults.', 'ok');
});

$('testKey').addEventListener('click', () => {
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
  chrome.tabs.create({ url: chrome.runtime.getURL('src/notes.html') });
});

$('clearCache').addEventListener('click', () => {
  chrome.storage.local.get(null, (items) => {
    const cacheKeys = Object.keys(items).filter((k) => k.startsWith('wtyt:'));
    chrome.storage.local.remove(cacheKeys, () => setStatus(`Cleared ${cacheKeys.length} cached analyses.`, 'ok'));
  });
});
