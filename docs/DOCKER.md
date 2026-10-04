# Docker

Run the BrowserReflex MCP stdio server in a container.

## Status

**Untested: written but never built or run.** The `Dockerfile` and `.dockerignore` were written on a machine without Docker. Nothing in this document has been verified by a build or a run. Expect to fix things on the first attempt.

## What this covers

Only the MCP stdio server (`browserreflex-mcp serve`). The image is built from `node:22-slim` and no other image. Native `better-sqlite3` is built with `python3`, `make` and `g++` in the build stages; the runtime stage runs as the non-root `node` user.

## Build

```bash
docker build -t browserreflex-mcp .
```

## Run

```bash
docker run -i --rm -v browserreflex-data:/data browserreflex-mcp
```

`-i` is required: the MCP stream is JSON-RPC over stdin and stdout. Do not add `-t`, which would corrupt the stream.

`BROWSERREFLEX_HOME` is set to `/data` in the image. The `serve` command derives the database path from it, so the SQLite file is `/data/.browserreflex/browserreflex.db`, inside the `browserreflex-data` volume. Removing the volume removes the records.

## Sample MCP configuration

```json
{
  "mcpServers": {
    "browserreflex": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "browserreflex-data:/data", "browserreflex-mcp"]
    }
  }
}
```

This snippet is not produced by `browserreflex-mcp init` and has not been checked against any agent.

## Limits

- **The web UI and the local REST API are not reachable from the host.** Both bind to `127.0.0.1` by design, with no option to widen it, so they listen only inside the container's own network namespace. Publishing a port does not help. This image does not start them, and no port is exposed. Use a source install (see [QUICKSTART.md](QUICKSTART.md)) to use the UI.
- **The safety check is advisory.** The `action_guard` tool reports; it does not stop an agent that ignores it. Running in a container does not change that.
- The system keyring (`@napi-rs/keyring`) is unlikely to have a backend inside a slim container, so storing a provider key there is unverified and probably unavailable. Chat mode needs no key.
- The pnpm version in `packageManager` (`pnpm@12.4.2`) is fetched by corepack at build time; whether that resolves has not been checked.
