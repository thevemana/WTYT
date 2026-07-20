// WTYT — card renderer.
// Built with createElement/textContent + WTYT_ICONS (SVG via createElementNS):
// YouTube enforces Trusted Types, so innerHTML from a content script throws.
// Three surfaces, two rich renderers: render() = full card (playlist + watch),
// the home feed gets a compact verdict pill + line-icon score row (H3).

const WTYT_CARDS = (() => {
  const READ_WPM = 238; // Brysbaert 2019 silent non-fiction reading rate
  // Generic only earns a chip when it's a real negative signal — below this it's just
  // noise on a triage glance, so a clean video shows a two-bar Watch/Read row instead.
  const GENERIC_SHOW_AT = 60;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function icon(name, size, cls) {
    const s = WTYT_ICONS.svg(name, size);
    if (cls) s.classList.add(cls);
    return s;
  }
  const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));

  function readMinutes(text) {
    if (!text) return 0;
    return Math.max(1, Math.round(text.trim().split(/\s+/).length / READ_WPM));
  }

  const VERDICTS = {
    watch: { label: 'WATCH', cls: 'wtyt-verdict-watch', icon: 'watch' },
    read: { label: 'READ', cls: 'wtyt-verdict-read', icon: 'read' },
    listen: { label: 'LISTEN', cls: 'wtyt-verdict-listen', icon: 'listen' },
    skip: { label: 'SKIP', cls: 'wtyt-verdict-skip', icon: 'slop' },
  };

  // Secondary tag: a primary verdict can carry one "and also…" note (computed in background.js
  // as analysis.secondary_tag — keep these label keys in sync with that logic).
  const SECONDARY = { strong_read: 'also a strong read', watchable: 'also worth watching' };
  // AI-provenance badge labels — only ai_assisted / ai_generated ever surface (human is silent).
  const PROVENANCE = { ai_assisted: 'AI-assisted', ai_generated: 'AI-generated' };

  function verdictPill(analysis) {
    const v = VERDICTS[analysis.verdict] || VERDICTS.skip;
    const pill = el('span', 'wtyt-verdict ' + v.cls);
    pill.append(icon(v.icon, 15), el('span', 'wtyt-verdict-label', v.label));
    return pill;
  }

  // ---- live / upcoming markers (0.7.0) -----------------------------------------
  // Live streams and un-aired premieres have no finished transcript, so we never score them —
  // we mark them and move on (no API call). Reuses the verdict-pill shape with its own colors.
  const MARKERS = {
    live: { label: 'LIVE', cls: 'wtyt-verdict-live', icon: 'live', note: 'Live now — nothing to score until it ends.' },
    upcoming: { label: 'UPCOMING', cls: 'wtyt-verdict-upcoming', icon: 'clock', note: 'Hasn’t aired yet — nothing to score.' },
  };
  function markerPill(kind) {
    const m = MARKERS[kind] || MARKERS.live;
    const pill = el('span', 'wtyt-verdict ' + m.cls);
    pill.append(icon(m.icon, 15), el('span', 'wtyt-verdict-label', m.label));
    return pill;
  }
  // Small card for playlist / search / watch: just the marker + a one-line reason.
  function renderMarker(kind) {
    const m = MARKERS[kind] || MARKERS.live;
    const card = el('div', 'wtyt-card wtyt-card-minimal wtyt-marker-card');
    const head = el('div', 'wtyt-head');
    head.append(markerPill(kind));
    card.append(head);
    card.append(el('p', 'wtyt-oneliner', m.note));
    return card;
  }
  // Home tile: pin the marker in the same thumbnail slot the verdict pill would take.
  function markHomeMarker(lockup, kind) {
    if (!lockup) return;
    const imageHost = lockup.querySelector('.ytLockupViewModelContentImage, ytd-thumbnail, #thumbnail')
      || lockup.querySelector('a[href*="watch?v="]');
    if (!imageHost) return;
    imageHost.classList.add('wtyt-image-host');
    imageHost.querySelectorAll(':scope > .wtyt-pill-overlay').forEach((n) => n.remove());
    const pill = markerPill(kind);
    pill.classList.add('wtyt-pill-overlay');
    imageHost.append(pill);
  }

  function secondaryTag(analysis) {
    const label = SECONDARY[analysis.secondary_tag];
    return label ? el('span', 'wtyt-secondary', '(' + label + ')') : null;
  }

  // Gated 2-state: show a badge ONLY when the model is highly confident it isn't human-made.
  // A wrong "AI-generated" label on a real creator is worse than a missed one, so low/med → nothing.
  function aiBadge(analysis) {
    if (analysis.ai_confidence !== 'high') return null;
    const label = PROVENANCE[analysis.ai_provenance];
    if (!label) return null;
    const badge = el('span', 'wtyt-aibadge');
    badge.append(icon('ai', 13), el('span', null, label));
    return badge;
  }

  function summaryEl(text) {
    const s = el('summary', 'wtyt-summary');
    s.append(icon('chevron', 14, 'wtyt-summary-chevron'), el('span', 'wtyt-summary-text', text));
    return s;
  }

  // full-card score bar
  function scoreChip(label, value, invert) {
    const chip = el('span', 'wtyt-score');
    chip.append(el('span', 'wtyt-score-label', label));
    const bar = el('span', 'wtyt-score-bar');
    const fill = el('span', 'wtyt-score-fill');
    const v = clamp(value);
    fill.style.width = v + '%';
    const good = invert ? v < 40 : v >= 60;
    const bad = invert ? v >= 60 : v < 40;
    fill.classList.add(good ? 'wtyt-fill-good' : bad ? 'wtyt-fill-bad' : 'wtyt-fill-mid');
    bar.append(fill);
    chip.append(bar, el('span', 'wtyt-score-num', String(v)));
    return chip;
  }

  // compact home chip: line icon + number, color-coded, tooltip for the metric name
  function iconChip(iconName, label, value, invert) {
    const v = clamp(value);
    const good = invert ? v < 40 : v >= 60;
    const bad = invert ? v >= 60 : v < 40;
    const chip = el('span', 'wtyt-chip');
    chip.title = label;
    chip.append(icon(iconName, 17, good ? 'wtyt-ic-good' : bad ? 'wtyt-ic-bad' : 'wtyt-ic-mid'));
    chip.append(el('span', 'wtyt-chip-num', String(v)));
    return chip;
  }

  function scoreRow(analysis) {
    const row = el('div', 'wtyt-scorerow');
    if (analysis.verdict === 'listen') return row; // music: score axes don't apply
    row.append(iconChip('watch', 'Watch score', analysis.watch_score));
    row.append(iconChip('read', 'Read value', analysis.readability_score));
    if (Number(analysis.generic_score) >= GENERIC_SHOW_AT) {
      row.append(iconChip('slop', 'Generic — higher is worse', analysis.generic_score, true));
    }
    const badge = aiBadge(analysis);
    if (badge) { badge.classList.add('wtyt-aibadge-chip'); row.append(badge); }
    return row;
  }

  // A saved/openable note = the analysis fields + the video meta. Built here so the
  // Save button and the reader chip carry identical data. Thumbnail is derived, no blob.
  function buildNote(analysis, video) {
    return {
      ...analysis,
      id: video.id,
      url: video.url || `https://www.youtube.com/watch?v=${video.id}`,
      title: video.title || '',
      channel: video.channel || '',
      thumbnail: `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`,
    };
  }

  // Head toolbar (playlist + watch only — never home): a clickable "~N min read" chip
  // that opens the reader overlay, and a Save button that stashes the note.
  function toolbar(analysis, video) {
    const note = buildNote(analysis, video);
    const tools = el('div', 'wtyt-tools');

    if (analysis.transcript_text) {
      const chip = el('button', 'wtyt-tool wtyt-readtime');
      chip.type = 'button';
      chip.append(icon('read', 14), el('span', null, `~${readMinutes(analysis.transcript_text)} min read`));
      chip.addEventListener('click', (e) => { e.stopPropagation(); WTYT_METRICS.bump('button', { name: 'readtime' }); WTYT_READER.openOverlay(note); });
      tools.append(chip);
    }

    // Save toggle, kept in sync across the card and the reader overlay via a window event
    // (both live in the page) so saving in one place updates the other without a reload.
    const save = el('button', 'wtyt-tool wtyt-save', 'Save');
    save.type = 'button';
    let saved = false;
    const reflect = (isSaved) => {
      saved = isSaved;
      save.textContent = isSaved ? 'Saved ✓' : 'Save';
      save.classList.toggle('wtyt-saved', isSaved);
    };
    WTYT_NOTES.get(note.id).then((n) => reflect(!!n));
    window.addEventListener('wtyt-note-changed', (e) => { if (e.detail && e.detail.id === note.id) reflect(e.detail.saved); });
    save.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !saved;
      WTYT_METRICS.bump('button', { name: 'save' });
      if (next) WTYT_METRICS.bump('noteSaved');
      (next ? WTYT_NOTES.save(note) : WTYT_NOTES.remove(note.id)).then(() =>
        window.dispatchEvent(new CustomEvent('wtyt-note-changed', { detail: { id: note.id, saved: next } }))
      );
    });
    tools.append(save);

    // Jump to the saved-notes page — there was no way to reach it from a card before.
    const notesLink = el('button', 'wtyt-tool wtyt-noteslink', 'Notes ↗');
    notesLink.type = 'button';
    notesLink.title = 'Open your saved notes';
    notesLink.addEventListener('click', (e) => { e.stopPropagation(); WTYT_METRICS.bump('button', { name: 'notesLink' }); chrome.runtime.sendMessage({ type: 'openNotes' }); });
    tools.append(notesLink);
    return tools;
  }

  // ---- full card (playlist + watch) --------------------------------------------

  function render(analysis, opts = {}) {
    const card = el('div', 'wtyt-card');

    // Line 1: verdict pill left, actions (read-time chip + Save) pinned right. Nothing
    // variable-width sits between them, so this row never wraps regardless of card width.
    const head = el('div', 'wtyt-head');
    const pill = verdictPill(analysis);
    // The verdict pill opens the reader too (same as the read-time chip) when there's content.
    if (opts.tools && opts.video && analysis.transcript_text) {
      pill.classList.add('wtyt-clickable');
      pill.addEventListener('click', (e) => { e.stopPropagation(); WTYT_METRICS.bump('button', { name: 'verdictOpen' }); WTYT_READER.openOverlay(buildNote(analysis, opts.video)); });
    }
    head.append(pill);
    if (opts.tools && opts.video) head.append(toolbar(analysis, opts.video));
    card.append(head);

    // Line 2: the full one-liner on its own line — never truncated.
    if (analysis.one_liner) card.append(el('p', 'wtyt-oneliner', analysis.one_liner));

    // Quiet aside beneath the one-liner: secondary "and also…" tag + gated AI badge.
    const sec = secondaryTag(analysis);
    const badge = aiBadge(analysis);
    if (sec || badge) {
      const aside = el('div', 'wtyt-aside');
      if (sec) aside.append(sec);
      if (badge) aside.append(badge);
      card.append(aside);
    }

    if (analysis.verdict === 'listen') { // music: watch/read/generic axes are N/A
      card.classList.add('wtyt-card-minimal'); // reads as a deliberate stop, not a cut-off card
    } else {
      const scores = el('div', 'wtyt-scores');
      scores.append(scoreChip('Watch', analysis.watch_score));
      scores.append(scoreChip('Read', analysis.readability_score));
      if (Number(analysis.generic_score) >= GENERIC_SHOW_AT) {
        const g = scoreChip('Generic', analysis.generic_score, true);
        g.title = 'How generic / low-effort this is — higher is worse';
        scores.append(g);
      }
      card.append(scores);
    }

    // Free-tier fallback: the chosen model was tapped out for the day, so a backup scored this.
    if (analysis.model_fallback) {
      card.append(el('div', 'wtyt-fallback-note', '⚡ Backup model — daily limit reached'));
    }

    if (analysis.community_check && analysis.community_check.note) {
      const cc = analysis.community_check;
      const chip = el('div', cc.agrees ? 'wtyt-community wtyt-community-ok' : 'wtyt-community wtyt-community-warn');
      chip.append(icon(cc.agrees ? 'check' : 'warn', 15, 'wtyt-community-icon'));
      const checked = cc.comments_checked ? ` (${cc.comments_checked} comments checked)` : '';
      chip.append(el('span', null, cc.note + checked));
      card.append(chip);
    }

    if ((analysis.key_takeaways || []).length || analysis.read_instead) {
      const details = el('details', 'wtyt-details');
      if (opts.open) details.open = true;
      details.append(summaryEl(analysis.verdict === 'read' ? 'Read it instead' : 'Details'));
      if ((analysis.key_takeaways || []).length) {
        const ul = el('ul', 'wtyt-takeaways');
        for (const t of analysis.key_takeaways) ul.append(el('li', null, t));
        details.append(ul);
      }
      if (analysis.read_instead) details.append(el('p', 'wtyt-read-instead', analysis.read_instead));
      if (analysis.transcript_note) details.append(el('p', 'wtyt-note', analysis.transcript_note));
      card.append(details);
    }

    // Full transcript on demand. The read-time value prop is baked into the label only
    // when there's no head toolbar chip already showing it (playlist/watch) — the home
    // expand card has no toolbar, so it keeps the read-time here.
    if (analysis.transcript_text) {
      const t = el('details', 'wtyt-details wtyt-transcript');
      if (opts.open) t.open = true;
      const src = analysis.transcript_source === 'auto-captions' ? 'View transcript (auto-captions)' : 'View transcript';
      const label = opts.tools ? src : `${src} · ~${readMinutes(analysis.transcript_text)} min read`;
      t.append(summaryEl(label));
      t.append(el('div', 'wtyt-transcript-body', analysis.transcript_text));
      card.append(t);
    }
    return card;
  }

  function renderPending(statusText, state) {
    // Skeleton reserves roughly a card's height so the queued→scoring→result swap doesn't shift the page.
    const card = el('div', 'wtyt-card wtyt-pending wtyt-skeleton');
    // Match the home lifecycle icons: a clock for a queued row, the spinner while scoring.
    card.append(state === 'queued' ? icon('clock', 14, 'wtyt-pending-ic') : el('span', 'wtyt-spinner'));
    card.append(el('span', null, statusText || 'Analyzing…'));
    return card;
  }

  function renderError(message, opts = {}) {
    const card = el('div', 'wtyt-card wtyt-error');
    card.append(icon('warn', 14), el('span', null, message));
    if (opts.onRetry) {
      const r = el('button', 'wtyt-retry-btn');
      r.type = 'button';
      r.append(icon('retry', 13), el('span', null, 'Retry'));
      r.addEventListener('click', (e) => { e.stopPropagation(); opts.onRetry(); });
      card.append(r);
    }
    return card;
  }

  // ---- attachment per surface --------------------------------------------------

  // Contain clicks so nothing inside our UI navigates YouTube's row/lockup.
  function contain(node) {
    node.addEventListener('click', (e) => e.stopPropagation());
    return node;
  }

  // Playlist: mount inside the row's metadata column (v2 behaviour).
  function attach(row, card) {
    if (!row) return card; // row virtualized away mid-run — nothing to attach to (yet)
    const host = row.querySelector('#meta') || row.querySelector('.ytLockupViewModelMetadata') || row;
    host.querySelectorAll(':scope > .wtyt-card').forEach((n) => n.remove());
    contain(card);
    host.append(card);
    return card;
  }

  // Drop just the pending/scoring skeleton from a row (leaves a real result card alone) —
  // used when a queued row is abandoned on a Manual flip so it doesn't sit frozen (item-4).
  function detachPending(row) {
    if (!row) return;
    const host = row.querySelector('#meta') || row.querySelector('.ytLockupViewModelMetadata') || row;
    host.querySelectorAll(':scope > .wtyt-card.wtyt-pending').forEach((n) => n.remove());
  }

  // Watch: expansive panel, details + transcript open, injected atop the up-next rail.
  function renderWatch(analysis, opts = {}) {
    const card = render(analysis, { open: true, ...opts });
    card.classList.add('wtyt-watch');
    const brand = el('span', 'wtyt-brand');
    brand.append(icon('play', 13), el('span', null, 'WTYT'));
    // Brand lives in the top toolbar row (with the read-time chip + Save), pushed to the
    // right by .wtyt-brand's own margin-left:auto. Falls back to the head row on the
    // rare card that has no toolbar (opts.tools/video missing).
    const tools = card.querySelector('.wtyt-tools');
    if (tools) tools.append(brand);
    else card.querySelector('.wtyt-head')?.append(brand);
    return contain(card);
  }
  function attachWatch(container, card) {
    container.querySelectorAll(':scope > .wtyt-watch').forEach((n) => n.remove());
    container.prepend(card);
    return card;
  }

  // Home (H3): verdict pill pinned to the thumbnail, line-icon score row under the
  // image; clicking either expands the full card inline.
  function toggleHome(meta, analysis) {
    const open = meta.querySelector(':scope > .wtyt-home-expand');
    if (open) { open.remove(); return; }
    const card = render(analysis);
    card.classList.add('wtyt-home-expand');
    contain(card);
    meta.append(card);
  }

  // ---- lifecycle state markers (0.4.1) -----------------------------------------
  // Every scoreable tile shows a state before/while scoring so nothing reads as
  // "skipped": queued → scoring → verdict. Ads get a static AD chip.
  const STATE = {
    queued: { icon: 'clock', label: 'Queued' },
    scoring: { icon: 'spinner', label: 'Scoring' },
    failed: { icon: 'warn', label: 'Failed' },
    ad: { icon: null, label: 'AD' },
  };

  function stateOverlay(name, opts = {}) {
    const spec = STATE[name] || STATE.queued;
    const pill = el('span', 'wtyt-pill-overlay wtyt-state wtyt-state-' + name);
    if (spec.icon) pill.append(icon(spec.icon, 14));
    pill.append(el('span', 'wtyt-state-label', spec.label));
    if (name === 'failed' && opts.onRetry) {
      const r = el('button', 'wtyt-state-retry');
      r.type = 'button';
      r.title = 'Retry';
      r.append(icon('retry', 12));
      r.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); opts.onRetry(); });
      pill.append(r);
    }
    return pill;
  }

  // Pin a lifecycle marker on a home tile's thumbnail — the same slot the verdict pill
  // takes once scored, so the transition is a clean swap (attachHome clears prior overlays).
  function markHome(lockup, name, opts = {}) {
    if (!lockup) return;
    const imageHost = lockup.querySelector('.ytLockupViewModelContentImage, ytd-thumbnail, #thumbnail')
      || lockup.querySelector('a[href*="watch?v="]');
    if (!imageHost) return;
    imageHost.classList.add('wtyt-image-host');
    imageHost.querySelectorAll(':scope > .wtyt-pill-overlay').forEach((n) => n.remove());
    imageHost.append(stateOverlay(name, opts));
  }

  // Drop just the lifecycle-state overlay from a home tile (leaves a scored verdict pill alone) —
  // the home counterpart of detachPending, for a queued tile abandoned on a Manual flip (item-4).
  function clearHomeState(lockup) {
    if (!lockup) return;
    const imageHost = lockup.querySelector('.ytLockupViewModelContentImage, ytd-thumbnail, #thumbnail')
      || lockup.querySelector('a[href*="watch?v="]');
    imageHost?.querySelectorAll(':scope > .wtyt-pill-overlay.wtyt-state').forEach((n) => n.remove());
  }

  // Direct child of `container` that contains (or is) `node` — used to anchor the score
  // row immediately above the title's own top-level wrapper, regardless of how deep the
  // title text node sits inside YouTube's metadata markup.
  function directChild(container, node) {
    let n = node;
    while (n && n.parentElement !== container) n = n.parentElement;
    return n;
  }

  function attachHome(lockup, analysis) {
    const imageHost = lockup.querySelector('.ytLockupViewModelContentImage') || lockup.querySelector('a[href*="watch?v="]');
    const meta = lockup.querySelector('.ytLockupViewModelMetadata') || lockup;
    const expand = (e) => { e.stopPropagation(); e.preventDefault(); toggleHome(meta, analysis); };

    if (imageHost) {
      imageHost.classList.add('wtyt-image-host');
      imageHost.querySelectorAll(':scope > .wtyt-pill-overlay').forEach((n) => n.remove());
      const pill = verdictPill(analysis);
      pill.classList.add('wtyt-pill-overlay');
      pill.addEventListener('click', expand);
      imageHost.append(pill);
    }
    meta.querySelectorAll(':scope > .wtyt-scorerow, :scope > .wtyt-home-expand').forEach((n) => n.remove());
    const row = scoreRow(analysis);
    if (row.childNodes.length) { // listen verdict yields an empty row — skip it
      row.prepend(icon('check', 14, 'wtyt-scored-tick')); // done-tick: "this has been scored"
      row.addEventListener('click', expand);
      // Insert directly before the title's own wrapper so the row is always line 1 and
      // the title is always line 2, however many siblings (avatar, channel line…) meta
      // actually has — a blind prepend would only guarantee that by luck.
      const titleEl = meta.querySelector('.ytLockupMetadataViewModelTitle, h3');
      const anchor = titleEl && directChild(meta, titleEl);
      if (anchor) meta.insertBefore(row, anchor);
      else meta.prepend(row);
    }
  }

  return {
    render, renderPending, renderError, attach, detachPending, renderWatch, attachWatch,
    attachHome, markHome, clearHomeState, renderMarker, markHomeMarker,
  };
})();
