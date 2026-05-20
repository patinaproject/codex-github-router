#!/usr/bin/env node
import { runCli } from "../dist/cli.js";

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
}).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
