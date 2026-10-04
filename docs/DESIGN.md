# BrowserReflex: design

Status: the shell, the shared components and seven pages are **implemented and tested** in `packages/ui` against a mocked API (see its README). The remaining pages are **planned**. This document is the design direction.

The UI is served by the same process as the MCP server on `127.0.0.1`, in English only. People use it for setup, for reviewing low-confidence answers and for checking what BrowserReflex has learned; they do not need to open it every day.

## Global rules

- **Theme:** dark by default, with a light option. The choice is stored in `localStorage` and the switch sits in the sidebar and on the settings page.
- **Safety prompts are never UI popups.** An `ask_user` result is shown in the agent's own conversation. The UI only records that it happened and what the user answered.
- **Confidence colours are reserved:** green means automatic (memory, pattern, check), yellow means model, red means human or safety. They are used for nothing else.
- **"Local only"** is visible on every page (a badge in the header and a line in the sidebar footer).
- **Every empty page says** what will appear and what to do next.
- **No radius, no shadows, no gradients, no glow.** Structure comes from 1.5 px lines.
- **No third-party requests.** Fonts are bundled with the app, never loaded from a remote service, because the product promises that data stays on the machine.

## Tokens

Implemented as CSS variables on the app root; the light theme swaps the whole set.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0B0B0B` | `#FFFFFF` | page, drawers, modals |
| `--sf` | `#111111` | `#FFFFFF` | card surface |
| `--sf2` | `#1B1B1A` | `#F3F3F1` | hover, code blocks |
| `--ink` | `#F5F5F2` | `#0A0A0A` | text, inverted fills |
| `--line` | `#F5F5F2` | `#0A0A0A` | 1.5 px structural borders |
| `--hair` | `rgba(245,245,242,.13)` | `rgba(10,10,10,.13)` | 1 px row dividers |
| `--muted` | `#A3A39C` | `#55554F` | secondary text |
| `--dim` | `#6E6E68` | `#8A8A84` | navigation group labels, inactive dot |
| `--barC` | `#363631` | `#D8D8D2` | inactive chart bars |
| `--acc` | `oklch(0.88 0.19 125)` | same | lime: selection, primary action, "today" |
| `--accInk` | `#0A0A0A` | same | text on lime |
| `--selBg` | `oklch(0.88 0.19 125 / .13)` | `oklch(0.88 0.19 125 / .32)` | selected row, new-row flash |
| `--overlay` | `rgba(0,0,0,.72)` | `rgba(255,255,255,.75)` | drawer and modal backdrop |
| `--auto` | `oklch(0.72 0.16 150)` | `oklch(0.64 0.15 150)` | green fill |
| `--ai` | `oklch(0.84 0.16 80)` | `oklch(0.82 0.16 80)` | yellow fill |
| `--human` | `oklch(0.62 0.21 28)` | `oklch(0.60 0.21 28)` | red fill (white text on it) |
| `--autoT` | `oklch(0.78 0.15 150)` | `oklch(0.48 0.13 150)` | green text |
| `--aiT` | `oklch(0.86 0.15 85)` | `oklch(0.52 0.12 70)` | yellow text |
| `--humanT` | `oklch(0.72 0.19 28)` | `oklch(0.52 0.2 28)` | red text |

Fill tokens are for dots, bars and blocks. The `T` tokens are for text, because they keep 4.5:1 contrast on both themes. Text on a yellow or green fill is always `#0A0A0A`.

## Typography

Two open-licence (SIL OFL) fonts, bundled with the app: **Archivo** (400 to 800) and **DM Mono** (400 and 500). The licence and the date it was checked are recorded in `DEPENDENCIES.md` when they are added.

| Role | Font | Size and weight | Extra |
|---|---|---|---|
| Hero number | Archivo | 76 px / 800, line height .85 | letter-spacing -0.05em |
| Page title | Archivo | 24 px / 800 | uppercase, -0.02em |
| Large heading | Archivo | 28 to 40 px / 800 | uppercase, -0.02 to -0.035em |
| Card value | Archivo | 20 to 30 px / 800 | -0.03em |
| Body | Archivo | 13 to 14 px / 400, line height 1.5 | `text-wrap: pretty` |
| Row text | Archivo | 13 px / 400 to 600 | |
| Navigation item | Archivo | 12 px / 600 | uppercase, .03em |
| Button | Archivo | 11 to 12.5 px / 700 | uppercase, .04em |
| Card label | DM Mono | 10.5 px / 500 | uppercase, .08em |
| Data, ids, chips | DM Mono | 10.5 to 12.5 px / 400 to 500 | |

## Spacing and lines

- Page padding 24 px top, 28 px sides, 48 px bottom; header padding 18 px 28 px.
- Gap between cards 20 px; card padding 16 to 22 px; table rows 10 to 13 px by 16 to 20 px.
- Borders: 1.5 px `--line` on cards, tables, buttons, inputs and segmented controls; 1 px `--hair` between rows.
- Joined grids (metric strips, stat grids): the container takes `background: var(--line)` and `gap: 1.5px`, and each cell takes `background: var(--sf)`.
- Radius 0 everywhere, inputs and toggles included.

