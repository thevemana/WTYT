# What's New — WTYT

Newest first. WTYT ships as a single extension; each version below is a
milestone in what it can do. Bring your own key — Claude (paid) or Groq (free).

## 0.7.2 — 2026-07-19
- **Shorter name.** The extension is now just **WTYT** — in Chrome, in
  settings, and on the welcome screen.
- Onboarding now mentions that **search results** are scored too, alongside
  your home feed and playlists.

## 0.7.1 — 2026-07-19
- **Search results are now scored.** Run a YouTube search and every result gets
  a WATCH / READ / LISTEN / SKIP verdict, just like your home feed and playlists.
- **Live streams & premieres are flagged, not scored.** A live or upcoming video
  shows a LIVE / UPCOMING marker instead of spending a call on a video that has
  no transcript yet.
- **Daily free-tier runway.** On a free Groq key, WTYT shows roughly how many more
  videos you can score today before the free daily limit — and warns you when low.
- Fix: switching a page to Manual mid-scan no longer leaves cards stuck on
  "Queued," and a score you've already paid for always shows.

## 0.6.0 — 2026-07-18
- **Steadier scoring on the free tier** — WTYT paces its requests under Groq's
  free per-minute limit, so a busy feed fills in gradually instead of failing.
- **Home feed scores as you scroll**, just ahead of where you're looking;
  playlists score in full even when long.
- Watch-page controls dock inline above the analysis, with an Auto/Manual toggle
  for each surface.

## 0.5.0 — 2026-07-18
- **Usage counters (opt-in)** — a private, on-device tally of what you've scored,
  cache hits, and token use. No video data leaves your browser; one click to
  export or reset.
- Built-in link to the feature-request board.

## 0.4.4 — 2026-07-14
- **Free-tier fallback** — if one free model hits its daily cap, WTYT tries the
  next automatically, so scoring keeps working.
- Reader view, saved notes, and the **LISTEN** verdict for music.
  *(Consolidates the 0.4.0–0.4.4 line.)*

## 0.3.3 — 2026-07-12
- First public release: playlist, home-feed, and watch-page scoring with your
  own Claude or free Groq key.
