# WTYT — Watch The YouTube Things

**Give every YouTube video a watch / read / listen / skip verdict, so you spend your time only on what's worth it.**

WTYT is a Chromium browser extension (Chrome, Edge, Brave) that reads each video and drops a
one-glance verdict on your **home feed**, on any **video page**, and on any **playlist** —
then, for the ones you'd otherwise skim, hands you a written distillation you can read in a
fraction of the time.

![WTYT verdict badges and score rows across a YouTube home feed, with ads and Shorts left untouched](assets/home-feed.png)

It never touches your account or plays anything. It only reads, scores, and tells you — and
every design choice below was made deliberately, not defaulted into.

**Jump to:** [Install](#install) · [The verdict](#the-verdict) · [Read it, save it, come back to it](#read-it-save-it-come-back-to-it) · [Bring your own AI key](#bring-your-own-ai-key--and-keep-it-working) · [Built to survive a site it doesn't control](#built-to-survive-a-site-it-doesnt-control) · [For builders](#for-builders) · [Known limitations](#known-limitations)

---

## Install

1. Clone or download this repo → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the folder with `manifest.json`.
2. Onboarding opens → pick **Groq** (free, [console.groq.com/keys](https://console.groq.com/keys)) or **Claude** (paid, [platform.claude.com](https://platform.claude.com/settings/keys)), paste your key, hit **Test**.
3. Open your home feed, a video, or a playlist. Playlists use the **WTYT · Analyze playlist** button; everything else scores on its own.

---

## The verdict

**WATCH** — genuinely visual, worth the minutes. **READ** — informative but not visual, so a
distillation is included and you reclaim the time. **LISTEN** — music, a song, a live set;
watch/read scoring doesn't apply to something you're meant to hear, not parse, so it gets its
own minimal card instead of forcing irrelevant bars onto it. **SKIP** — low value, redundant,
or generic filler.

Underneath, three independent 0–100 axes (watch, read, generic) feed the verdict, plus a
gated **AI-generated badge** — the model only ever shows "high confidence" when multiple
signals agree, because a wrong AI-generated label does more damage than a missed one. A
**secondary tag** (e.g. a WATCH that's also strongly readable) is computed in code from the
returned scores rather than asked of the model directly, so it can't drift or hallucinate
across providers of very different capability — the small free models are trustworthy enough
to score, not to self-report a second judgment on top.

For high-view videos, the top ~20 comments are pulled and used as a **cross-check**: commenters
reliably call out AI voices, re-uploads, and factual errors, and the card notes whether they
agree with the score. This costs nothing extra to skip — the field is omitted entirely on
low-view videos rather than sent empty, so a weaker model can't invent comment sentiment that
was never given to it.

## Read it, save it, come back to it

Click the "~N min read" chip (or the verdict pill) and a reader overlay opens in place — full
transcript, summary, key takeaways — without leaving the page or trusting a third-party
"read it later" service with your data. Hit **Save** and it's kept locally, in a namespace
deliberately separate from the analysis cache, so clearing the cache to force a rescore can
never accidentally wipe something you saved. A dedicated notes page (thumbnail grid, tap to
reopen) is reachable from any card.

![A WTYT READ card: verdict, score bars, and a written "read it instead" distillation](assets/read-instead.png)

![The WTYT saved-notes page: a thumbnail grid of saved videos, tap any card to reopen its reader view](assets/saved-notes.png)

## Bring your own AI key — and keep it working

WTYT sends each transcript to a model you choose, not one it ships baked in:

| Provider | Cost | Default model | Notes |
|----------|------|---------------|-------|
| **Groq** | **Free tier** | Llama 3.3 70B | No credit card. Free-tier daily limit hit? WTYT walks a fallback chain (70B → GPT-OSS 120B → Llama 3.1 8B) automatically, so scoring keeps going and the card just notes a backup model scored it. |
| **Claude (Anthropic)** | Paid API | Claude Haiku 4.5 | Sharpest judgment when you want it. Haiku ≈ $0.006/video; Sonnet 5 for a curated re-pass. |

The two providers share **one prompt and one JSON contract** — only the HTTP shape differs —
so adding a third provider is a small, mechanical addition, not a rewrite. Your key lives in
`chrome.storage.local` and is sent straight to the provider from the extension's own service
worker; the key never enters page context, and there's no middle-man server to trust or host.

Free-tier models don't just rate-limit per minute, they cap out **per day** — a wall a simple
retry-with-backoff can't wait out. That's the actual reason the fallback chain exists: it's
not a nicety, it's what makes "free, no credit card" a viable default rather than a demo that
breaks under real use.

## Built to survive a site it doesn't control

YouTube ships DOM changes continuously — including a real regression where the playlist page
flip-flopped between `yt-lockup-view-model` and the "retired" `ytd-playlist-video-renderer`
mid-development. Rather than bet on one, the scanner detects and parses **both** at runtime.
Transcripts fall back to the ANDROID InnerTube client when the web caption track comes back
empty (a known 2025+ proof-of-origin quirk on the web path). Every injected node uses
`createElement`/`textContent` (SVGs via `createElementNS`) because YouTube enforces Trusted
Types and `innerHTML` from a content script throws outright. None of this is defensive
paranoia — each one is a bug that happened first and got fixed second.

Analyses are cached per `provider:model:videoId`, not just `videoId`, so switching providers
mid-session always rescores instead of silently showing you the other provider's stale
verdict — a correctness bug that's easy to miss in testing and obvious the moment a real user
switches keys. Prompt caching was investigated and deliberately *not* used: the scoring
rubric (~700 tokens) sits under Haiku 4.5's 4,096-token cacheable floor, so it would have
silently no-op'd. Measuring first meant not shipping a no-op optimization.

---

## For builders

Fork-friendly on purpose — vanilla JS, no build step, no framework, no bundler. Clone it, edit
a file, reload the extension.

### Architecture

```text
any YouTube surface (home / watch / playlist)
  content script (content.js) routes by URL and scans video rows ─▶ per video:
    yt-data.js  fetch watch page (same-origin, your cookies) ─▶ transcript
                  · web caption track first, ANDROID InnerTube client as fallback
                high-view video? ─▶ top comments via /youtubei/v1/next continuation
    background.js (service worker) ─▶ Groq or Anthropic (your key) ─▶ JSON scores,
                  walking the free-tier fallback chain on a daily rate limit
    cards.js    inject the report card into the row (createElement only)
    reader.js / notes-store.js   full-transcript reader overlay + local saved notes
```

| File | Responsibility |
|------|----------------|
| `src/content.js` | Surface router (home / watch / playlist) + orchestration; the scan → score → render loop. |
| `src/yt-data.js` | The scraping layer — dual-markup DOM parsing, transcript retrieval, comments fetch. |
| `src/background.js` | The only place the API key is used — provider routing, the scoring prompt, the deterministic guards, the fallback chain. |
| `src/cards.js` | All rendering — three card variants, `createElement` only. |
| `src/reader.js` / `src/notes-store.js` | Reader overlay + local saved-notes store. |
| `src/models.js` | Single source of truth for the provider/model catalog — settings and onboarding read from it, so they can't drift apart. |
| `src/options.*`, `src/welcome.*` | Settings page and onboarding wizard. |

### Engineering decisions

The non-obvious calls, and why they were made that way:

- **No backend, bring-your-own-key.** Zero infrastructure and a clean privacy story: the key
  lives in `chrome.storage.local`, and the API call is made from the **service worker**, not
  the page — so the key never enters page context, and `host_permissions` makes CORS a
  non-issue. Transcripts and comments are fetched same-origin with the user's own cookies, so
  there's no OAuth and nothing to host.

- **Provider abstraction, not provider lock-in.** Claude and Groq share one prompt and one
  JSON contract; only the HTTP shape differs. Routing keys off the model id (`claude*` →
  Anthropic, else Groq) so a stale saved provider can't wedge the extension.

- **The free tier survives its own limits.** Groq's free models each cap out at a certain
  number of tokens *per day*, not just per minute — a hard wall a simple retry can't wait out.
  `background.js` walks a fallback chain (70B → 120B → 8B) so a daily cap on one model doesn't
  stop scoring; it just quietly stacks the free budgets and notes the swap on the card.

- **Deterministic guards over trusting the model.** Several correctness rules are enforced in
  code, not the prompt: `read_instead` is forced empty unless the verdict is `read`,
  `community_check` is dropped whenever no comments were sent, and the secondary tag is
  computed from the returned scores rather than asked of the model — so it can't drift across
  providers of very different capability.

- **Dual-markup DOM resilience.** YouTube ships DOM changes continuously and has flip-flopped
  the playlist page between `yt-lockup-view-model` and `ytd-playlist-video-renderer` more than
  once. Rather than bet on one, the scanner detects and parses **both** at runtime. (This one
  was learned the hard way.)

- **Transcript fallback via the ANDROID InnerTube client.** Since 2025, web caption URLs often
  return an empty `200` without a proof-of-origin token. The ANDROID client's caption URLs
  carry no such requirement, so it's the reliable path when the web track comes back blank.

- **Trusted Types compliance.** YouTube enforces Trusted Types, so any `innerHTML` from a
  content script throws. Every injected node is built with `createElement` / `textContent` and
  SVGs via `createElementNS`.

- **Cache correctness over cache size.** Analyses are cached per `provider:model:videoId`, not
  just `videoId` — so switching providers or models always rescores instead of silently
  showing you the other provider's stale verdict.

- **Measured, not assumed.** Prompt caching was investigated and *rejected*: the scoring rubric
  (~700 tokens) sits under Haiku 4.5's 4,096-token cacheable floor, so caching would silently
  no-op. Results are instead cached per video for 14 days, which is where the real re-open win is.

- **Non-disruptive injection.** The floating button is `position: fixed` and never enters
  YouTube's header DOM, so nothing reflows; cards mount inside each row's own metadata column;
  the theme follows YouTube's `html[dark]` attribute with colors matched to its real palette.

### Extending it

- **Add a provider:** add a `*Complete()` function in `background.js` mirroring
  `groqComplete`, extend `providerOf()` routing, and add its catalog entry to `models.js`.
- **Change the rubric:** the scoring axes and verdict rules live in one `SYSTEM_PROMPT` string
  in `background.js`; the JSON shape is enforced right below it.
- **Support a new surface / fix selector rot:** DOM selectors are isolated in `yt-data.js`;
  the surface router is the top of `content.js`.

### Known limitations

- Videos without captions (music, many Shorts) are scored from metadata only, flagged on the
  card with lower confidence.
- Selectors are verified against the mid-2026 YouTube layout with fallbacks; selector rot is a
  maintenance fact of life when scraping a site you don't control.
- Analyzes the videos currently rendered (YouTube lazy-loads rows; scroll before analyzing a
  long playlist).
- Personal-scale tool: no multi-tenancy, no auth hardening. It recommends — it never auto-acts.

---

## Built with AI, directed by humans

This project was built with the help of AI coding tools, but it was **thought out, decided, designed, tested, and vetted by a human**. Every architectural choice, product decision, and the verification behind them are the author's own.

## License

MIT © 2026 Vemana Madasu — see [LICENSE](LICENSE).
