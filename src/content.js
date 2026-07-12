// WTYT — orchestrator + surface router.
// Playlist: button-triggered scan (unchanged). Watch: auto-scores the current video
// and pins an expansive card atop the up-next rail. Home: lazy-scores videos as they
// scroll in, in batches, then a "Continue" button resumes. All three share getAnalysis.

(() => {
  const CACHE_PREFIX = 'wtyt:';
  const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

  const DEFAULT_SETTINGS = {
    provider: 'anthropic',
    anthropicKey: '',
    groqKey: '',
    geminiKey: '', // legacy pre-0.3.2 key, kept for stale-install fallback
    apiKey: '', // legacy pre-v2 Anthropic key
    model: 'claude-haiku-4-5-20251001',
    maxVideos: 25,
    commentViewThreshold: 100000,
    concurrency: 2,
    homeConcurrency: 2,
    autoAnalyze: true,
    homeBatch: 16,
  };

  const state = {
    surface: null,
    playlistRunning: false,
    watchId: null,
    home: null, // { io, mo, queue, count, paused, pumping, settings }
  };

  // The active key depends on the chosen provider; older installs only have `apiKey`.
  function resolveKey(items) {
    const provider = items.provider || 'anthropic';
    if (provider === 'groq') return items.groqKey || '';
    if (provider === 'gemini') return items.geminiKey || ''; // stale pre-0.3.2 install
    return items.anthropicKey || items.apiKey || '';
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        const provider = items.provider || 'anthropic';
        let model = items.model;
        // Heal stale saved Gemini models retired in 2026 (2.0 / 2.5 lines).
        if (provider === 'gemini' && /^gemini-2/.test(model || '')) model = 'gemini-3.5-flash';
        resolve({ ...items, provider, model, apiKey: resolveKey(items) });
      })
    );
  }

  function cacheGet(videoId) {
    return new Promise((resolve) =>
      chrome.storage.local.get(CACHE_PREFIX + videoId, (items) => {
        const hit = items[CACHE_PREFIX + videoId];
        resolve(hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.analysis : null);
      })
    );
  }
  function cacheSet(videoId, analysis) {
    chrome.storage.local.set({ [CACHE_PREFIX + videoId]: { at: Date.now(), analysis } });
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
    const cached = await cacheGet(video.id);
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
      transcript: { text: transcript.text ? transcript.text.slice(0, 20000) : null, source: transcript.source },
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
    if (comments.comments.length && analysis.community_check) {
      analysis.community_check.comments_checked = comments.comments.length;
    } else {
      delete analysis.community_check;
    }

    cacheSet(video.id, analysis);
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
    async function worker() {
      while (queue.length) {
        const video = queue.shift();
        try {
          WTYT_CARDS.attach(freshRow(video), WTYT_CARDS.renderPending('Fetching transcript…'));
          const a = await getAnalysis(video, settings, (s) =>
            WTYT_CARDS.attach(freshRow(video), WTYT_CARDS.renderPending(s))
          );
          if (a.error) WTYT_CARDS.attach(freshRow(video), WTYT_CARDS.renderError(a.error));
          else { WTYT_CARDS.attach(freshRow(video), WTYT_CARDS.render(a)); tally[a.verdict] = (tally[a.verdict] || 0) + 1; }
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
    if (!settings.autoAnalyze) {
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
    WTYT_CARDS.attachWatch(rail, WTYT_CARDS.renderWatch(a));
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
      else WTYT_CARDS.attachWatch(rail, WTYT_CARDS.renderWatch(a));
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
        home.queue.push(e.target);
      }
      if (!home.paused) pumpHome(home);
    }, { rootMargin: '150px' });

    observeFeed(home);
    home.mo = new MutationObserver(() => observeFeed(home));
    home.mo.observe(document.body, { childList: true, subtree: true });

    if (!settings.autoAnalyze) {
      home.paused = true;
      ensureFab('WTYT · Score home feed', () => resumeHome(home));
    }
  }

  function observeFeed(home) {
    for (const item of document.querySelectorAll('ytd-rich-item-renderer')) {
      if (item.dataset.wtytSeen) continue;
      item.dataset.wtytSeen = '1';
      if (item.querySelector('ytd-ad-slot-renderer') || !item.querySelector('yt-lockup-view-model')) continue;
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

      const cached = await cacheGet(video.id);
      if (cached) { WTYT_CARDS.attachHome(lk, cached); continue; } // free, doesn't count
      if (home.paused) break;

      if (home.count >= home.settings.homeBatch) { pauseHome(home); break; }
      home.count++;
      const a = await getAnalysis(video, home.settings);
      if (!a.error) WTYT_CARDS.attachHome(lk, a);
      await sleep(250);
    }
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
    // Always clear the FAB on every route; each surface re-adds its own if it needs one.
    // (Previously kept for home/playlist to avoid flicker, but that stranded a stale
    // "Analyze playlist" button on the home feed after a playlist → home navigation.)
    removeFab();
    if (surface !== 'watch') state.watchId = null;
    state.surface = surface;

    if (surface === 'playlist') ensurePlaylistFab();
    else if (surface === 'watch') handleWatch();
    else if (surface === 'home') handleHome();
  }

  // YouTube is a SPA: route on its navigation event, plus initial load.
  window.addEventListener('yt-navigate-finish', () => setTimeout(route, 600));
  setTimeout(route, 800);
})();
