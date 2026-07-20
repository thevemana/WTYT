// WTYT — orchestrator + surface router (0.6.0).
// One shared sequential engine scores home + playlist: it enumerates rendered rows in DOM
// order, stamps each Queued, and a small worker pool scores top-down while a MutationObserver
// enqueues newly-rendered rows as you scroll — no viewport gate, no manual "Continue".
// Every surface (home/search/playlist/watch) has an Auto/Manual mode, persisted per surface
// (default Auto), flipped from a floating widget we own (fixed-position, never touched by
// YouTube's re-renders). Watch scores the single current video. All paths share getAnalysis.

(() => {
  const CACHE_PREFIX = 'wtyt:';
  const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const CONCURRENCY = 2; // parallel feed workers; Groq's free ~12k TPM is the real bound (see pacing)

  const DEFAULT_SETTINGS = {
    provider: 'groq',
    anthropicKey: '',
    groqKey: '',
    geminiKey: '',
    apiKey: '',
    model: 'llama-3.3-70b-versatile',
    maxVideos: 25,
    commentViewThreshold: 100000,
    // Legacy auto flags — kept only so upgraded installs can migrate to the four below.
    autoAnalyze: true,
    autoScoreVideos: null,
    autoScorePlaylists: null,
    // Per-surface Auto/Manual (0.6.0). null = unset → migrate from the legacy flags. true = auto.
    autoHome: null,
    autoSearch: null,
    autoPlaylist: null,
    autoWatch: null,
  };

  const state = {
    surface: null,
    watchId: null,
    engine: null, // the active feed engine (home/playlist)
  };

  function resolveKey(items) {
    const provider = items.provider || 'groq';
    if (provider === 'groq') return items.groqKey || '';
    if (provider === 'gemini') return items.geminiKey || '';
    return items.anthropicKey || items.apiKey || '';
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Is an element within ~margin px of the viewport? Used to viewport-bound home scoring
  // (0.6.0 stage 1.1 B) — score what you're actually near, not the whole scrolled feed.
  function inView(el, margin) {
    const r = el.getBoundingClientRect();
    if (!r.height && !r.width) return false; // not laid out yet
    const h = window.innerHeight || document.documentElement.clientHeight || 800;
    return r.bottom > -margin && r.top < h + margin;
  }

  const videoMeta = (v) => ({
    id: v.id,
    title: v.title,
    channel: v.channel,
    url: `https://www.youtube.com/watch?v=${v.id}`,
  });

  function toast(message, ms = 5000) {
    document.querySelectorAll('.wtyt-toast').forEach((n) => n.remove());
    const t = document.createElement('div');
    t.className = 'wtyt-toast';
    t.textContent = message;
    document.body.append(t);
    if (ms) setTimeout(() => t.remove(), ms);
    return t;
  }

  // ---- surface detection --------------------------------------------------------

  const params = () => new URLSearchParams(location.search);
  const isPlaylistPage = () => location.pathname === '/playlist' && params().has('list');
  const isWatchPage = () => location.pathname === '/watch' && params().has('v');
  const NON_VIDEO_FEEDS = new Set([
    '/feed/playlists', '/feed/library', '/feed/channels', '/feed/you', '/feed/storefront',
  ]);
  const isHomePage = () =>
    (location.pathname === '/' || location.pathname.startsWith('/feed')) &&
    !NON_VIDEO_FEEDS.has(location.pathname);
  const isSearchPage = () => location.pathname === '/results' && params().has('search_query');

  // The scored surface for this page, or null. Search joined the scored surfaces in 0.7.0.
  function scoredSurface() {
    if (isWatchPage()) return 'watch';
    if (isPlaylistPage()) return 'playlist';
    if (isSearchPage()) return 'search';
    if (isHomePage()) return 'home';
    return null;
  }

  function pageSurface() {
    return scoredSurface() || (location.pathname === '/results' ? 'search' : 'other');
  }
  let lastPageViewUrl = null;
  function trackPageView() {
    const url = location.pathname + location.search;
    if (url === lastPageViewUrl) return; // yt-navigate-finish can fire without a real nav
    lastPageViewUrl = url;
    WTYT_METRICS.bump('pageView', { surface: pageSurface() });
  }

  // ---- settings + cache ---------------------------------------------------------

  const asMode = (v) => (v ? 'auto' : 'manual');

  async function getSettings() {
    return new Promise((resolve) =>
      chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
        const provider = items.provider || 'groq';
        let model = items.model;
        if (provider === 'gemini' && /^gemini-2/.test(model || '')) model = 'gemini-3.5-flash';
        // Migrate the four per-surface modes from the legacy flags when unset (default auto).
        const legacyVideos = items.autoScoreVideos ?? items.autoAnalyze;
        const legacyPlaylists = items.autoScorePlaylists ?? items.autoAnalyze;
        const modes = {
          home: asMode(items.autoHome ?? legacyVideos ?? true),
          search: asMode(items.autoSearch ?? true),
          playlist: asMode(items.autoPlaylist ?? legacyPlaylists ?? true),
          watch: asMode(items.autoWatch ?? legacyVideos ?? true),
        };
        resolve({ ...items, provider, model, apiKey: resolveKey(items), modes });
      })
    );
  }

  // Persist one surface's mode to its own flag (autoHome/autoSearch/autoPlaylist/autoWatch).
  const MODE_FLAG = { home: 'autoHome', search: 'autoSearch', playlist: 'autoPlaylist', watch: 'autoWatch' };
  function persistMode(surface, mode) {
    chrome.storage.local.set({ [MODE_FLAG[surface]]: mode === 'auto' });
  }

  function cacheKey(videoId, settings) {
    return `${CACHE_PREFIX}${settings.provider}:${settings.model}:${videoId}`;
  }
  function cacheGet(videoId, settings) {
    const key = cacheKey(videoId, settings);
    return new Promise((resolve) =>
      chrome.storage.local.get(key, (items) => {
        const hit = items[key];
        resolve(hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.analysis : null);
      })
    );
  }
  function cacheSet(videoId, analysis, settings) {
    chrome.storage.local.set({ [cacheKey(videoId, settings)]: { at: Date.now(), analysis } });
  }

  // WT-053: ask the worker how much free-tier daily budget is left for the current model.
  // Reads settings fresh each call (throttled by the widget) so a provider/model change is
  // reflected without threading settings through every engine ctx.
  async function fetchRunway() {
    const settings = await getSettings();
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'getRunway', provider: settings.provider, model: settings.model },
        (r) => resolve(chrome.runtime.lastError ? null : r)
      );
    });
  }
  // Compact widget text, or null when there's nothing meaningful to show (paid/unlimited or
  // an unknown model cap). `low` flags the amber near-empty state to the caller.
  function runwayText(info) {
    if (!info || info.unlimited || info.unknownCap || info.provider !== 'groq') return null;
    const n = info.triagesLeft;
    return { text: `≈ ${n} left today · free tier`, low: n <= 5 };
  }

  function analyzeRemote(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'analyze', payload }, (response) => {
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
        else resolve(response || { error: 'no response from background worker' });
      });
    });
  }

  // YouTube re-renders/virtualizes rows while we work; re-find a detached row by its video link.
  function freshRow(video) {
    if (video.row && video.row.isConnected) return video.row;
    const link = document.querySelector(`a[href*="watch?v=${video.id}"]`);
    const relocated =
      link?.closest('yt-lockup-view-model') ||
      link?.closest('ytd-playlist-video-renderer') ||
      link?.closest('ytd-video-renderer') ||
      document.querySelector(`.content-id-${video.id}`)?.closest('yt-lockup-view-model');
    if (relocated) video.row = relocated;
    return video.row;
  }

  // ---- core: analyze one video (cache-or-fetch), decoupled from rendering --------

  async function getAnalysis(video, settings, onStatus, opts = {}) {
    // Live/upcoming detected at scan time → mark, never score (no transcript exists). No fetch,
    // no API call, not cached (state changes when it airs/ends).
    if (video.liveState) return { live: video.liveState };

    const cached = await cacheGet(video.id, settings);
    if (cached) { WTYT_METRICS.bump('cacheHit'); return cached; }
    WTYT_METRICS.bump('cacheMiss');

    onStatus?.('Fetching transcript…');
    let watch;
    try {
      watch = await WTYT_DATA.fetchWatchPage(video.id);
    } catch (e) {
      return { error: 'Could not load video page: ' + e.message };
    }

    // Backstop: a row whose DOM live-badge we missed (and the watch surface, which has no scan
    // signal) is caught here from the player response — before any LLM call.
    const liveState = WTYT_DATA.watchLiveState(watch);
    if (liveState) return { live: liveState };

    const transcript = await WTYT_DATA.getTranscript(watch);

    let comments = { comments: [] };
    if ((video.views || 0) >= settings.commentViewThreshold) {
      onStatus?.('Reading top comments…');
      try { comments = await WTYT_DATA.getTopComments(watch, 20); } catch { /* optional signal */ }
    }

    onStatus?.('Scoring…');
    const result = await analyzeRemote({
      settings: { provider: settings.provider, apiKey: settings.apiKey, model: settings.model },
      video: { title: video.title, channel: video.channel, duration: video.duration, viewsText: video.viewsText },
      transcript: { text: transcript.text ? transcript.text.slice(0, 8000) : null, source: transcript.source },
      comments: comments.comments,
      interactive: !!opts.interactive, // watch = a single user-initiated call → skip feed pacing wait
    });
    if (result.error || !result.analysis) return { error: result.error || 'Analysis failed' };

    const analysis = result.analysis;
    if (transcript.source === 'none') {
      analysis.transcript_note = 'No transcript found. Scored from the title and stats only, so lower confidence.';
    } else if (transcript.source === 'auto-captions') {
      analysis.transcript_note = 'Based on auto-generated captions.';
    }
    if (transcript.text) {
      analysis.transcript_text = transcript.text.slice(0, 50000);
      analysis.transcript_source = transcript.source;
    }
    if (analysis.community_check) {
      analysis.community_check.comments_checked = comments.comments.length;
    }

    cacheSet(video.id, analysis, settings);
    WTYT_METRICS.bump('triaged', { surface: state.surface || 'other' });
    return analysis;
  }

  // ---- floating widget (the one on-page control, we fully own it) ----------------
  // A fixed-position element appended to <body> — identical on every surface and never
  // touched by YouTube's re-renders (the reason we don't inject into the masthead). Shows
  // the current surface's Auto/Manual toggle, live scoring status, and a Stop / Score action.

  const WTYT_WIDGET = (() => {
    let root, surfaceEl, autoBtn, manualBtn, statusEl, actionBtn, runwayEl, styled = false;
    let ctx = null; // { surface, mode, onSetMode, onStart, onStop, getRunway }
    let last = { running: false, done: 0, total: 0 };
    let lastRunwayAt = 0;

    const CSS = `
.wtyt-widget {
  position: fixed; top: 64px; right: 16px; z-index: 2147482000;
  width: 186px; padding: 8px 10px; box-sizing: border-box;
  background: #ffffff; color: #0f0f0f;
  border: 1px solid rgba(0,0,0,0.12); border-radius: 11px;
  box-shadow: 0 4px 18px rgba(0,0,0,0.16);
  font-family: 'Roboto', system-ui, Arial, sans-serif;
}
html[dark] .wtyt-widget { background: #1c1c1c; color: #f1f1f1; border-color: rgba(255,255,255,0.16); }
.wtyt-w-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
.wtyt-w-brand { font-weight: 800; letter-spacing: 0.04em; font-size: 11px; white-space: nowrap; }
.wtyt-w-brand .sfc { opacity: 0.5; font-weight: 600; text-transform: capitalize; }
.wtyt-w-status { font-size: 11px; opacity: 0.75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wtyt-w-row { display: flex; gap: 6px; align-items: stretch; }
.wtyt-w-toggle { display: flex; gap: 2px; flex: 1; background: rgba(0,0,0,0.06); border-radius: 8px; padding: 2px; }
html[dark] .wtyt-w-toggle { background: rgba(255,255,255,0.08); }
.wtyt-w-toggle button {
  flex: 1; border: none; background: transparent; color: inherit; cursor: pointer;
  font: inherit; font-size: 11px; font-weight: 600; padding: 4px 0; border-radius: 6px;
}
.wtyt-w-toggle button.on { background: #3170c7; color: #fff; }
.wtyt-w-action {
  border: 1px solid rgba(0,0,0,0.16); background: transparent; color: inherit; cursor: pointer;
  font: inherit; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 8px; white-space: nowrap;
}
html[dark] .wtyt-w-action { border-color: rgba(255,255,255,0.2); }
.wtyt-w-action:hover { border-color: #3170c7; color: #3170c7; }
.wtyt-w-action[hidden] { display: none; }
.wtyt-widget-inline { position: static; top: auto; right: auto; width: auto; box-shadow: none; margin: 0; }
.wtyt-watch-dock { margin: 0 0 12px; }
.wtyt-w-runway { font-size: 10px; opacity: 0.72; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wtyt-w-runway.low { color: #d9822b; opacity: 1; font-weight: 600; }
.wtyt-w-runway[hidden] { display: none; }
`;

    function injectStyle() {
      if (styled) return;
      styled = true;
      const s = document.createElement('style');
      s.textContent = CSS;
      (document.head || document.documentElement).appendChild(s);
    }

    function build() {
      injectStyle();
      root = document.createElement('div');
      root.className = 'wtyt-widget';

      const top = document.createElement('div');
      top.className = 'wtyt-w-top';
      const brand = document.createElement('span');
      brand.className = 'wtyt-w-brand';
      brand.append(document.createTextNode('WTYT '));
      surfaceEl = document.createElement('span');
      surfaceEl.className = 'sfc';
      brand.append(surfaceEl);
      statusEl = document.createElement('span');
      statusEl.className = 'wtyt-w-status';
      top.append(brand, statusEl);

      const row = document.createElement('div');
      row.className = 'wtyt-w-row';
      const toggle = document.createElement('div');
      toggle.className = 'wtyt-w-toggle';
      autoBtn = document.createElement('button');
      autoBtn.type = 'button';
      autoBtn.textContent = 'Auto';
      autoBtn.addEventListener('click', () => ctx && ctx.mode !== 'auto' && ctx.onSetMode('auto'));
      manualBtn = document.createElement('button');
      manualBtn.type = 'button';
      manualBtn.textContent = 'Manual';
      manualBtn.addEventListener('click', () => ctx && ctx.mode !== 'manual' && ctx.onSetMode('manual'));
      toggle.append(autoBtn, manualBtn);
      actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'wtyt-w-action';
      actionBtn.addEventListener('click', onAction);
      row.append(toggle, actionBtn);

      runwayEl = document.createElement('div');
      runwayEl.className = 'wtyt-w-runway';
      runwayEl.hidden = true;

      root.append(top, row, runwayEl);
      document.body.append(root);
    }

    function ensure() {
      if (!root || !root.isConnected) build();
    }

    // WT-053: pull the free-tier runway (throttled) and render it under the controls.
    function refreshRunway(force) {
      if (!ctx || !ctx.getRunway) { setRunway(null); return; }
      const now = Date.now();
      if (!force && now - lastRunwayAt < 2500) return;
      lastRunwayAt = now;
      ctx.getRunway().then(setRunway).catch(() => {});
    }
    function setRunway(info) {
      if (!runwayEl) return;
      const r = runwayText(info);
      if (!r) { runwayEl.hidden = true; return; }
      runwayEl.hidden = false;
      runwayEl.textContent = r.text;
      runwayEl.classList.toggle('low', r.low);
    }

    function onAction() {
      if (!ctx) return;
      if (last.running) ctx.onStop();
      else ctx.onStart();
    }

    function renderToggle() {
      autoBtn.classList.toggle('on', ctx.mode === 'auto');
      manualBtn.classList.toggle('on', ctx.mode === 'manual');
    }

    function renderAction() {
      if (last.running) { actionBtn.textContent = 'Stop'; actionBtn.hidden = false; return; }
      actionBtn.hidden = false;
      actionBtn.textContent = ctx.mode === 'manual'
        ? (last.total ? 'Rescan' : 'Score')
        : (last.total ? 'Rescan' : 'Waiting…');
    }

    return {
      configure(next) {
        ensure();
        ctx = next;
        last = { running: false, done: 0, total: 0 };
        root.hidden = false;
        surfaceEl.textContent = next.surface;
        statusEl.textContent = next.mode === 'auto' ? 'Ready' : 'Manual';
        renderToggle();
        renderAction();
        refreshRunway(true);
      },
      // Live status from the engine. running=false + total>0 ⟹ a pass finished.
      status({ done = 0, total = 0, running = false }) {
        if (!ctx || !root) return;
        last = { running, done, total };
        statusEl.textContent = running
          ? `${done}/${total}`
          : total ? `${done} done` : (ctx.mode === 'auto' ? 'Ready' : 'Manual');
        renderAction();
        refreshRunway(!running); // force a refresh when a pass just finished, else throttled
      },
      // No key yet: keep the widget visible as the on-ramp instead of a silent page.
      needsKey(surface, onOpen) {
        ensure();
        ctx = { surface, mode: 'auto', onSetMode() {}, onStart: onOpen, onStop() {} };
        last = { running: false, done: 0, total: 0 };
        root.hidden = false;
        surfaceEl.textContent = surface;
        renderToggle();
        statusEl.textContent = 'No key';
        actionBtn.hidden = false;
        actionBtn.textContent = 'Settings';
        setRunway(null);
      },
      hide() { if (root) root.hidden = true; },
      ensureStyle: injectStyle, // watch's inline controls reuse the .wtyt-w-* styles
    };
  })();

  // One-time nudge for users who never set a key.
  function maybeFirstRunHint() {
    chrome.storage.local.get(
      { anthropicKey: '', groqKey: '', geminiKey: '', apiKey: '', wtytHinted: false },
      (items) => {
        if (items.anthropicKey || items.groqKey || items.geminiKey || items.apiKey || items.wtytHinted) return;
        toast('New to WTYT? Add a Claude or Groq key in settings to start.', 9000);
        chrome.storage.local.set({ wtytHinted: true });
      }
    );
  }

  // ---- shared feed engine (home + playlist) ------------------------------------
  // Ordered queue + a small worker pool + a MutationObserver that enqueues newly-rendered
  // rows (as YouTube virtualizes them in on scroll). Strict top-down; no viewport gate,
  // no manual Continue. `adapter` supplies the surface-specific scan + render ops.

  function createFeedEngine(surface, settings, adapter) {
    const seen = new Set();
    const queue = [];
    const results = new Map(); // id -> { v, analysis } — stashed so a row virtualized away and
                               // re-rendered fresh by YouTube can get its badge back (stage 1.1 C)
    let stopped = true, pumping = false, done = 0, total = 0, active = 0, scrollT = null;

    function pushStatus() {
      WTYT_WIDGET.status({ done, total, running: !stopped && (queue.length > 0 || active > 0) });
    }

    // Re-apply stashed verdicts to any scored row that lost its badge to virtualization —
    // fixes the rare "no badge" and likely reduces the WT-055 stuck-playlist race (stage 1.1 C).
    function reattach() {
      if (stopped || !results.size) return;
      for (const { v, analysis } of results.values()) {
        if (!adapter.hasResult(v)) adapter.renderResult(v, analysis);
      }
    }

    function scan() {
      if (stopped) return;
      for (const v of adapter.scanRendered()) {
        if (!v || !v.id || seen.has(v.id)) continue;
        seen.add(v.id);
        // Live/upcoming: mark and skip — never enqueue, never count toward the scoring total.
        if (v.liveState && adapter.renderMarker) { adapter.renderMarker(v, v.liveState); continue; }
        total++;
        adapter.markPending(v, 'queued');
        queue.push(v);
      }
      reattach();
      pushStatus();
      pump();
    }

    // Home is viewport-bounded, so scrolling changes what's eligible even without a DOM
    // mutation; a throttled scroll rescan enqueues newly-near rows (and re-attaches). Cheap
    // for playlist too — it just catches rows virtualized back in.
    const onScroll = () => { clearTimeout(scrollT); scrollT = setTimeout(scan, 300); };

    function requeue(v) {
      if (stopped) return;
      WTYT_METRICS.bump('button', { name: 'retry_row' });
      adapter.markPending(v, 'queued');
      queue.push(v);
      pump();
    }

    async function worker() {
      while (queue.length && !stopped) {
        const v = queue.shift();
        active++;
        pushStatus();
        try {
          adapter.markPending(v, 'scoring');
          const a = await getAnalysis(v, settings, () => adapter.markPending(v, 'scoring'));
          // The call already completed. Even if the user flipped to Manual mid-flight, render its
          // result rather than waste the spend (item-4) — the while-guard stops NEW work below.
          if (a.live) adapter.renderMarker?.(v, a.live); // backstop: live row missed at scan time
          else if (a.error) { if (stopped) adapter.clearPending?.(v); else adapter.markFail(v, a.error, () => requeue(v)); }
          else { results.set(v.id, { v, analysis: a }); adapter.renderResult(v, a); }
        } catch (e) {
          if (stopped) adapter.clearPending?.(v);
          else adapter.markFail(v, e.message || String(e), () => requeue(v));
        }
        active--;
        done++;
        pushStatus();
        await sleep(300);
      }
    }

    async function pump() {
      if (pumping || stopped) return;
      pumping = true;
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      pumping = false;
      if (!stopped && queue.length) pump(); // rows arrived while the pool was draining
    }

    const mo = new MutationObserver(() => { clearTimeout(mo._t); mo._t = setTimeout(scan, 250); });

    return {
      surface,
      start() {
        if (!stopped) return;
        stopped = false;
        mo.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('scroll', onScroll, { passive: true });
        scan();
        pushStatus();
      },
      stop() {
        stopped = true;
        mo.disconnect();
        clearTimeout(mo._t);
        window.removeEventListener('scroll', onScroll);
        clearTimeout(scrollT);
        // Abandon rows still Queued (never started): clear the frozen badge, forget them (so a
        // later Auto flip or Score re-scores them), and un-count them. In-flight "Scoring…" rows
        // are left to finish and render — their API call is already spent (item-4).
        const drained = queue.splice(0);
        for (const v of drained) { seen.delete(v.id); adapter.clearPending?.(v); }
        total -= drained.length;
        pushStatus();
      },
      get running() { return !stopped; },
    };
  }

  // ---- surface adapters --------------------------------------------------------

  function homeAdapter() {
    return {
      scanRendered() {
        const out = [];
        // Look ~one screen ahead so scoring stays just in front of the scroll (stage 1.1 B).
        const margin = Math.max(600, window.innerHeight || 800);
        for (const item of document.querySelectorAll('ytd-rich-item-renderer')) {
          const lk = item.querySelector('yt-lockup-view-model');
          if (item.querySelector('ytd-ad-slot-renderer')) { WTYT_CARDS.markHome(lk || item, 'ad'); continue; }
          if (!lk) continue;
          if (!inView(item, margin)) continue; // viewport-bound: skip rows far below the fold
          const v = WTYT_DATA.parseLockup(lk);
          if (v) out.push(v);
        }
        return out;
      },
      markPending(v, stateName) {
        const lk = freshRow(v);
        if (lk) WTYT_CARDS.markHome(lk, stateName === 'queued' ? 'queued' : 'scoring');
      },
      renderResult(v, analysis) {
        const lk = freshRow(v);
        if (lk) WTYT_CARDS.attachHome(lk, analysis);
      },
      // A verdict pill (not a lifecycle state overlay) means the badge survived. Used by the
      // re-attach pass to tell a virtualized-away row from a still-badged one.
      hasResult(v) {
        const lk = freshRow(v);
        return !!lk && !!lk.querySelector('.wtyt-pill-overlay:not(.wtyt-state)');
      },
      markFail(v, _err, onRetry) {
        const lk = freshRow(v);
        if (lk) WTYT_CARDS.markHome(lk, 'failed', { onRetry });
      },
      clearPending(v) {
        const lk = freshRow(v);
        if (lk) WTYT_CARDS.clearHomeState(lk);
      },
      renderMarker(v, kind) {
        const lk = freshRow(v);
        if (lk) WTYT_CARDS.markHomeMarker(lk, kind);
      },
    };
  }

  // Playlist and search share a shape: a full card mounted into the row's metadata column.
  // Only the scan source differs, so one factory serves both.
  function rowCardAdapter(scanFn) {
    return {
      scanRendered() { return scanFn(); },
      markPending(v, stateName, statusText) {
        const row = freshRow(v);
        if (row) WTYT_CARDS.attach(row, WTYT_CARDS.renderPending(
          statusText || (stateName === 'queued' ? 'Queued' : 'Scoring…'),
          stateName === 'queued' ? 'queued' : 'scoring'
        ));
      },
      renderResult(v, analysis) {
        const row = freshRow(v);
        if (row) WTYT_CARDS.attach(row, WTYT_CARDS.render(analysis, { tools: true, video: videoMeta(v) }));
      },
      // A rendered result card (not the pending/error skeleton) means the badge survived.
      hasResult(v) {
        const row = freshRow(v);
        return !!row && !!row.querySelector('.wtyt-card:not(.wtyt-pending):not(.wtyt-error)');
      },
      markFail(v, err, onRetry) {
        const row = freshRow(v);
        if (row) WTYT_CARDS.attach(row, WTYT_CARDS.renderError(err, { onRetry }));
      },
      clearPending(v) {
        WTYT_CARDS.detachPending(freshRow(v));
      },
      renderMarker(v, kind) {
        const row = freshRow(v);
        if (row) WTYT_CARDS.attach(row, WTYT_CARDS.renderMarker(kind));
      },
    };
  }
  const playlistAdapter = () => rowCardAdapter(() => WTYT_DATA.scanPlaylist());
  const searchAdapter = () => rowCardAdapter(() => WTYT_DATA.scanSearch());

  // ---- watch (single video) ----------------------------------------------------

  async function waitFor(fn, tries = 20, gap = 300) {
    for (let i = 0; i < tries; i++) {
      const v = fn();
      if (v) return v;
      await sleep(gap);
    }
    return null;
  }

  // Watch drops the floating chip and docks the SAME controls inline above the analysis card
  // (shares the .wtyt-w-* styles, so it looks identical — just in-flow, not fixed). Returns the
  // element plus a status() updater the scorer drives. Keeps its own toggle state so a flip
  // reflects instantly, independent of the re-route.
  function buildWatchControls(mode, handlers) {
    WTYT_WIDGET.ensureStyle();
    const mk = (tag, cls, txt) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (txt != null) n.textContent = txt;
      return n;
    };
    const bar = mk('div', 'wtyt-widget wtyt-widget-inline');
    const top = mk('div', 'wtyt-w-top');
    const brand = mk('span', 'wtyt-w-brand');
    brand.append(document.createTextNode('WTYT '), mk('span', 'sfc', 'watch'));
    const statusEl = mk('span', 'wtyt-w-status');
    top.append(brand, statusEl);
    const row = mk('div', 'wtyt-w-row');
    const toggle = mk('div', 'wtyt-w-toggle');
    const autoBtn = mk('button', null, 'Auto'); autoBtn.type = 'button';
    const manualBtn = mk('button', null, 'Manual'); manualBtn.type = 'button';
    toggle.append(autoBtn, manualBtn);
    const actionBtn = mk('button', 'wtyt-w-action'); actionBtn.type = 'button';
    row.append(toggle, actionBtn);
    const runwayEl = mk('div', 'wtyt-w-runway'); runwayEl.hidden = true;
    bar.append(top, row, runwayEl);

    let cur = mode, running = false, total = 0;
    const renderToggle = () => {
      autoBtn.classList.toggle('on', cur === 'auto');
      manualBtn.classList.toggle('on', cur === 'manual');
    };
    const renderAction = () => {
      actionBtn.textContent = running ? 'Stop'
        : cur === 'manual' ? (total ? 'Rescan' : 'Score')
        : (total ? 'Rescan' : 'Waiting…');
    };
    autoBtn.addEventListener('click', () => { if (cur !== 'auto') { cur = 'auto'; renderToggle(); renderAction(); handlers.onSetMode('auto'); } });
    manualBtn.addEventListener('click', () => { if (cur !== 'manual') { cur = 'manual'; renderToggle(); renderAction(); handlers.onSetMode('manual'); } });
    actionBtn.addEventListener('click', () => { if (running) handlers.onStop(); else handlers.onStart(); });
    renderToggle();
    statusEl.textContent = cur === 'auto' ? 'Ready' : 'Manual';
    renderAction();

    const setRunway = (info) => {
      const rr = runwayText(info);
      if (!rr) { runwayEl.hidden = true; return; }
      runwayEl.hidden = false;
      runwayEl.textContent = rr.text;
      runwayEl.classList.toggle('low', rr.low);
    };
    setRunway(null);

    return {
      el: bar,
      status({ done = 0, total: t = 0, running: r = false } = {}) {
        running = r; total = t;
        statusEl.textContent = r ? `${done}/${t || 1}` : (t ? 'Done' : (cur === 'auto' ? 'Ready' : 'Manual'));
        renderAction();
      },
      refreshRunway() { fetchRunway().then(setRunway).catch(() => {}); },
    };
  }

  // The analysis card sits BELOW the controls bar, inside the same dock.
  function attachWatchCard(dock, card) {
    dock.querySelectorAll(':scope > .wtyt-watch').forEach((n) => n.remove());
    dock.append(card);
    return card;
  }

  async function scoreWatch(video, settings, dock, controls) {
    state.watchId = video.id;
    const pending = WTYT_CARDS.renderPending('WTYT · scoring this video…');
    pending.classList.add('wtyt-watch');
    attachWatchCard(dock, pending);
    controls.status({ done: 0, total: 1, running: true });

    const a = await getAnalysis(video, settings, null, { interactive: true });
    if (state.watchId !== video.id) return; // navigated away mid-flight
    if (a.live) {
      const marker = WTYT_CARDS.renderMarker(a.live);
      marker.classList.add('wtyt-watch');
      attachWatchCard(dock, marker);
    } else if (a.error) {
      const err = WTYT_CARDS.renderError(a.error);
      err.classList.add('wtyt-watch');
      attachWatchCard(dock, err);
    } else {
      try {
        attachWatchCard(dock, WTYT_CARDS.renderWatch(a, { tools: true, video: videoMeta(video) }));
      } catch (e) {
        const err = WTYT_CARDS.renderError('Could not render analysis: ' + (e.message || e));
        err.classList.add('wtyt-watch');
        attachWatchCard(dock, err);
      }
    }
    controls.status({ done: 1, total: 1, running: false });
    controls.refreshRunway();
  }

  async function setupWatch(settings, mode) {
    const video = WTYT_DATA.scanWatch();
    if (!video) return;
    if (state.watchId === video.id && document.querySelector('.wtyt-watch')) return;
    const rail = await waitFor(() => WTYT_DATA.watchRail());
    if (!rail) return;

    WTYT_WIDGET.hide(); // watch uses the inline docked controls, not the floating chip

    rail.querySelectorAll(':scope > .wtyt-watch-dock').forEach((n) => n.remove());
    const dock = document.createElement('div');
    dock.className = 'wtyt-watch-dock';
    const controls = buildWatchControls(mode, {
      onSetMode: (m) => switchMode('watch', m),
      onStart: () => scoreWatch(video, settings, dock, controls),
      onStop: () => { state.watchId = null; },
    });
    dock.append(controls.el);
    rail.prepend(dock);
    controls.refreshRunway();

    if (mode === 'auto') scoreWatch(video, settings, dock, controls);
    // Manual: the docked "Score" button triggers scoring.
  }

  // ---- mode switching ----------------------------------------------------------

  function switchMode(surface, mode) {
    persistMode(surface, mode);
    if (surface === 'watch') {
      // Re-route watch with the new mode (cheap; re-reads settings).
      route();
      return;
    }
    const engine = state.engine;
    if (!engine) return;
    if (mode === 'auto') { WTYT_WIDGET.configure(engineCtx(surface, mode, engine)); engine.start(); }
    else { engine.stop(); WTYT_WIDGET.configure(engineCtx(surface, mode, engine)); }
  }

  function engineCtx(surface, mode, engine) {
    return {
      surface, mode,
      onSetMode: (m) => switchMode(surface, m),
      onStart: () => engine.start(),
      onStop: () => engine.stop(),
      getRunway: fetchRunway,
    };
  }

  // ---- router -------------------------------------------------------------------

  async function route() {
    const surface = scoredSurface();
    if (state.engine) { state.engine.stop(); state.engine = null; }
    if (surface !== 'watch') {
      state.watchId = null;
      document.querySelectorAll('.wtyt-watch-dock').forEach((n) => n.remove());
    }
    state.surface = surface;

    if (!surface) { WTYT_WIDGET.hide(); return; }

    const settings = await getSettings();
    if (!settings.apiKey) {
      WTYT_WIDGET.needsKey(surface, () => chrome.runtime.sendMessage({ type: 'openOptions' }));
      maybeFirstRunHint();
      return;
    }

    const mode = settings.modes[surface];

    if (surface === 'watch') { setupWatch(settings, mode); return; }

    const adapter = surface === 'home' ? homeAdapter()
      : surface === 'search' ? searchAdapter()
      : playlistAdapter();
    const engine = createFeedEngine(surface, settings, adapter);
    state.engine = engine;
    WTYT_WIDGET.configure(engineCtx(surface, mode, engine));
    if (mode === 'auto') engine.start();
  }

  // YouTube is a SPA: route on its navigation event, plus initial load. Page-view telemetry
  // fires on the same signals (deduped by URL), independent of scoring.
  window.addEventListener('yt-navigate-finish', () => { trackPageView(); setTimeout(route, 600); });
  trackPageView();
  setTimeout(route, 800);
})();
