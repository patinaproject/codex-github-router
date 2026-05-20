import { promises as fs } from "node:fs";
import path from "node:path";
import { cacheDir } from "./config.js";
import type { PathContext } from "./types.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class DeliveryCache {
  private ttlMs: number;
  private now: () => number;
  private filePath: string | undefined;
  private entries: Map<string, number>;

  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now(), filePath }: { ttlMs?: number; now?: () => number; filePath?: string } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.filePath = filePath;
    this.entries = new Map();
  }

  static persistent(context: PathContext = {}): DeliveryCache {
    return new DeliveryCache({
      filePath: path.join(cacheDir(context), "deliveries.json"),
    });
  }

  async load(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, number>;
      this.entries = new Map(Object.entries(parsed));
      this.prune();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  has(deliveryId: string): boolean {
    this.prune();
    return this.entries.has(deliveryId);
  }

  add(deliveryId: string): void {
    this.entries.set(deliveryId, this.now());
    this.prune();
  }

  delete(deliveryId: string): void {
    this.entries.delete(deliveryId);
  }

  prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [deliveryId, timestamp] of this.entries) {
      if (timestamp < cutoff) {
        this.entries.delete(deliveryId);
      }
    }
  }

  async save(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, `${JSON.stringify(Object.fromEntries(this.entries), null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
