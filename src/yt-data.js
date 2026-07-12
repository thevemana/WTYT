// WTYT — data layer.
// Runs in the content-script isolated world on www.youtube.com, so every fetch is
// same-origin with the user's own cookies: transcripts and comments come back the
// same way they would for the logged-in user, no OAuth and no server.

const WTYT_DATA = (() => {
  async function fetchText(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }

  // Extract a JSON object assigned inline in page HTML (e.g. `ytInitialPlayerResponse = {...};`)
  // by brace-matching from the first `{` after the marker. JSON.parse on a regex slice is not
  // reliable here — the blobs contain `};` sequences inside strings.
  function extractJson(html, marker) {
    const start = html.indexOf(marker);
    if (start === -1) return null;
    const braceStart = html.indexOf('{', start);
    if (braceStart === -1) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = braceStart; i < html.length; i++) {
      const c = html[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(html.slice(braceStart, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }

  function deepFind(node, predicate, results = [], depth = 0) {
    if (!node || typeof node !== 'object' || depth > 60) return results;
    if (predicate(node)) results.push(node);
    for (const v of Object.values(node)) deepFind(v, predicate, results, depth + 1);
    return results;
  }

  // "1.2M views" / "123,456 views" -> 1200000 / 123456
  function parseViews(text) {
    if (!text) return null;
    const m = text.replace(/ /g, ' ').match(/([\d.,]+)\s*([KMB])?/i);
    if (!m) return null;
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (Number.isNaN(n)) return null;
    const suffix = (m[2] || '').toUpperCase();
    if (suffix === 'K') n *= 1e3;
    else if (suffix === 'M') n *= 1e6;
    else if (suffix === 'B') n *= 1e9;
    return Math.round(n);
  }

  // ---------- row parsing (all surfaces) ----------
  // Two markups exist in the wild and YouTube flip-flops between them:
  //   - `yt-lockup-view-model` — the newer shape; home feed + watch up-next + (sometimes) playlist.
  //   - `ytd-playlist-video-renderer` — the older playlist row; verified live 2026-07-12 it is
  //     back on the playlist page (14 rows, zero lockups). So we parse BOTH, not one "retired" one.
  // Both parsers return the same shape: { id, row, title, channel, duration, viewsText, views }.

  function firstLine(text) {
    return (text || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  }

  function parseLockup(lockup) {
    const link = lockup.querySelector('a[href*="watch?v="]');
    if (!link) return null;
    const id = new URL(link.getAttribute('href'), location.origin).searchParams.get('v');
    if (!id) return null;
    const metaText = [...lockup.querySelectorAll(
      '.ytContentMetadataViewModelMetadataText, .yt-content-metadata-view-model-wiz__metadata-text'
    )].map((s) => s.textContent.trim()).filter(Boolean);
    const viewsText = metaText.find((t) => /view/i.test(t)) || '';
    return {
      id,
      row: lockup,
      title: (lockup.querySelector('.ytLockupMetadataViewModelTitle, h3')?.textContent || '').trim(),
      channel: metaText.find((t) => t && !/view|ago|streamed|watch|premiere/i.test(t)) || '',
      duration: (lockup.querySelector('.ytBadgeShapeText, .badge-shape-wiz__text')?.textContent || '').trim(),
      viewsText,
      views: parseViews(viewsText),
    };
  }

  // Legacy playlist row. Selectors verified live 2026-07-12 against a real playlist:
  // title `#video-title`, channel `ytd-channel-name` (text duplicates itself → take first line),
  // duration `#text.ytd-thumbnail-overlay-time-status-renderer`, views under `#video-info span`.
  function parsePlaylistRow(row) {
    const link = row.querySelector('a[href*="watch?v="]');
    if (!link) return null;
    const id = new URL(link.getAttribute('href'), location.origin).searchParams.get('v');
    if (!id) return null;
    const metaText = [...row.querySelectorAll('#video-info span, #metadata-line span')]
      .map((s) => s.textContent.trim())
      .filter((t) => t && t !== '•');
    const viewsText = metaText.find((t) => /view/i.test(t)) || '';
    return {
      id,
      row,
      title: (row.querySelector('#video-title')?.textContent || '').trim(),
      channel: firstLine(row.querySelector('ytd-channel-name')?.textContent),
      duration: firstLine(
        row.querySelector('#text.ytd-thumbnail-overlay-time-status-renderer, ytd-thumbnail-overlay-time-status-renderer #text')?.textContent
      ),
      viewsText,
      views: parseViews(viewsText),
    };
  }

  function scanRows(nodes, parse = parseLockup) {
    const out = [];
    const seen = new Set();
    for (const node of nodes) {
      if (node.closest('ytd-ad-slot-renderer')) continue; // skip ads
      const v = parse(node);
      if (!v || seen.has(v.id)) continue;
      seen.add(v.id);
      out.push(v);
    }
    return out;
  }

  // ---------- playlist page ----------
  // Scope to #primary so we don't over-count the related/secondary column (that's what
  // produced a "5/25" counter on a 15-video list). Support both markups: prefer the
  // legacy playlist rows when present (current live shape), else the lockup shape.
  function scanPlaylist() {
    const root = document.querySelector('ytd-two-column-browse-results-renderer #primary') ||
      document.querySelector('#primary') || document;
    const legacy = root.querySelectorAll('ytd-playlist-video-renderer');
    if (legacy.length) return scanRows(legacy, parsePlaylistRow);
    return scanRows(root.querySelectorAll('yt-lockup-view-model'), parseLockup);
  }

  // ---------- home feed ----------
  // Feed items are ytd-rich-item-renderer wrapping a lockup; the first item is often
  // an ad slot (no lockup) which is skipped.
  function scanFeed() {
    const nodes = [];
    for (const item of document.querySelectorAll('ytd-rich-item-renderer')) {
      if (item.querySelector('ytd-ad-slot-renderer')) continue;
      const lk = item.querySelector('yt-lockup-view-model');
      if (lk) nodes.push(lk);
    }
    return scanRows(nodes, parseLockup);
  }

  // ---------- watch page (current video) ----------
  function scanWatch() {
    const id = new URLSearchParams(location.search).get('v');
    if (!id) return null;
    return {
      id,
      row: null,
      title: (document.querySelector('#title h1, h1.ytd-watch-metadata, ytd-watch-metadata h1')?.textContent || '').trim(),
      channel: (document.querySelector('#owner #channel-name a, ytd-channel-name a, #upload-info a')?.textContent || '').trim(),
      duration: '',
      viewsText: (document.querySelector('#info-container span, .view-count, #info span')?.textContent || '').trim(),
      views: null,
    };
  }

  // Inject at the very top of the right column so the card sits ABOVE the playlist box
  // (ytd-playlist-panel-renderer is #secondary-inner's first child) and above the
  // recommendations, in both the playlist and non-playlist watch cases.
  function watchRail() {
    return document.querySelector('#secondary-inner') || document.querySelector('#secondary');
  }

  // ---------- watch page: one fetch feeds transcript + comments ----------

  async function fetchWatchPage(videoId) {
    const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}`);
    return {
      videoId,
      player: extractJson(html, 'ytInitialPlayerResponse'),
      initialData: extractJson(html, 'var ytInitialData') || extractJson(html, 'ytInitialData ='),
      apiKey: html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || null,
      clientVersion: html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] || '2.20250101.00.00',
    };
  }

  // ---------- transcript ----------

  function pickTrack(tracks) {
    return (
      tracks.find((t) => t.languageCode?.startsWith('en') && t.kind !== 'asr') ||
      tracks.find((t) => t.languageCode?.startsWith('en')) ||
      tracks[0] ||
      null
    );
  }

  async function fetchJson3(baseUrl) {
    const url = new URL(baseUrl, location.origin);
    url.searchParams.set('fmt', 'json3');
    const res = await fetch(url.toString(), { credentials: 'include' });
    if (!res.ok) return null;
    const body = await res.text();
    if (!body) return null; // empty 200 = missing proof-of-origin token on web caption URLs
    const data = JSON.parse(body);
    const text = (data.events || [])
      .flatMap((e) => e.segs || [])
      .map((s) => s.utf8 || '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    return text || null;
  }

  async function getTranscript(watch) {
    // Attempt 1: caption URLs from the web player response. Since 2025 YouTube
    // often serves these an empty 200 unless the player attached a proof-of-origin
    // token, but when they work they're the cheapest path.
    const webTracks = watch.player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const webTrack = pickTrack(webTracks);
    if (webTrack?.baseUrl) {
      try {
        const text = await fetchJson3(webTrack.baseUrl);
        if (text) {
          return { text, source: webTrack.kind === 'asr' ? 'auto-captions' : 'captions', lang: webTrack.languageCode };
        }
      } catch { /* fall through */ }
    }

    // Attempt 2 (the reliable one, verified live 2026-07): ask InnerTube for the
    // player response as the ANDROID client — its caption URLs carry no
    // proof-of-origin requirement.
    try {
      const result = await androidTranscript(watch);
      if (result) return result;
    } catch { /* no transcript */ }

    return { text: null, source: 'none', reason: webTracks.length ? 'caption fetch failed' : 'no caption tracks' };
  }

  async function androidTranscript(watch) {
    if (!watch.apiKey) return null;
    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=${watch.apiKey}&prettyPrint=false`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } },
          videoId: watch.videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const track = pickTrack(data.captions?.playerCaptionsTracklistRenderer?.captionTracks || []);
    if (!track?.baseUrl) return null;
    const text = await fetchJson3(track.baseUrl);
    if (!text) return null;
    return { text, source: track.kind === 'asr' ? 'auto-captions' : 'captions', lang: track.languageCode };
  }

  // ---------- top comments ----------

  async function getTopComments(watch, max = 20) {
    if (!watch.apiKey || !watch.initialData) return { comments: [], reason: 'missing api key or page data' };

    // The comments section is an itemSectionRenderer whose identifier mentions "comment";
    // its continuationCommand token is what /youtubei/v1/next expects.
    let token = null;
    const sections = deepFind(
      watch.initialData,
      (n) => n.itemSectionRenderer && /comment/i.test(n.itemSectionRenderer.sectionIdentifier || '')
    );
    for (const s of sections) {
      const conts = deepFind(s, (n) => n.continuationCommand?.token);
      if (conts.length) { token = conts[0].continuationCommand.token; break; }
    }
    if (!token) return { comments: [], reason: 'no comments continuation (comments may be off)' };

    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/next?key=${watch.apiKey}&prettyPrint=false`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion: watch.clientVersion } },
          continuation: token,
        }),
      }
    );
    if (!res.ok) return { comments: [], reason: `next endpoint HTTP ${res.status}` };
    const data = await res.json();

    // Modern shape: comment text lives in frameworkUpdates commentEntityPayload mutations.
    let comments = deepFind(data, (n) => n.commentEntityPayload).map((n) => {
      const c = n.commentEntityPayload;
      return {
        text: c.properties?.content?.content || '',
        author: c.author?.displayName || '',
        likes: c.toolbar?.likeCountNotliked || c.toolbar?.likeCountA11y || '0',
      };
    });
    // Legacy shape fallback
    if (!comments.length) {
      comments = deepFind(data, (n) => n.commentRenderer).map((n) => ({
        text: (n.commentRenderer.contentText?.runs || []).map((r) => r.text).join(''),
        author: n.commentRenderer.authorText?.simpleText || '',
        likes: n.commentRenderer.voteCount?.simpleText || '0',
      }));
    }
    comments = comments.filter((c) => c.text.trim());
    return { comments: comments.slice(0, max) };
  }

  return {
    scanPlaylist, scanFeed, scanWatch, watchRail, parseLockup, parsePlaylistRow,
    fetchWatchPage, getTranscript, getTopComments, parseViews, extractJson, deepFind,
  };
})();
