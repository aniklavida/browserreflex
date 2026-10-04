# @browserreflex/ui

The local web UI. React, Vite and React Router, built into `dist/` and served by the same
process as the REST API, on `127.0.0.1`. English only.

## Status

| Part | State |
|---|---|
| App shell: sidebar with four groups and badges, header with the API status and a Local only badge, collapse behind a Menu button below 1280px | **implemented and tested** |
| Theme: dark by default, light option, kept in `localStorage`, every colour in `src/theme.css` | **implemented and tested** |
| Shared components (path badge, confidence, probability bar, metric grid, segmented control, square toggle, table row, drawer, toast, empty state) | **implemented and tested** |
| Pages: Dashboard, Review queue, Learned, Analytics (overview), Thresholds + safety, Engines + keys, Setup wizard | **implemented and tested** against a mocked API; never run against a live agent |
| Entering a provider key in the browser, Test connection | **planned** |
| Pages: Live activity, Logs, Task replay, Patterns inspector, Pattern packs, Reports, Integrations, Settings; Analytics quality, safety, agents and drift tabs | **planned** |

The safety check is advisory. The UI shows what the API reports and records answers. It does
not stop an agent from acting, and the safety gates it lists cannot be switched off here.

## Rules this package keeps

- Dark by default; the choice is stored under `browserreflex-theme` and the page renders
  correctly when storage is blocked.
- Confidence colours are reserved: green for memory, pattern and check; yellow for a model;
  red for a person or a safety record.
- No colour value outside `src/theme.css`, no radius, shadow or gradient for structure.
  A test fails when one appears.
- No third-party requests. The two typefaces are bundled from `@fontsource` packages; a test
  fails if any source or the page holds an `http(s)` address.
- Every empty page says what will appear and what to do next. A failed request is shown, not
  hidden.
- No number is invented. The pages read the API; a figure the API does not hold (tokens,
  agents connected) is not shown.

## Commands

```bash
pnpm --filter @browserreflex/ui run build
pnpm --filter @browserreflex/ui run test
pnpm --filter @browserreflex/ui run typecheck
```

`vite` (the `dev` script) proxies `/api` to a server on `127.0.0.1:4040`.
