const DEFAULTS = {
  provider: 'anthropic',
  anthropicKey: '',
  groqKey: '',
  apiKey: '', // legacy pre-v2 Anthropic key
  model: 'claude-haiku-4-5-20251001',
  maxVideos: 25,
  commentViewThreshold: 100000,
  concurrency: 2,
  homeConcurrency: 2,
  autoAnalyze: true,
  homeBatch: 16,
};

const $ = (id) => document.getElementById(id);

// In-memory copies of each provider's key so switching providers never loses one.
const keys = { anthropic: '', groq: '' };
let provider = 'anthropic';
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
    card.innerHTML =
      `<div class="name">${m.name}${tag}</div>` +
      `<div class="best">${m.best}</div>` +
      `<dl>` +
      `<div><dt>Quality</dt><dd>${m.quality}</dd></div>` +
      `<div><dt>Speed</dt><dd>${m.speed}</dd></div>` +
      `<div><dt>Cost</dt><dd>${m.cost}</dd></div>` +
      `</dl>`;
    card.addEventListener('click', () => selectModel(m.id));
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
  // Guard a stale saved provider (e.g. a pre-swap "gemini").
  provider = items.provider === 'groq' ? 'groq' : 'anthropic';
  keys.anthropic = items.anthropicKey || items.apiKey || '';
  keys.groq = items.groqKey || '';
  model = WTYT_MODELS.models[provider].some((m) => m.id === items.model)
    ? items.model
    : WTYT_MODELS.defaultModel[provider];
  $('maxVideos').value = items.maxVideos;
  $('commentViewThreshold').value = items.commentViewThreshold;
  $('autoAnalyze').checked = items.autoAnalyze;
  $('homeBatch').value = items.homeBatch;
  renderAll();
});

$('save').addEventListener('click', () => {
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
    autoAnalyze: $('autoAnalyze').checked,
    homeBatch: Math.max(1, Math.min(100, Number($('homeBatch').value) || DEFAULTS.homeBatch)),
  };
  chrome.storage.local.set(settings, () => setStatus('Saved.', 'ok'));
});

$('testKey').addEventListener('click', () => {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) { setStatus('Enter a key first.', 'err'); return; }
  setStatus('Testing…');
  $('testKey').disabled = true;
  chrome.runtime.sendMessage({ type: 'testKey', apiKey, model, provider }, (res) => {
    $('testKey').disabled = false;
    if (chrome.runtime.lastError) { setStatus('Could not reach the worker.', 'err'); return; }
    if (res && res.ok) setStatus('Key works', 'ok');
    else setStatus(res?.error || 'Key test failed.', 'err');
  });
});

$('clearCache').addEventListener('click', () => {
  chrome.storage.local.get(null, (items) => {
    const cacheKeys = Object.keys(items).filter((k) => k.startsWith('wtyt:'));
    chrome.storage.local.remove(cacheKeys, () => setStatus(`Cleared ${cacheKeys.length} cached analyses.`, 'ok'));
  });
});
