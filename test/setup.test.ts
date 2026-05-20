import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { parseKeys, runInteractiveSetup } from "../src/setup.js";

test("parses menu navigation keys", () => {
  assert.deepEqual(parseKeys("\u001b[A\u001b[B jk \rQ"), ["up", "down", "space", "down", "up", "space", "enter", "q"]);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

test("interactive setup selects repositories and organizations then visits settings sections", async () => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  let rawMode: boolean | undefined;
  stdin.setRawMode = (value: boolean) => {
    rawMode = value;
    return stdin;
  };
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  const setup = runInteractiveSetup({
    context: {
      stdin,
      stdout,
      stderr: new PassThrough(),
      env: { NO_COLOR: "1" },
    },
    discoverTargets: async () => ({
      repositories: [
        { id: "owner/one", label: "owner/one" },
        { id: "owner/two", label: "owner/two" },
      ],
      organizations: [{ id: "owner", label: "owner" }],
    }),
  });

  await waitUntil(() => output.includes("Select repositories"));
  stdin.write(" \r");
  await waitUntil(() => output.includes("Select organizations"));
  stdin.write(" \r");
  await waitUntil(() => output.includes("Settings"));
  stdin.write("\r");
  await waitUntil(() => output.includes("Press any key to return"));
  stdin.write("x");
  await waitUntil(() => output.split("Settings").length > 2);
  stdin.write("j\r");
  await waitUntil(() => output.includes("Organization-level settings"));
  stdin.write("x");
  await waitUntil(() => output.split("Settings").length > 3);
  stdin.write("jj\r");
  const result = await setup;

  assert.equal(rawMode, false);
  assert.deepEqual(result, {
    repositories: [{ fullName: "owner/one", enabled: true, issueAutomationEnabled: false }],
    organizations: [{ login: "owner", enabled: true, issueAutomationEnabled: false }],
    setupRequired: false,
  });
  assert.match(output, /Select repositories/);
  assert.match(output, /Repository-level settings/);
  assert.match(output, /Organization-level settings/);
});

test("interactive setup reports non-TTY setup requirement", async () => {
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  const result = await runInteractiveSetup({
    context: {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      env: {},
    },
  });

  assert.equal(result.setupRequired, true);
  assert.match(output, /interactive terminal/);
});
