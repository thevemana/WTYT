// WTYT — onboarding wizard. Three steps: what it is → connect your AI → try it.
// Choose a provider (Claude or Groq) up front; persists key + model as you go.

const SAMPLE_PLAYLIST = 'https://www.youtube.com/playlist?list=UUsXVk37bltHxD1rDPwtNM8Q';
let step = 1;
let provider = 'anthropic';
let model = WTYT_MODELS.defaultModel.anthropic;
const keys = { anthropic: '', groq: '' };

const $ = (id) => document.getElementById(id);

chrome.storage.local.get(
  { provider: 'anthropic', anthropicKey: '', groqKey: '', apiKey: '', model: '' },
  (items) => {
    // Guard a stale saved provider (e.g. a pre-swap "gemini").
    provider = items.provider === 'groq' ? 'groq' : 'anthropic';
    keys.anthropic = items.anthropicKey || items.apiKey || '';
    keys.groq = items.groqKey || '';
    model = WTYT_MODELS.models[provider].some((m) => m.id === items.model)
      ? items.model
      : WTYT_MODELS.defaultModel[provider];
    renderProvider();
  }
);

// ---- rendering ----------------------------------------------------------------

function renderProviderCards() {
  document.querySelectorAll('.p').forEach((p) => p.classList.toggle('sel', p.dataset.provider === provider));
}

function renderModelChips() {
  const container = $('modelChips');
  container.textContent = '';
  for (const m of WTYT_MODELS.models[provider]) {
    const chip = document.createElement('div');
    chip.className = 'm';
    chip.dataset.model = m.id;
    chip.innerHTML = `<div class="mt">${m.name}</div><div class="md">${m.short}</div>`;
    chip.addEventListener('click', () => { model = m.id; syncModelChips(); saveKey(); });
    container.append(chip);
  }
  if (!WTYT_MODELS.models[provider].some((m) => m.id === model)) model = WTYT_MODELS.defaultModel[provider];
  syncModelChips();
}

function syncModelChips() {
  document.querySelectorAll('.m').forEach((m) => m.classList.toggle('sel', m.dataset.model === model));
}

function renderProvider() {
  renderProviderCards();
  $('apiKey').value = keys[provider];
  $('apiKey').placeholder = WTYT_MODELS.keyPlaceholder[provider];
  $('keyLabel').textContent = provider === 'groq' ? 'Groq API key' : 'Anthropic API key';
  $('keyHint').innerHTML = WTYT_MODELS.keyHint[provider];
  $('qualLine').textContent = WTYT_MODELS.qualitativeLine;
  renderModelChips();
}

document.querySelectorAll('.p').forEach((p) => {
  p.addEventListener('click', () => {
    keys[provider] = $('apiKey').value.trim(); // capture before switching
    provider = p.dataset.provider;
    model = WTYT_MODELS.defaultModel[provider];
    renderProvider();
    saveKey();
  });
});

function setStatus(text, kind) {
  const el = $('stepStatus');
  el.textContent = text;
  el.className = kind || '';
  if (kind === 'ok') setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
}

function render() {
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', Number(p.dataset.step) === step));
  $('bar1').classList.toggle('done', step >= 1);
  $('bar2').classList.toggle('done', step >= 2);
  $('bar3').classList.toggle('done', step >= 3);
  $('back').style.visibility = step === 1 ? 'hidden' : 'visible';
  $('next').textContent = step === 3 ? 'Done' : 'Next';
  setStatus('');
}

// ---- persistence --------------------------------------------------------------

function saveKey() {
  keys[provider] = $('apiKey').value.trim();
  chrome.storage.local.set({
    provider,
    anthropicKey: keys.anthropic,
    groqKey: keys.groq,
    model,
  });
}

$('next').addEventListener('click', () => {
  if (step === 2) saveKey(); // persist before leaving the key step
  if (step < 3) { step++; render(); return; }
  saveKey();
  window.close();
});

$('back').addEventListener('click', () => { if (step > 1) { step--; render(); } });

$('testKey').addEventListener('click', () => {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) { setStatus('Enter a key first.', 'err'); return; }
  setStatus('Testing…');
  $('testKey').disabled = true;
  chrome.runtime.sendMessage({ type: 'testKey', apiKey, model, provider }, (res) => {
    $('testKey').disabled = false;
    if (chrome.runtime.lastError) { setStatus('Could not reach the worker.', 'err'); return; }
    if (res && res.ok) { setStatus('Key works', 'ok'); saveKey(); }
    else setStatus(res?.error || 'Key test failed.', 'err');
  });
});

$('openDemo').addEventListener('click', () => {
  saveKey();
  chrome.tabs.create({ url: SAMPLE_PLAYLIST });
});

render();
