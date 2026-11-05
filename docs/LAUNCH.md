# Launch plan

Goal: one strong launch wave that brings the first 1,000 stars, then steady growth.
Stars come from a sharp story + a visual that people repost + being where the audience already is.

## The story (one sentence for every channel)

> "I analyzed 400 MB of my Claude Code logs. 31% of my tokens went to loops and re-reading the same
> files. I built an open-source tool that finds this in your logs in 30 seconds — and fixes it."

The numbers in that sentence must be real (from `METRICS.md`). Before/after is the headline.

## What must be ready before launch day

- [ ] `npx agentprism` works first try on Windows, macOS, Linux (CI-tested)
- [ ] README top: one-line pitch, hero GIF (≤10 s), install command, before/after table
- [ ] 3–4 polished screenshots: overview, session replay, findings, Wrapped card
- [ ] "Agent Wrapped" card that looks good on X/Threads/LinkedIn (1200×675)
- [ ] Demo video 60–90 s (screen recording, captions, no voice needed)
- [ ] Landing page (GitHub Pages) with the same story — optional for v0.1
- [ ] Issue templates, CONTRIBUTING.md, `good first issue` labels (new adapters are perfect first issues)
- [ ] At least one adapter beyond Claude Code if possible (widens the audience on HN)
- [ ] Publish from a clean copy, not this working repo. Studio files (`studio.json`, `PROJECT.md`, `AGENTS.md`,
      `GEMINI.md`) name the machine, local paths and the agent account. Drop them, then re-check the
      README, `docs/` and `research/results/` for paths and private names. `studio.json` (machine
      `dev-machine`, local path, `updated_by`) lives only in the private repository and its branches. It never
      goes into the public branch or repository.

## Channels and order

| Day                            | Channel                                                                                                           | Format                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-7..D-1                       | X / Threads                                                                                                       | build-in-public: 2–3 posts with screenshots and surprising numbers from own logs                                                                                   |
| D0, Tue–Thu ~8–10am US Eastern | **Hacker News — Show HN**                                                                                         | `Show HN: AgentPrism – find where your AI coding agent wastes tokens`. Author's first comment: why, how it works, privacy, what's next. Stay in the thread all day |
| D0                             | **Reddit** r/ClaudeAI                                                                                             | post with personal numbers + GIF, not a sales pitch                                                                                                                |
| D0–D1                          | X thread                                                                                                          | 6–8 posts: problem → numbers → GIF → how → link; tag tool authors where relevant                                                                                   |
| D1                             | Reddit r/ChatGPTCoding, r/LocalLLaMA (only if a relevant adapter exists), r/programming (if a technical write-up) | adapted posts, not copy-paste                                                                                                                                      |
| D1–D3                          | LinkedIn                                                                                                          | career angle: "what I learned building devtools for AI agents"                                                                                                     |
| D2–D5                          | dev.to / Medium / Habr (RU audience)                                                                              | technical article: reverse-engineering the Claude Code log format, the 2.9× double-count trap                                                                      |
| D3+                            | awesome-claude-code and similar lists, newsletters (TLDR, Console.dev, Changelog)                                 | PRs / submissions                                                                                                                                                  |
| D7+                            | Product Hunt                                                                                                      | once there are a few more features and testimonials                                                                                                                |

## Rules

- One honest post per community, follow each subreddit's self-promotion rules.
- Lead with value and numbers, not with "please star".
- Answer every comment and issue fast during the first week — it drives ranking and trust.
- Ship a visible improvement within days of launch (e.g. a requested adapter) and post about it.
- Never inflate numbers; HN will check.

## After launch

- Weekly short changelog posts.
- Turn user-reported findings into new detectors and credit the reporters.
- Collect "it saved me X%" quotes for the README.
