// WTYT — saved-notes page. Grid of thumbnails (Apple-Notes feel); tapping a card
// opens the shared reader overlay (WTYT_READER). Delete removes and re-renders.
// Trusted Types don't apply on the extension page, but we stay createElement-based
// to match the rest of the codebase.

const VERDICT_LABEL = { watch: 'WATCH', read: 'READ', listen: 'LISTEN', skip: 'SKIP' };
const VERDICT_ICON = { watch: 'watch', read: 'read', listen: 'listen', skip: 'slop' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const thumbFor = (note) => note.thumbnail || `https://i.ytimg.com/vi/${note.id}/mqdefault.jpg`;

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function noteCard(note) {
  const card = el('article', 'note-card');

  const thumb = el('div', 'note-thumb');
  const img = el('img');
  img.src = thumbFor(note);
  img.alt = '';
  img.loading = 'lazy';
  thumb.append(img);

  const verdict = note.verdict || 'skip';
  const pill = el('span', 'note-pill v-' + verdict);
  pill.append(WTYT_ICONS.svg(VERDICT_ICON[verdict] || 'slop', 13), el('span', null, VERDICT_LABEL[verdict] || 'SKIP'));
  thumb.append(pill);

  const del = el('button', 'note-del');
  del.type = 'button';
  del.setAttribute('aria-label', 'Delete note');
  del.append(WTYT_ICONS.svg('close', 16));
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    WTYT_NOTES.remove(note.id).then(render);
  });
  thumb.append(del);
  card.append(thumb);

  const body = el('div', 'note-body');
  body.append(el('div', 'note-title', note.title || 'Untitled'));
  if (note.one_liner) body.append(el('div', 'note-oneliner', note.one_liner));
  const meta = el('div', 'note-meta');
  meta.append(el('span', 'note-channel', note.channel || ''));
  meta.append(el('span', 'note-date', formatDate(note.savedAt)));
  body.append(meta);
  card.append(body);

  card.addEventListener('click', () => WTYT_READER.openOverlay(note));
  return card;
}

async function render() {
  const notes = await WTYT_NOTES.list();
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  grid.textContent = '';
  if (!notes.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  for (const note of notes) grid.append(noteCard(note));
}

render();
