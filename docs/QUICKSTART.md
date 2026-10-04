# BrowserReflex: quickstart

Fast, typed answers to the small decisions a browser agent makes again and again, with a record of every one.

## Status

| Component | State |
|---|---|
| Server core and served MCP tools | **implemented and tested** |
| CLI commands (`init`, `serve`, `report`) | **implemented and tested** on macOS; Linux and Windows are **experimental** |
| Agent configuration layouts written by `init` | **experimental** (written to published conventions; unverified against live agent runs) |
| Chat mode (no key) and Bring-Your-Own-Key (BYOK) mode | **experimental** (fixture-tested only; live provider calls unsupported / not tested) |
| Local web UI | shell and seven pages **implemented and tested** against a mocked API, never run against a live agent; the other pages and entering a key in the browser are **planned** |
| Enforcement of safety rules inside agent hosts | **unsupported** |

## Honest limits

- **The safety check is advisory.** An agent that does not call it is not stopped by it. Real enforcement belongs in the agent host's own permission or hook system, and the documentation will say so wherever the check appears.
- **Faster or cheaper is a measurement, not a promise.** Token and time differences are unmeasured; reported time savings are estimates from an assumed model call duration, not measurements.

---

## 1. Install from source

BrowserReflex requires Node.js 22 (`v22.16.0` or higher) and pnpm (`12.4.2` or compatible).

Clone the repository and build the workspace:

```bash
git clone <repository-url>
cd BrowserReflex
pnpm install
pnpm build
```

Verify that all tests and verifications pass:

```bash
pnpm test
```

The workspace packages provide two command-line entry points: `browserreflex` and `browserreflex-mcp`. When running directly from a source checkout without global links, execute `node packages/cli/dist/bin.js`.

---

## 2. Initialize agent configurations (`init`)

The `init` command writes the BrowserReflex MCP server entry into the configuration files of supported coding and browser agents installed on your machine:

```bash
browserreflex-mcp init [options]
# or
browserreflex init [options]
```

Or from a source checkout:

```bash
node packages/cli/dist/bin.js init [options]
```

### What `init` does

1. **Scans for installed agents.** Looks for the configuration directory of supported agents under your home directory:
   - **Claude Code**: `~/.claude.json` (`mcpServers` key)
   - **Codex**: `~/.codex/config.toml` (`[mcp_servers.browserreflex]` table)
   - **Cursor**: `~/.cursor/mcp.json` (`mcpServers` key)
   - **Gemini CLI**: `~/.gemini/settings.json` (`mcpServers` key)
   An agent whose configuration directory is absent is skipped unless explicitly requested via `--agent`. Agent layouts are **experimental**: configurations follow published conventions, but have not been run against live agents.
2. **Creates timestamped backups.** Before modifying an existing configuration file, `init` creates a backup copy: `<file>.browserreflex-backup-<timestamp>`.
3. **Preserves existing settings.** Only the `browserreflex` server entry is added. All other keys, server definitions, formatting, and comments are preserved.
4. **Starts the local REST API.** Launches the local REST API on `127.0.0.1:4040` (or the port specified by `--port`), opening the SQLite database at `~/.browserreflex/browserreflex.db`. The API is bound strictly to loopback and protected by a localhost host-header guard.
5. **Attempts to open the setup wizard.** Tries to launch the setup wizard in your default browser.
   > **Note on the local UI:** `pnpm build` builds the UI into `packages/ui/dist`, and `init` serves it, so the setup wizard is at `/setup` on that port. If the UI was not built, the route answers 404 and `init` says so rather than claiming a page is reachable. The UI is tested against a mocked API only.

### CLI options for `init`

| Option | Description |
|---|---|
| `--agent <names>` | Comma-separated subset of `claude-code`, `codex`, `cursor`, `gemini-cli`. By default, configures all agents whose directory exists. |
| `--command <line>` | Command line written into the agent configuration. Defaults to `npx -y browserreflex-mcp serve`; the package is not published yet, so from a source checkout pass your own `--command`. Use `--command "node /path/to/packages/cli/dist/bin.js"` for a source checkout. |
| `--dry-run` | Prints merged configuration files to stdout without modifying files, making backups, starting the API, or opening a browser. |
| `--no-open` | Skips launching the default browser. Prints the local URL to stdout. |
| `--port <number>` | Port for the local REST API and setup wizard. Defaults to `4040` (`0` requests a free port). |
| `--home <directory>` | Home directory to resolve configuration paths under. Defaults to `BROWSERREFLEX_HOME`, `HOME`, or `USERPROFILE`. |
| `--db <file>` | Custom SQLite database file path. |

Exit codes: `0` on success, `1` on configuration or startup error, `2` on invalid command arguments.

---

## 3. Starting the server and checking `server_status`

To run the MCP server directly over stdio:

```bash
browserreflex serve
# or
node packages/cli/dist/bin.js serve
```

When started by an agent host, the server communicates over stdio using JSON-RPC. Only the protocol stream is written to stdout.

