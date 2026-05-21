import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeliveryCache } from "../src/dedupe-cache.js";

test("tracks delivery IDs and expires old entries", () => {
  let now = 1000;
  const cache = new DeliveryCache({ ttlMs: 100, now: () => now });

  cache.add("delivery-1");
  assert.equal(cache.has("delivery-1"), true);

  now = 1200;
  assert.equal(cache.has("delivery-1"), false);
});

test("persists delivery IDs to disk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "router-cache-"));
  const filePath = path.join(dir, "deliveries.json");
  const cache = new DeliveryCache({ filePath, now: () => 1000 });
  cache.add("delivery-1");
  await cache.save();

  assert.match(await readFile(filePath, "utf8"), /delivery-1/);

  const reloaded = new DeliveryCache({ filePath, now: () => 1000 });
  await reloaded.load();
  assert.equal(reloaded.has("delivery-1"), true);
});
