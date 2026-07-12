// WTYT — shared provider/model catalog for the extension's own pages (options, welcome).
// Single source of truth so settings and onboarding never drift. Cost/limit figures use
// real published rates (Anthropic + Groq, verified 2026-07); per-video numbers are rough
// estimates for a typical ~10-minute video. Groq is the free, no-paid-key path.

const WTYT_MODELS = {
  defaultModel: { anthropic: 'claude-haiku-4-5-20251001', groq: 'openai/gpt-oss-120b' },

  keyHint: {
    anthropic:
      'Create one at <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">platform.claude.com → API keys</a> (console.anthropic.com now lands here too). Add a payment method and set a spend cap. The key is stored only in this browser and sent only to Anthropic.',
    groq:
      'Create one free at <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com → API keys</a> — no credit card needed. The free tier is rate-limited per minute and per day but is enough to triage a feed. The key is stored only in this browser and sent only to Groq.',
  },

  keyPlaceholder: { anthropic: 'sk-ant-...', groq: 'gsk_...' },

  costNote: {
    anthropic:
      'Real Anthropic rates: <strong>Haiku 4.5 $1/$5</strong>, <strong>Sonnet 5 $3/$15</strong> per million input/output tokens. A 25-video playlist runs roughly <strong>$0.15 on Haiku</strong> or <strong>$0.75 on Sonnet</strong>. Analyses are cached for 14 days, so re-opening a playlist is free.',
    groq:
      "Groq's <strong>free tier</strong> costs nothing (rate-limited per minute and per day). <strong>GPT-OSS 120B</strong> gives the best free judgment; <strong>Llama 3.1 8B</strong> is fastest with the highest daily limit for bulk scans. A quota error means you hit the per-minute or per-day free limit — wait a moment or switch to the faster model. Analyses are cached 14 days.",
  },

  models: {
    anthropic: [
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        tag: 'DEFAULT',
        tagClass: '',
        best: 'Strong triage judgment at ~10× lower cost than Sonnet. Follows the rubric cleanly and reads comment sarcasm. The right paid default.',
        quality: 'Very good',
        speed: '~5s / video',
        cost: '~$0.006 / video',
        short: 'Best value. ~$0.006/video.',
      },
      {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        tag: 'BEST',
        tagClass: 'neutral',
        best: 'The sharpest judgment — tells genuine-but-formulaic from real AI slop most reliably. Worth it for a curated re-pass over the keepers.',
        quality: 'Highest',
        speed: '~9s / video',
        cost: '~$0.03 / video',
        short: 'Sharpest judgment. ~$0.03/video.',
      },
    ],
    groq: [
      {
        id: 'openai/gpt-oss-120b',
        name: 'GPT-OSS 120B',
        tag: 'FREE · DEFAULT',
        tagClass: 'free',
        best: 'Best free judgment. Follows the rubric and does not invent comment sentiment — measurably the strongest zero-cost pick.',
        quality: 'Very good',
        speed: '~1.5s / video',
        cost: 'Free tier',
        short: 'Best free judgment.',
      },
      {
        id: 'llama-3.1-8b-instant',
        name: 'Llama 3.1 8B Instant',
        tag: 'FASTEST',
        tagClass: 'neutral',
        best: 'Fastest, with the highest daily free limit (~14k/day). Verdicts are solid; nuance and summaries are thinner. Good for a bulk first pass.',
        quality: 'Good',
        speed: '~0.5s / video',
        cost: 'Free tier',
        short: 'Fastest. Highest daily limit.',
      },
    ],
  },

  // One-line qualitative difference, shown during onboarding so users know why to pick.
  qualitativeLine:
    'Claude (Haiku, Sonnet) has the sharpest judgment but needs a paid API key. Groq (GPT-OSS 120B, Llama 8B) is free — GPT-OSS 120B is close behind on judgment; Llama 8B is fastest for bulk.',
};