### Checking `server_status`

An agent or diagnostic harness can call the `server_status` tool to verify server health, transport, and available tools:

**Tool call:**
```json
{
  "name": "server_status",
  "arguments": {}
}
```

**Tool result:**
```json
{
  "server": "browserreflex",
  "version": "0.1.0",
  "transport": "stdio",
  "tool_names": [
    "server_status",
    "decide",
    "page_check",
    "submit_answers",
    "action_guard",
    "feedback",
    "get_pending_reviews",
    "get_stats"
  ],
  "decision_tools_status": "complete",
  "planned_tools": [],
  "safety_check": "advisory"
}
```

The output confirms that all eight decision tools are served. The field `safety_check: "advisory"` reinforces that safety checks report recommendations to the user and never prevent an agent from acting.

---

## 4. Chat mode vs Bring-Your-Own-Key (BYOK) mode

BrowserReflex supports two operating modes for handling questions that cannot be answered immediately on the fast path:

### Chat mode (default, no API key required)

In chat mode:
1. When an agent calls `decide` or `page_check` for an unknown question or new page element, BrowserReflex returns a `needs_ai` entry containing the canonical question and a unique `decision_id`.
2. The agent inspects the question and context within its own conversation, reasons through the answer, and calls `submit_answers` with its typed answer and the `decision_id`.
3. BrowserReflex validates the answer against the question schema. Valid answers are stored in local SQLite memory with path `ai`. If confidence is below the threshold, the decision routes to `needs_human`.
4. Subsequent calls for the same input and question resolve immediately on the fast path (`memory`).

### Bring-Your-Own-Key (BYOK) mode

Status: **experimental** (fixture-tested only; live provider calls unsupported / not tested).

In BYOK mode:
1. A provider API key is stored securely in the system keychain (or an encrypted file fallback using AES-256-GCM with `0600` permissions). Provider keys are never written to the database, logs, or tool outputs.
2. When `decide` encounters an unknown question, it resolves `needs_ai` directly by calling the configured model provider adapter.
3. The Anthropic adapter uses the default model `claude-haiku-4-5-20251001` (`DEFAULT_ANTHROPIC_MODEL`), bounded by timeouts and retry policies. Other provider adapters (OpenAI, Gemini, OpenRouter, Ollama) are **planned**.
4. The model output is strictly validated against the typed schema. Valid answers are recorded in SQLite with path `ai`, measured latency, and model confidence. Invalid outputs or network errors safely fall back to `needs_ai` and are never stored as corrupted answers.

---

## 5. Measuring the decision log (`report`)

The `report` command reads the local decision log in read-only mode and outputs a measurement report:

```bash
browserreflex report [options]
# or
browserreflex-mcp report [options]
# or
node packages/cli/dist/bin.js report [options]
```

### Options for `report`

| Option | Description |
|---|---|
| `--since <days>` | Window in days to report on (e.g. `--since 14` for two weeks). Default reports all recorded decisions. |
| `--json` | Output machine-readable JSON instead of human-readable text. |
| `--db <file>` | Custom SQLite database file to read. Opened strictly read-only (`0o444` tested; no data is ever written). |
| `--home <directory>` | Home directory to resolve configuration paths under. |

### Example output

This is the real output of the command against a small synthetic database of 40 decisions, not a result from real use. The database line is shortened.

```text
BrowserReflex measurement report: a measurement, not a promise.

Database: ~/.browserreflex/browserreflex.db
Range:    all recorded decisions

Decisions:
  Total decisions:    40
  Fast-path share:    80.0% (32/40)

Path breakdown:
  memory:             20 (50.0%)
  pattern:            8 (20.0%)
  check:              4 (10.0%)
  ai:                 6 (15.0%)
  human:              2 (5.0%)

Fast-path breakdown:
  memory:             20
  pattern:            8
  check:              4

Time saved estimate:
  Seconds saved:      96s
  Basis:              32 fast-path answers × 3s assumed model call
  Note:               Estimate, not measured: fast-path answers in range multiplied by an assumed model-call time. This server did not run a model to compare against.

Queue & Learning:
  Pending reviews:    2
  Shadow candidates:  0

Daily fast-path trend:
  2026-09-30:  83.3% (5/6)
  2026-10-01:  85.7% (6/7)
  2026-10-02:  87.5% (7/8)
  2026-10-03:  77.8% (7/9)
  2026-10-04:  70.0% (7/10)
```

### Key reporting behaviors

- **Sample size threshold guard:** When total decisions in the selected range are fewer than 30, the command reports that the sample size is too small to calculate a reliable daily trend, avoiding premature conclusions.
- **Empty log safety:** If the database does not exist or has zero recorded decisions, `report` prints an honest empty report and exits 0 without writing any files.
- **Unmeasured savings:** The time-saved figure is computed using `fast_answers * 3s assumed model call duration`. It carries the notice "a measurement, not a promise" and is explicitly labelled an estimate.
