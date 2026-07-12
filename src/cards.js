// WTYT — card renderer.
// Built with createElement/textContent + WTYT_ICONS (SVG via createElementNS):
// YouTube enforces Trusted Types, so innerHTML from a content script throws.
// Three surfaces, two rich renderers: render() = full card (playlist + watch),
// the home feed gets a compact verdict pill + line-icon score row (H3).

const WTYT_CARDS = (() => {
  const READ_WPM = 238; // Brysbaert 2019 silent non-fiction reading rate

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
    skip: { label: 'SKIP', cls: 'wtyt-verdict-skip', icon: 'slop' },
  };

  function verdictPill(analysis) {
    const v = VERDICTS[analysis.verdict] || VERDICTS.skip;
    const pill = el('span', 'wtyt-verdict ' + v.cls);
    pill.append(icon(v.icon, 15), el('span', 'wtyt-verdict-label', v.label));
    return pill;
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
    row.append(iconChip('watch', 'Watch score', analysis.watch_score));
    row.append(iconChip('read', 'Read value', analysis.readability_score));
    row.append(iconChip('slop', 'Slop', analysis.ai_slop_score, true));
    return row;
  }

  // ---- full card (playlist + watch) --------------------------------------------

  function render(analysis, opts = {}) {
    const card = el('div', 'wtyt-card');

    const head = el('div', 'wtyt-head');
    head.append(verdictPill(analysis));
    head.append(el('span', 'wtyt-oneliner', analysis.one_liner || ''));
    card.append(head);

    const scores = el('div', 'wtyt-scores');
    scores.append(scoreChip('Watch', analysis.watch_score));
    scores.append(scoreChip('Read', analysis.readability_score));
    scores.append(scoreChip('Slop', analysis.ai_slop_score, true));
    card.append(scores);

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

    // Full transcript on demand, with the read-time value prop baked into the label.
    if (analysis.transcript_text) {
      const t = el('details', 'wtyt-details wtyt-transcript');
      if (opts.open) t.open = true;
      const src = analysis.transcript_source === 'auto-captions' ? 'View transcript (auto-captions)' : 'View transcript';
      t.append(summaryEl(`${src} · ~${readMinutes(analysis.transcript_text)} min read`));
      t.append(el('div', 'wtyt-transcript-body', analysis.transcript_text));
      card.append(t);
    }
    return card;
  }

  function renderPending(statusText) {
    const card = el('div', 'wtyt-card wtyt-pending');
    card.append(el('span', 'wtyt-spinner'));
    card.append(el('span', null, statusText || 'Analyzing…'));
    return card;
  }

  function renderError(message) {
    const card = el('div', 'wtyt-card wtyt-error');
    card.append(icon('close', 14), el('span', null, message));
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
    const host = row.querySelector('#meta') || row.querySelector('.ytLockupViewModelMetadata') || row;
    host.querySelectorAll(':scope > .wtyt-card').forEach((n) => n.remove());
    contain(card);
    host.append(card);
    return card;
  }

  // Watch: expansive panel, details + transcript open, injected atop the up-next rail.
  function renderWatch(analysis) {
    const card = render(analysis, { open: true });
    card.classList.add('wtyt-watch');
    const brand = el('span', 'wtyt-brand');
    brand.append(icon('play', 13), el('span', null, 'WTYT'));
    card.querySelector('.wtyt-head')?.append(brand);
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
    row.addEventListener('click', expand);
    meta.prepend(row);
  }

  return { render, renderPending, renderError, attach, renderWatch, attachWatch, attachHome };
})();