## Shared components

- **Sidebar (236 px):** logo row (an 18 px lime diamond, the product name, an ALPHA chip) with a 1.5 px bottom line; navigation groups Overview, Learning, History and Control with 10 px mono group labels; the active item takes `--acc` with `--accInk` text, hover takes `--sf2`; badges for review count (yellow), DRIFT (red), UPDATE and LIVE. The sidebar footer has the theme switch and the local-only line.
- **Header:** title and subtitle, a live status box (an 8 px green square blinking in steps, plus the connected-agents count) and the "LOCAL ONLY" badge. Below 1280 px a MENU button opens the sidebar as an overlay.
- **Button:** primary is lime filled; secondary is transparent with `--ink` text; inverted is `--ink` filled with `--bg` text. All have a 1.5 px `--line` border and uppercase Archivo 700. Keyboard hints sit inside the button in a small mono box.
- **Segmented control:** 1.5 px border; the active segment is `--ink` filled with `--bg` text.
- **Toggle:** a 42 by 22 px square track with a 1.5 px border and a 15 px square knob. On is lime (red for safety gates).
- **Path badge:** mono uppercase in a 1 px `--hair` box, after a 6 px square dot in the tone colour.
- **Confidence:** two decimals in mono, in the tone text colour.
- **Probability bar:** 6 px tall, 1 px `--line` outline, fill width equal to the probability; the suggested option fills yellow, others fill `--ink`.
- **Toast:** bottom centre; `--ink` background with `--bg` text; mono 12 px uppercase; an 8 px tone square; closes after 2.6 s.
- **Drawer:** 460 to 480 px, right side, full height, 1.5 px left border, `--overlay` backdrop; Esc closes it.
- **Empty state:** muted body text in the card, or a dashed 1.5 px box with a small rotated square and one action.
- **Motion:** page enter is opacity 0 to 1 and translateY 4 px to 0 over 0.3 s; a new live row takes `--selBg` and fades back over 1.2 s; toggles animate `left` over 0.15 s. Nothing else moves, and reduced-motion preferences are honoured.
- **Mark:** no images or icon fonts. The only mark is a CSS square rotated 45 degrees with a lime fill and a 1.5 px border; the final logo waits for the final product name.

## Pages

All pages use the sidebar and header shell; grid tracks use `minmax(0, ...)` so they can shrink. Minimum supported width is 960 px.

**v1 pages**

| Page | Content |
|---|---|
| Setup wizard | Full-screen overlay on a 24 px grid-paper background with one 780 px card; a four-cell step bar (current lime, done ink); steps Agent (detected or not, config snippet with copy), Mode (chat or BYOK, with provider, key and test inline), Packs (toggle rows), Test (idle, then listening, then a green result) |
| Dashboard | Optional drift strip; range tabs (today, 7 days, 30 days); hero fast-path share with 14 daily bars; needs-review count; safety stops (what the user answered in the agent); four metrics; "learned today" feed; path mix; recent decisions. First run: a "day one" checklist and "try this in your agent" prompts with copy buttons |
| Review queue | One item at a time or bulk; list on the left (selected item inverted); card with chips, the question, the reason, redacted context, options with probability bars and key hints; keyboard first |
| Thresholds and safety | One card per decision type with a split bar (human, model, automatic) and two sliders that cannot cross; a safety-gates card with a red border and a red toggle per gate; turning a gate off needs typed confirmation and is written to the audit log |
| Engines and keys | Chat or BYOK mode picker; in BYOK a provider control, masked key, model, timeout and a test-connection button; in chat mode a short "how it routes" strip |

**Later pages (v2 and v3):** live activity, task replay, pattern inspector, pattern packs, analytics (overview, quality, safety, agents and projects, drift), logs, reports, integrations, settings.

## Behaviour

- **Live data** arrives over server-sent events and updates the live table, counters and replay.
- **Accepting a review item** posts feedback; the response says whether memory was updated, which shadow pattern statistics changed or which candidate was mined, and the toast shows it.
- **Promotion and demotion** follow the learning rules in `SPEC.md`; a promotion adds a feed entry and a toast; a pattern auto-disabled by a re-check is marked with drift and the dashboard shows the strip.
- **Turning a pack off** makes its non-safety rules fall back to the model; safety rules keep working.
- **Keyboard:** review uses 1 to 9, Enter, J and K, S and B; R on other pages opens review; Esc closes drawers, modals and the wizard. Keys are ignored while typing in an input.
- **Client state:** only the theme is stored in the browser. Everything else comes from the local API.

## Accessibility

Text colours keep 4.5:1 contrast in both themes; focus is always visible; every control is reachable by keyboard; status never relies on colour alone (path badges and confidence carry text).
