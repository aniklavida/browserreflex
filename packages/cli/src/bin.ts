#!/usr/bin/env node
/**
 * The `browserreflex-mcp` executable.
 *
 * Everything interesting is in `cli.ts`; this file only hands over the real
 * process: the real arguments, stdout, stderr and environment. Nothing is
 * written to stdout except the command's own output, because `serve` puts the
 * JSON-RPC stream there.
 *
 * The shebang is the first line because this file is what a package manager
 * links onto `PATH` under the name `browserreflex-mcp`, and a linked file
 * without one cannot be executed by a shell.
 */

import { runCli, findStaticUiDir } from './cli.js';

const exitCode = await runCli({
  argv: process.argv.slice(2),
  streams: {
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  },
  env: process.env,
  staticDir: findStaticUiDir(),
});

process.exitCode = exitCode;
