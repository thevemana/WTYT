// WTYT — orchestrator + surface router.
// Playlist: button-triggered scan by default, or auto-runs on open if the
// autoScorePlaylists setting is on. Watch: auto-scores the current video and pins an
// expansive card atop the up-next rail. Home: lazy-scores videos as they scroll in, in
// batches, then a "Continue" button resumes. All three share getAnalysis.

(() => {
  const CACHE_PREFIX = 'wtyt:';
  const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

  const DEFAULT_SETTINGS = {
    provider: 'groq', // free, no-credit-card path — the right default for a first-run user
    anthropicKey: '',
    groqKey: '',
    geminiKey: '', // legacy pre-0.3.2 key, kept for stale-install fallback
    apiKey: '', // legacy pre-v2 Anthropic key
    model: 'llama-3.3-70b-versatile',
    maxVideos: 25,
    commentViewThreshold: 100000,
    concurrency: 2,
    homeConcurrency: 2,
    autoAnalyze: true, // legacy single flag — fallback for the two per-surface flags below
    autoScoreVideos: null, // null = "unset" (pre-0.4.2 install) — falls back to autoAnalyze
    autoScorePlaylists: null,
    homeBatch: 16,
  };

  const state = {
    surface: null,
    playlistRunning: false,
    playlistAutoRunFor: null, // list id already auto-run, so repeat route() calls don't re-trigger
    watchId: null,
    home: null, // { io, mo, queue, count, paused, pumping, settings }
  };

  // The active key depends on the chosen provider; older installs only have `apiKey`.
  function resolveKey(items) {
    const provider = items.provider || 'groq';
    if (provider === 'groq') return items.groqKey || '';
    if (provider === 'gemini') return items.geminiKey || ''; // stale pre-0.3.2 install
    return items.anthropicKey || items.apiKey || '';
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Lean video meta for the card toolbar (read-time chip + Save) — never the DOM `row`.
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
  // Most /feed/* pages are scrollable video feeds (subscriptions, history, trending) and
  // score like home. These are NOT — they list playlists/channels, so scoring there is
  // wrong (it scored playlist cover thumbnails). Verified 2026-07-12: a card leaked onto
  // /feed/playlists.
  const NON_VIDEO_FEEDS = new Set([
    '/feed/playlists', '/feed/library', '/feed/channels', '/feed/you', '/feed/storefront',
  ]);
  const isHomePage = () =>
    (location.pathname === '/' || location.pathname.startsWith('/feed')) &&
    !NON_VIDEO_FEEDS.has(location.pathname);

  // ---- settings + cache ---------------------------------------------------------

  async function getSettings() {
    return new Promise((resolve) =>
      chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
        const provider = items.provider || 'groq';
        let model = items.model;
        // Heal stale saved Gemini models retired in 2026 (2.0 / 2.5 lines).
        if (provider === 'gemini' && /^gemini-2/.test(model || '')) model = 'gemini-3.5-flash';
        // Per-surface auto-score toggles (0.4.2). Home shares the video toggle — both are
        // "score as you browse" surfaces, unlike the playlist's deliberate button-trigger.
        // Unset (null) per-surface flags mean a pre-0.4.2 install — fall back to the
        // legacy single autoAnalyze flag so upgraded installs keep their prior behavior.
        const autoScoreVideos = items.autoScoreVideos ?? items.autoAnalyze;
        const autoScorePlaylists = items.autoScorePlaylists ?? items.autoAnalyze;
        resolve({ ...items, provider, model, apiKey: resolveKey(items), autoScoreVideos, autoScorePlaylists });
      })
    );
  }

  // Key by provider+model so switching providers rescores instead of showing the other
  // provider's stale analysis — both results coexist under separate keys. Prefix stays
  // `wtyt:` so the options-page Clear-cache sweep still matches. Old videoId-only keys
  // from ≤0.3.3 simply never match now and age out on the 14-day TTL.
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

  function analyzeRemote(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'analyze', payload }, (response) => {
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
        else resolve(response || { error: 'no response from background worker' });
      });
    });
  }

  // YouTube re-renders rows while we work; re-find a detached lockup. Relocate by the
  // video's link href (universal across surfaces) — playlist lockups have no content-id
  // class, which is why cards used to attach to detached ghost nodes and never appear.
  function freshRow(video) {
    if (video.row && video.row.isConnected) return video.row;
    const link = document.querySelector(`a[href*="watch?v=${video.id}"]`);
    const relocated =
      link?.closest('yt-lockup-view-model') ||
      link?.closest('ytd-playlist-video-renderer') ||
      document.querySelector(`.content-id-${video.id}`)?.closest('yt-lockup-view-model');
    if (relocated) video.row = relocated;
    return video.row;
  }

  // ---- core: analyze one video (cache-or-fetch), decoupled from rendering --------

  async function getAnalysis(video, settings, onStatus) {
    const cached = await cacheGet(video.id, settings);
    if (cached) return cached;

    onStatus?.('Fetching transcript…');
    let watch;
    try {
      watch = await WTYT_DATA.fetchWatchPage(video.id);
    } catch (e) {
      return { error: 'Could not load video page: ' + e.message };
    }

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
      // ~8k chars (~2k tokens) is plenty to judge watch-worthiness and write a short
      // distillation, and keeps a request well under Groq's free 12k TPM — the old 20k slice
      // (~5k tokens) blew past it the moment two home workers fired at once. The reader overlay
      // still shows the fuller 15k-char transcript below (display only, not sent to the model).
      transcript: { text: transcript.text ? transcript.text.slice(0, 8000) : null, source: transcript.source },
      comments: comments.comments,
    });
    if (result.error || !result.analysis) return { error: result.error || 'Analysis failed' };

    const analysis = result.analysis;
    if (transcript.source === 'none') {
      analysis.transcript_note = 'No transcript found. Scored from the title and stats only, so lower confidence.';
    } else if (transcript.source === 'auto-captions') {
      analysis.transcript_note = 'Based on auto-generated captions.';
    }
    if (transcript.text) {
      analysis.transcript_text = transcript.text.slice(0, 15000);
      analysis.transcript_source = transcript.source;
    }
    // background.js already strips community_check when no comments were sent; here we
    // only annotate how many were actually checked (present ⟹ comments were sent).
    if (analysis.community_check) {
      analysis.community_check.comments_checked = comments.comments.length;
    }

    cacheSet(video.id, analysis, settings);
    return analysis;
  }

  // ---- floating button ----------------------------------------------------------

  function ensureFab(label, onClick, pulse) {
    let btn = document.querySelector('.wtyt-fab');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'wtyt-fab';
      document.body.append(btn);
    }
    btn.textContent = label;
    btn.onclick = () => onClick(btn);
    if (pulse) btn.classList.add('wtyt-fab-pulse');
    return btn;
  }
  function removeFab() {
    document.querySelector('.wtyt-fab')?.remove();
  }

  // One-time nudge for users who never set a key (e.g. dismissed onboarding).
  function maybeFirstRunHint(btn) {
    chrome.storage.local.get(
      { provider: 'anthropic', anthropicKey: '', groqKey: '', geminiKey: '', apiKey: '', wtytHinted: false },
      (items) => {
        if (items.anthropicKey || items.groqKey || items.geminiKey || items.apiKey || items.wtytHinted) return;
        btn.classList.add('wtyt-fab-pulse');
        toast('New to WTYT? Add a Claude or Groq key to start. Click the button.', 9000);
        chrome.storage.local.set({ wtytHinted: true });
      }
    );
  }

  // ---- playlist (button-triggered) ---------------------------------------------

  // YouTube virtualizes playlist rows — a row scrolled out and back (or re-rendered mid-run)
  // loses our injected card and it only reappears on a full refresh. Re-attach the cached
  // result whenever the list mutates so a re-rendered row gets its card back. (Root cause of
  // "the assessment sometimes doesn't load until refresh".)
  function setupPlaylistRehydrate() {
    if (state.playlistMo) return;
    let t = null;
    const rehydrate = () => {
      const results = state.playlistResults;
      if (!results || !results.size) return;
      for (const [id, entry] of results) {
        const link = document.querySelector(`a[href*="watch?v=${id}"]`);
        const row = link?.closest('yt-lockup-view-model') || link?.closest('ytd-playlist-video-renderer');
        if (row && !row.querySelector('.wtyt-card')) {
          WTYT_CARDS.attach(row, WTYT_CARDS.render(entry.analysis, { tools: true, video: entry.meta }));
        }
      }
    };
    state.playlistMo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(rehydrate, 300); });
    state.playlistMo.observe(document.body, { childList: true, subtree: true });
  }

  function teardownPlaylist() {
    state.playlistMo?.disconnect();
    state.playlistMo = null;
    state.playlistResults = null;
  }

  async function runPlaylist(btn) {
    if (state.playlistRunning) return;
    const settings = await getSettings();
    if (!settings.apiKey) {
      toast('WTYT needs a Claude or Groq key. Opening settings…');
      chrome.runtime.sendMessage({ type: 'openOptions' });
      return;
    }
    const videos = WTYT_DATA.scanPlaylist().slice(0, settings.maxVideos);
    if (!videos.length) { toast('WTYT found no videos on this page.'); return; }

    state.playlistRunning = true;
    btn.disabled = true;
    const tally = {};
    let done = 0;
    btn.textContent = `WTYT · 0/${videos.length}`;

    const queue = [...videos];
    // Show every row as Queued up front so nothing looks skipped while workers churn.
    for (const v of videos) { const r = freshRow(v); if (r) WTYT_CARDS.attach(r, WTYT_CARDS.renderPending('Queued', 'queued')); }
    state.playlistResults = new Map();
    setupPlaylistRehydrate();
    async function worker() {
      while (queue.length) {
        const video = queue.shift();
        try {
          WTYT_CARDS.attach(freshRow(video), WTYT_CARDS.renderPending('Fetching transcript…'));
          const a = await getAnalysis(video, settings, (s) =>
            WTYT_CARDS.attach(freshRow(video), WTYT_CARDS.renderPending(s))
          );
          if (a.error) WTYT_CARDS.attach(freshRow(video), WTYT_CARDS.renderError(a.error));
          else {
            const meta = videoMeta(video);
            state.playlistResults.set(video.id, { analysis: a, meta });
            WTYT_CARDS.attach(freshRow(video), WTYT_CARDS.render(a, { tools: true, video: meta }));
            tally[a.verdict] = (tally[a.verdict] || 0) + 1;
          }
        } catch (e) {
          WTYT_CARDS.attach(freshRow(video), WTYT_CARDS.renderError(e.message));
        }
        done++;
        btn.textContent = `WTYT · ${done}/${videos.length}`;
        await sleep(400);
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, settings.concurrency) }, () => worker()));

    state.playlistRunning = false;
    btn.disabled = false;
    btn.textContent = 'WTYT · Re-analyze';
    const parts = ['watch', 'read', 'skip'].filter((v) => tally[v]).map((v) => `${tally[v]} ${v}`);
    toast(`WTYT done. ${parts.join(' · ') || 'no verdicts'}`, 8000);
  }

  function ensurePlaylistFab() {
    const btn = ensureFab('WTYT · Analyze playlist', (b) => runPlaylist(b));
    maybeFirstRunHint(btn);
    return btn;
  }

  // Auto-score playlists (0.4.2): opt-in via settings.autoScorePlaylists. Guarded by
  // playlistAutoRunFor so repeat route() calls on the same list (YouTube can fire
  // yt-navigate-finish without a real navigation) don't re-trigger a fresh run.
  async function maybeAutoRunPlaylist(btn) {
    const settings = await getSettings();
    if (!settings.autoScorePlaylists || !settings.apiKey) return;
    const listId = params().get('list');
    if (state.playlistAutoRunFor === listId) return;
    state.playlistAutoRunFor = listId;
    runPlaylist(btn);
  }

  // ---- watch (auto) -------------------------------------------------------------

  async function waitFor(fn, tries = 20, gap = 300) {
    for (let i = 0; i < tries; i++) {
      const v = fn();
      if (v) return v;
      await sleep(gap);
    }
    return null;
  }

  async function handleWatch() {
    const settings = await getSettings();
    const video = WTYT_DATA.scanWatch();
    if (!video) return;
    if (state.watchId === video.id && document.querySelector('.wtyt-watch')) return;
    if (!settings.apiKey) return; // onboarding handles first-run; don't nag per video
    if (!settings.autoScoreVideos) {
      const rail = await waitFor(() => WTYT_DATA.watchRail());
      if (rail) attachWatchButton(rail, video, settings);
      return;
    }

    state.watchId = video.id;
    const rail = await waitFor(() => WTYT_DATA.watchRail());
    if (!rail) return;
    const pending = WTYT_CARDS.renderPending('WTYT · scoring this video…');
    pending.classList.add('wtyt-watch');
    WTYT_CARDS.attachWatch(rail, pending);

    const a = await getAnalysis(video, settings);
    if (state.watchId !== video.id) return; // user navigated away mid-flight
    if (a.error) {
      const err = WTYT_CARDS.renderError(a.error);
      err.classList.add('wtyt-watch');
      WTYT_CARDS.attachWatch(rail, err);
      return;
    }
    // Fail closed like the playlist path: a render throw must replace the spinner with an
    // error, never leave it hanging (state.watchId is set, so route() won't retry this video).
    try {
      WTYT_CARDS.attachWatch(rail, WTYT_CARDS.renderWatch(a, { tools: true, video: videoMeta(video) }));
    } catch (e) {
      const err = WTYT_CARDS.renderError('Could not render analysis: ' + (e.message || e));
      err.classList.add('wtyt-watch');
      WTYT_CARDS.attachWatch(rail, err);
    }
  }

  function attachWatchButton(rail, video, settings) {
    if (rail.querySelector(':scope > .wtyt-watch')) return;
    const btn = document.createElement('button');
    btn.className = 'wtyt-watch wtyt-inline-btn';
    btn.textContent = 'WTYT · Analyze this video';
    btn.onclick = async () => {
      btn.textContent = 'WTYT · scoring…';
      const a = await getAnalysis(video, settings);
      if (a.error) { const e = WTYT_CARDS.renderError(a.error); e.classList.add('wtyt-watch'); WTYT_CARDS.attachWatch(rail, e); }
      else WTYT_CARDS.attachWatch(rail, WTYT_CARDS.renderWatch(a, { tools: true, video: videoMeta(video) }));
    };
    WTYT_CARDS.attachWatch(rail, btn);
  }

  // ---- home (lazy, batch-then-continue) ----------------------------------------

  function teardownHome() {
    if (!state.home) return;
    state.home.io?.disconnect();
    state.home.mo?.disconnect();
    state.home = null;
  }

  async function handleHome() {
    teardownHome();
    const settings = await getSettings();
    if (!settings.apiKey) return; // silent on home; onboarding covers setup
    const home = { io: null, mo: null, queue: [], count: 0, paused: false, pumping: false, settings };
    state.home = home;

    home.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        home.io.unobserve(e.target);
        WTYT_CARDS.markHome(e.target.querySelector('yt-lockup-view-model'), 'queued');
        home.queue.push(e.target);
      }
      if (!home.paused) pumpHome(home);
    }, { rootMargin: '150px' });

    observeFeed(home);
    home.mo = new MutationObserver(() => observeFeed(home));
    home.mo.observe(document.body, { childList: true, subtree: true });

    if (!settings.autoScoreVideos) {
      home.paused = true;
      ensureFab('WTYT · Score home feed', () => resumeHome(home));
    }
  }

  function observeFeed(home) {
    for (const item of document.querySelectorAll('ytd-rich-item-renderer')) {
      if (item.dataset.wtytSeen) continue;
      item.dataset.wtytSeen = '1';
      const lk = item.querySelector('yt-lockup-view-model');
      if (item.querySelector('ytd-ad-slot-renderer')) { WTYT_CARDS.markHome(lk || item, 'ad'); continue; }
      if (!lk) continue;
      home.io.observe(item);
    }
  }

  // A small worker pool (mirrors the playlist pattern) — queue.shift() + the
  // count check/increment run synchronously between awaits, so concurrent workers
  // can't double-count or blow past homeBatch.
  async function homeWorker(home) {
    while (home.queue.length && !home.paused) {
      const item = home.queue.shift();
      if (!item) continue;
      const lk = item.querySelector('yt-lockup-view-model');
      if (!lk) continue;
      const video = WTYT_DATA.parseLockup(lk);
      if (!video) continue;

      const cached = await cacheGet(video.id, home.settings);
      if (cached) { WTYT_CARDS.attachHome(lk, cached); continue; } // free, doesn't count
      if (home.paused) break;

      if (home.count >= home.settings.homeBatch) { pauseHome(home); break; }
      home.count++;
      WTYT_CARDS.markHome(lk, 'scoring');
      const a = await getAnalysis(video, home.settings);
      if (a.error) WTYT_CARDS.markHome(lk, 'failed', { onRetry: () => retryHome(home, item) });
      else WTYT_CARDS.attachHome(lk, a);
      await sleep(250);
    }
  }

  // Re-queue a failed home tile for another pass (the "↻" on its Failed marker).
  function retryHome(home, item) {
    if (!home || home.paused) return;
    WTYT_CARDS.markHome(item.querySelector('yt-lockup-view-model'), 'queued');
    home.queue.push(item);
    pumpHome(home);
  }

  async function pumpHome(home) {
    if (home.pumping || home.paused) return;
    home.pumping = true;
    const workers = Math.max(1, home.settings.homeConcurrency || 2);
    await Promise.all(Array.from({ length: workers }, () => homeWorker(home)));
    home.pumping = false;
  }

  function pauseHome(home) {
    home.paused = true;
    ensureFab('Continue with WTYT scoring', () => resumeHome(home), true);
    toast(`Scored the top ${home.settings.homeBatch}. Continue with WTYT scoring?`, 7000);
  }

  function resumeHome(home) {
    home.paused = false;
    home.count = 0;
    removeFab();
    pumpHome(home);
  }

  // ---- router -------------------------------------------------------------------

  function route() {
    const surface = isWatchPage() ? 'watch' : isPlaylistPage() ? 'playlist' : isHomePage() ? 'home' : null;
    teardownHome();
    if (surface !== 'playlist') teardownPlaylist();
    // Always clear the FAB on every route; each surface re-adds its own if it needs one.
    // (Previously kept for home/playlist to avoid flicker, but that stranded a stale
    // "Analyze playlist" button on the home feed after a playlist → home navigation.)
    removeFab();
    if (surface !== 'watch') state.watchId = null;
    if (surface !== 'playlist') state.playlistAutoRunFor = null;
    state.surface = surface;

    if (surface === 'playlist') { const btn = ensurePlaylistFab(); maybeAutoRunPlaylist(btn); }
    else if (surface === 'watch') handleWatch();
    else if (surface === 'home') handleHome();
  }

  // YouTube is a SPA: route on its navigation event, plus initial load.
  window.addEventListener('yt-navigate-finish', () => setTimeout(route, 600));
  setTimeout(route, 800);
})();
