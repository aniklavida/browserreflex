# browserreflex-mcp

The `browserreflex-mcp` command: `init` writes this server's MCP entry into the
configuration of the agents installed for the current user, and `serve` is the
entry those configurations point at.

Status: **implemented and tested** on macOS, in `packages/cli/test/`. Nothing here
was run on Windows or on Linux: their path layouts and launcher commands are
covered through an injectable platform parameter, and both are **experimental**
until someone runs the command on those operating systems.

The safety check in the server is **advisory**. This command writes a
configuration file; it cannot make an agent read it, reload it or call anything.
An agent that never calls the server is not stopped by it, and nothing in this
package changes that.

This package is **not published**. It exists in the repository so the command can
be built, run and tested.

## What `init` does

```
browserreflex-mcp init [options]
```

1. Looks for the configuration directory of each supported agent under the home
   directory. An agent whose directory is not there is not installed for this
   user, so its file is left alone unless it is named with `--agent`.
2. Adds one entry, named `browserreflex`, to each configuration it selected. Every
   other key in the file, and every other server's entry, is copied through
   unchanged.
3. Copies an existing file to a timestamped backup next to it before writing:
   `<file>.browserreflex-backup-<timestamp>`.
4. Starts the local REST API on `127.0.0.1`, which opens the SQLite database at
   `<home>/.browserreflex/browserreflex.db`.
5. Prints the setup wizard address and tries to open it in a browser.

Nothing is sent anywhere. This package makes no network request of its own, and
the API it starts binds to loopback inside the server package, with no option to
widen that.

## Options

| Option | Effect |
|---|---|
| `--agent <names>` | Comma-separated subset of `claude-code`, `codex`, `cursor`, `gemini-cli`. Without it, every agent whose configuration directory exists is written. |
| `--command <line>` | The command written into the entry. Defaults to `npx -y browserreflex-mcp`; `serve` is appended to whatever is given. Use it for a checkout: `--command "node /path/to/packages/cli/dist/bin.js"`. |
| `--dry-run` | Prints the whole file as it would be written and changes nothing: no configuration file, no backup, no database, no listening port, no browser. |
| `--no-open` | Does not open a browser. The address is printed either way. |
| `--port <number>` | Port for the local API and the setup wizard. Default 4040; `0` asks the operating system for a free one. |
| `--home <directory>` | Home directory to resolve configuration paths under. Defaults to `BROWSERREFLEX_HOME`, then `HOME` (or `USERPROFILE` on Windows), then the system home directory. |
| `--db <file>` | SQLite file to use instead of the one under the home directory. |

`--help` prints the same list, and `--version` prints this package's version. Exit
codes: `0` success, `1` a configuration was refused or the API could not start, `2`
the command line was wrong.

`serve` runs the MCP server on stdio and writes nothing to stdout except the
protocol stream. It takes `--home` and `--db`, and applies them to its own process
before the database is opened. The entry `init` writes into an agent configuration
runs `serve` on its own, so an agent-launched server uses the default database
unless `BROWSERREFLEX_DB_PATH` is set in that process's environment: set it for
both when you want them to share one file.

## The agents, and what is known about each

Detection is by the presence of the agent's configuration directory. Every layout
below is written from that agent's published convention. **No agent was run against
a file this command wrote, so all four layouts are experimental**, and `init`
prints that line for each agent it writes. A wrong guess costs a restore from the
backup, not a lost configuration.

| Agent | File | Format | Claim about the layout |
|---|---|---|---|
| Claude Code | `~/.claude.json`, `mcpServers` | JSON | experimental |
| Codex | `~/.codex/config.toml`, `[mcp_servers.browserreflex]` | TOML | experimental |
| Cursor | `~/.cursor/mcp.json`, `mcpServers` | JSON | experimental |
| Gemini CLI | `~/.gemini/settings.json`, `mcpServers` | JSON | experimental |

The Claude Code row is the one with the most to lose from a wrong guess, because
`.claude.json` holds that agent's whole state rather than a configuration file
beside it. That is why the merge only adds its own key, keeps everything else byte
for byte, and takes a backup first.

Overrides, in the order they are applied: an explicit path override for one agent
(`BROWSERREFLEX_CONFIG_PATH_CLAUDE_CODE`, `..._CODEX`, `..._CURSOR`,
`..._GEMINI_CLI`), then the agent's own configuration directory variable
(`CODEX_HOME` for Codex), then the path under the home directory. `APPDATA` is not
consulted: none of these four agents documents a configuration file under it, and
guessing a location there would write to the wrong file.

## Behaviour worth knowing about

- **A file it cannot understand is refused, not replaced.** A JSON file that does
  not parse, a document whose `mcpServers` key is not an object, or a file that
  exists but cannot be read, is left exactly as it is and reported. The command
  exits 1. Writing a default document over a file this package cannot read would
  destroy the only copy of whatever was in it.
- **A second run writes nothing.** If the merged file is byte-identical to the one
  on disk, nothing is written and no backup is made.
- **Opening a browser is best effort, and the output does not overstate it.** A
  machine with no launcher, a headless session or a container has no way to open a
  window. When the launcher command starts, the output says it started the
  launcher and that no window was confirmed, because nothing waits for one. A
  launcher that refuses is reported, not treated as a failure, and the address is
  printed so it can be opened by hand. `--no-open` skips the step entirely.
- **`init` stays in the foreground** while the wizard is reachable, and stops the
  API on `SIGINT` or `SIGTERM`.
- **The setup wizard has no implementation yet.** `packages/ui` is a placeholder
  with no build, so the route answers 404 and `init` says so rather than claiming
  a page is there.

### The one documented limitation in the TOML reader

The TOML reader recognises a section header and copies everything else through as
text, so a file keeps its own formatting, comments and ordering. A line that
begins with `[` inside a multi-line string would be mistaken for a header. No
supported agent's configuration file uses a multi-line string, and the behaviour
is written down as a test in `packages/cli/test/config-toml.test.ts` rather than
left as a caveat.

## Running it from a checkout

The repository's own `pnpm install` links a `.bin/browserreflex-mcp` shim, but the
server package declares the same bin name, and the link resolves to the server
package's stdio entry rather than to this command. Build and run it directly:

```
pnpm --filter browserreflex-mcp build
node packages/cli/dist/bin.js init --dry-run --home ./scratch-home --no-open
```

## Dependencies

`@browserreflex/server`, which is a workspace package. Everything else is the Node
standard library: no argument parser, no TOML writer and no browser-opening
library, because each of those would be another licence to audit and keep
current. See `docs/DEPENDENCIES.md` for the audit.