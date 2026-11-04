# Rebuild the context-economics HTML report

One command, from the repository root, after `npm install`:

```bash
npm run dev -- context "<session id prefix or part of its title>" --html context-report.html
```

- It reads the latest Claude Code logs first, so the report is fresh.
- Leave out the session to report on the most recent one. For the site, a long session with compactions
  shows the most: pick it by part of its title.
- `--rho <usd>` sets the price of forgetting per compaction. The default is 0.5. Keep the same value
  between versions of the page, so they stay comparable.
- The HTML is a single self-contained file with no external scripts. It is anonymized: only numbers,
  dates, model names and kinds of content, with no messages, paths, titles or ids (D27). Look it over
  once anyway before publishing.
