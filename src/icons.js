// WTYT — shared line-icon set. Inline stroke SVGs built via createElementNS (safe
// under YouTube's Trusted Types, which block innerHTML from content scripts).
// Loaded in both contexts: content_scripts (before cards.js) and the pages.
// The viewBox is essential — without it a 24-unit icon renders at 1px/unit and you
// see only its top-left corner.

const WTYT_ICONS = (() => {
  const NS = 'http://www.w3.org/2000/svg';

  // read=document, watch=eye, slop=robot — same three used by verdict pills and score chips.
  const SPECS = {
    watch: [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    read: [
      ['rect', { x: 5, y: 3, width: 14, height: 18, rx: 2 }],
      ['line', { x1: 9, y1: 8.5, x2: 15, y2: 8.5 }],
      ['line', { x1: 9, y1: 12, x2: 15, y2: 12 }],
      ['line', { x1: 9, y1: 15.5, x2: 13, y2: 15.5 }],
    ],
    slop: [
      ['rect', { x: 4.5, y: 9, width: 15, height: 11, rx: 3 }],
      ['line', { x1: 12, y1: 4.5, x2: 12, y2: 9 }],
      ['circle', { cx: 12, cy: 3.4, r: 1.4 }],
      ['circle', { cx: 9.5, cy: 14, r: 1.3 }],
      ['circle', { cx: 14.5, cy: 14, r: 1.3 }],
    ],
    check: [['polyline', { points: '20 6 9 17 4 12' }]],
    warn: [
      ['path', { d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' }],
      ['line', { x1: 12, y1: 9, x2: 12, y2: 13 }],
      ['line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }],
    ],
    close: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
    chevron: [['polyline', { points: '6 9 12 15 18 9' }]],
    play: [['polygon', { points: '6 4 20 12 6 20', fill: 'currentColor', stroke: 'none' }]],
    // listen=headphones (LISTEN verdict); ai=sparkle (AI-provenance badge, distinct from the slop robot).
    listen: [
      ['path', { d: 'M4 14v-2a8 8 0 0 1 16 0v2' }],
      ['rect', { x: 3, y: 13, width: 4, height: 7, rx: 1.5 }],
      ['rect', { x: 17, y: 13, width: 4, height: 7, rx: 1.5 }],
    ],
    ai: [['path', { d: 'M12 3.5 13.7 10.3 20.5 12 13.7 13.7 12 20.5 10.3 13.7 3.5 12 10.3 10.3z' }]],
    // live=broadcast dot with waves (0.7.0 LIVE marker; UPCOMING reuses the clock).
    live: [
      ['circle', { cx: 12, cy: 12, r: 3, fill: 'currentColor', stroke: 'none' }],
      ['path', { d: 'M6.3 6.3a8 8 0 0 0 0 11.4' }],
      ['path', { d: 'M17.7 6.3a8 8 0 0 1 0 11.4' }],
    ],
    // lifecycle-state icons (0.4.1): queued=clock, scoring=spinner (CSS-spun), failed retry=rotate-cw.
    clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['polyline', { points: '12 7 12 12 15 14' }]],
    spinner: [['path', { d: 'M21 12a9 9 0 1 1-9-9' }]],
    retry: [['polyline', { points: '23 4 23 10 17 10' }], ['path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }]],
  };

  // Returns a fresh SVG node each call (a node can't be mounted in two places).
  function svg(name, size = 16) {
    const el = document.createElementNS(NS, 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('width', size);
    el.setAttribute('height', size);
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', 'currentColor');
    el.setAttribute('stroke-width', '2');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('class', 'wtyt-ic');
    el.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of SPECS[name] || []) {
      const child = document.createElementNS(NS, tag);
      for (const k in attrs) child.setAttribute(k, attrs[k]);
      el.appendChild(child);
    }
    return el;
  }

  return { svg, has: (n) => !!SPECS[n] };
})();
