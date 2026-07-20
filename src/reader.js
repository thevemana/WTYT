// WTYT — reader view. One module, two homes: the in-page overlay on YouTube
// (content_scripts) and the saved-notes page (an extension page). Both mount the
// same readerCard, so the reader is a standalone module like icons.js/cards.js —
// it can't share a live instance across those two worlds.
//
// Trusted-Types-safe throughout: createElement/textContent + WTYT_ICONS (never
// innerHTML of note data), so it renders identically under YouTube's Trusted Types.
// Loads BEFORE cards.js (see manifest order), so it must not reference WTYT_CARDS.

const WTYT_READER = (() => {
  // Verdict palette + icon, kept in sync with cards.js VERDICTS (this module loads
  // first, so it can't borrow that map — a small deliberate duplication).
  const VERDICTS = {
    watch: { label: 'WATCH', bg: '#249236', icon: 'watch' },
    read: { label: 'READ', bg: '#3170c7', icon: 'read' },
    listen: { label: 'LISTEN', bg: '#7c4dff', icon: 'listen' },
    skip: { label: 'SKIP', bg: '#7d7d7d', icon: 'slop' },
  };

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

  // Split a run-on caption blob into readable paragraphs: group sentences a few at a
  // time. Caption text has no paragraph structure of its own, so this is heuristic —
  // enough to make the wall of text scannable, not a true re-segmentation.
  function formatTranscript(text) {
    if (!text) return [];
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const sentences = clean.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [clean];
    const perPara = 4;
    const paras = [];
    for (let i = 0; i < sentences.length; i += perPara) {
      const p = sentences.slice(i, i + perPara).join(' ').trim();
      if (p) paras.push(p);
    }
    return paras;
  }

  // Exported so the notes page reuses the exact same pill (no third copy of the map).
  function verdictPill(note) {
    const v = VERDICTS[note.verdict] || VERDICTS.skip;
    const pill = el('span', 'wtyt-reader-pill');
    pill.style.background = v.bg;
    pill.append(icon(v.icon, 14), el('span', 'wtyt-reader-pill-label', v.label));
    return pill;
  }

  // Last-resort recovery when a note carries no title (a stale scrape). Only trusted on
  // an actual YouTube tab — document.title on the notes.html page is just "WTYT · Saved
  // notes", not the video's title, so that world always falls through to 'Untitled'.
  function fallbackTitle() {
    if (/(^|\.)youtube\.com$/i.test(location.hostname)) {
      const t = (document.title || '').replace(/\s*-\s*YouTube\s*$/i, '').trim();
      if (t) return t;
    }
    return 'Untitled';
  }

  // Mirrors cards.js toolbar()'s Save button: same WTYT_NOTES.save() call, same
  // "Saved ✓" feedback. Re-saving an already-saved note (opened from the notes grid)
  // is harmless — it just refreshes the record under the same id.
  // Reflects saved state and toggles save ↔ unsave — so opening an already-saved note from
  // the notes grid shows "Saved ✓" (click to remove), not a redundant Save.
  function saveButton(note) {
    const btn = el('button', 'wtyt-reader-save', 'Save');
    btn.type = 'button';
    let saved = false;
    const reflect = (isSaved) => {
      saved = isSaved;
      btn.textContent = isSaved ? 'Saved ✓' : 'Save';
      btn.classList.toggle('wtyt-reader-saved', isSaved);
    };
    WTYT_NOTES.get(note.id).then((n) => reflect(!!n));
    // Stay in sync with the card's Save button (same page) so a save/unsave here reflects there live.
    window.addEventListener('wtyt-note-changed', (e) => { if (e.detail && e.detail.id === note.id) reflect(e.detail.saved); });
    btn.addEventListener('click', () => {
      const next = !saved;
      WTYT_METRICS.bump('button', { name: 'save' });
      if (next) WTYT_METRICS.bump('noteSaved');
      (next ? WTYT_NOTES.save(note) : WTYT_NOTES.remove(note.id)).then(() =>
        window.dispatchEvent(new CustomEvent('wtyt-note-changed', { detail: { id: note.id, saved: next } }))
      );
    });
    return btn;
  }

  function readerCard(note) {
    const card = el('div', 'wtyt-reader-card');

    const head = el('div', 'wtyt-reader-head');
    head.append(verdictPill(note));
    const titles = el('div', 'wtyt-reader-titles');
    titles.append(el('div', 'wtyt-reader-title', note.title || fallbackTitle()));
    if (note.channel) titles.append(el('div', 'wtyt-reader-channel', note.channel));
    head.append(titles);
    if (typeof WTYT_NOTES !== 'undefined' && note.id) head.append(saveButton(note));
    card.append(head);

    const summary = el('div', 'wtyt-reader-summary');
    if (note.one_liner) summary.append(el('p', 'wtyt-reader-oneliner', note.one_liner));
    if ((note.key_takeaways || []).length) {
      const ul = el('ul', 'wtyt-reader-takeaways');
      for (const t of note.key_takeaways) ul.append(el('li', null, t));
      summary.append(ul);
    }
    if (note.read_instead) {
      const ri = el('p', 'wtyt-reader-instead');
      ri.append(el('strong', null, 'Read instead: '), el('span', null, note.read_instead));
      summary.append(ri);
    }
    if (summary.childNodes.length) card.append(summary);

    const paras = formatTranscript(note.transcript_text);
    if (paras.length) {
      const body = el('div', 'wtyt-reader-transcript');
      const label = note.transcript_source === 'auto-captions' ? 'Transcript (auto-captions)' : 'Transcript';
      body.append(el('h3', 'wtyt-reader-h', label));
      for (const p of paras) body.append(el('p', 'wtyt-reader-para', p));
      card.append(body);
    } else if (!summary.childNodes.length) {
      card.append(el('p', 'wtyt-reader-empty', 'No summary or transcript was saved for this video.'));
    }

    if (note.url) {
      const open = el('a', 'wtyt-reader-open', 'Open on YouTube ↗');
      open.href = note.url;
      open.target = '_blank';
      open.rel = 'noopener';
      card.append(open);
    }
    return card;
  }

  function openOverlay(note) {
    WTYT_METRICS.bump('summaryRead');
    injectStyle();
    document.querySelectorAll('.wtyt-reader-overlay').forEach((n) => n.remove());
    const overlay = el('div', 'wtyt-reader-overlay');
    const modal = el('div', 'wtyt-reader-modal');
    const close = el('button', 'wtyt-reader-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.append(icon('close', 20));
    modal.append(close, readerCard(note));
    overlay.append(modal);

    const dismiss = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
    close.addEventListener('click', dismiss);
    document.addEventListener('keydown', onKey);
    (document.body || document.documentElement).append(overlay);
    return overlay;
  }

  // Self-contained styling, injected once per page. Works in both worlds: html[dark]
  // covers YouTube's dark theme, prefers-color-scheme covers the notes page.
  let styled = false;
  function injectStyle() {
    if (styled) return;
    styled = true;
    const style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  const CSS = `
.wtyt-reader-overlay {
  --rd-text: #0f0f0f; --rd-text-2: #606060; --rd-bg: #ffffff;
  --rd-layer: rgba(0,0,0,0.05); --rd-border: rgba(0,0,0,0.12);
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: flex-start; justify-content: center;
  padding: 48px 16px; overflow-y: auto;
  background: rgba(0,0,0,0.55);
  font-family: 'Roboto', system-ui, Arial, sans-serif;
}
html[dark] .wtyt-reader-overlay {
  --rd-text: #f1f1f1; --rd-text-2: #aaaaaa; --rd-bg: #1c1c1c;
  --rd-layer: rgba(255,255,255,0.07); --rd-border: rgba(255,255,255,0.16);
}
@media (prefers-color-scheme: dark) {
  .wtyt-reader-overlay {
    --rd-text: #f1f1f1; --rd-text-2: #aaaaaa; --rd-bg: #1c1c1c;
    --rd-layer: rgba(255,255,255,0.07); --rd-border: rgba(255,255,255,0.16);
  }
}
.wtyt-reader-modal {
  position: relative;
  width: 100%; max-width: 760px;
  background: var(--rd-bg); color: var(--rd-text);
  border-radius: 16px;
  box-shadow: 0 12px 48px rgba(0,0,0,0.5);
  padding: 28px 32px 32px;
}
.wtyt-reader-close {
  position: absolute; top: 14px; right: 14px;
  width: 34px; height: 34px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 50%;
  background: var(--rd-layer); color: var(--rd-text-2); cursor: pointer;
}
.wtyt-reader-close:hover { color: var(--rd-text); }
.wtyt-reader-head { display: flex; align-items: flex-start; gap: 12px; padding-right: 40px; }
.wtyt-reader-pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-weight: 700; font-size: 12px; letter-spacing: 0.06em;
  padding: 4px 11px 4px 9px; border-radius: 999px; color: #fff; flex-shrink: 0;
}
.wtyt-reader-titles { min-width: 0; flex: 1; }
.wtyt-reader-title { font-size: 19px; font-weight: 700; line-height: 1.3; }
.wtyt-reader-channel { font-size: 14px; color: var(--rd-text-2); margin-top: 2px; }
.wtyt-reader-save {
  flex-shrink: 0;
  margin-top: 2px;
  display: inline-flex; align-items: center;
  font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1;
  padding: 5px 12px; border-radius: 999px;
  border: 1px solid var(--rd-border);
  background: transparent; color: var(--rd-text-2);
  cursor: pointer;
}
.wtyt-reader-save:hover { border-color: var(--rd-text-2); color: var(--rd-text); }
.wtyt-reader-saved { color: #2ba640; border-color: #2ba640; cursor: pointer; }
.wtyt-reader-saved:hover { color: #c4302b; border-color: #c4302b; }
.wtyt-reader-summary {
  margin-top: 18px; padding: 16px 18px;
  background: var(--rd-layer); border-radius: 12px;
}
.wtyt-reader-oneliner { margin: 0; font-size: 16px; line-height: 1.5; }
.wtyt-reader-takeaways { margin: 12px 0 0; padding-left: 20px; font-size: 14.5px; line-height: 1.55; }
.wtyt-reader-takeaways li { margin-bottom: 4px; }
.wtyt-reader-instead {
  margin: 12px 0 0; padding: 10px 12px; font-size: 14.5px; line-height: 1.5;
  border-left: 3px solid #3170c7; background: var(--rd-bg); border-radius: 0 8px 8px 0;
}
.wtyt-reader-transcript { margin-top: 22px; }
.wtyt-reader-h {
  font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--rd-text-2); margin: 0 0 10px;
}
.wtyt-reader-para {
  margin: 0 0 14px; font-size: 16px; line-height: 1.7; color: var(--rd-text);
  max-width: 66ch;
}
.wtyt-reader-empty { margin-top: 18px; color: var(--rd-text-2); font-size: 15px; }
.wtyt-reader-open {
  display: inline-block; margin-top: 22px;
  font-size: 14px; font-weight: 600; color: #3170c7; text-decoration: none;
}
.wtyt-reader-open:hover { text-decoration: underline; }
`;

  return { readerCard, openOverlay, formatTranscript, verdictPill };
})();
