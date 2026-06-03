import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import lockfile from "proper-lockfile";
import type { EventStore, StoreEvent } from "./types.js";

export class JsonlEventStore implements EventStore {
  readonly path: string;

  constructor(stateDir: string, filename = "events.jsonl") {
    this.path = join(stateDir, filename);
  }

  async append<TPayload>(
    event: Omit<StoreEvent<TPayload>, "id" | "timestamp">,
  ): Promise<StoreEvent<TPayload>> {
    await mkdir(dirname(this.path), { recursive: true });
    const file = await open(this.path, "a+");
    await file.close();

    const release = await lockfile.lock(this.path, {
      realpath: false,
      retries: { retries: 5, minTimeout: 20, maxTimeout: 100 },
    });

    const fullEvent: StoreEvent<TPayload> = {
      id: nanoid(),
      timestamp: new Date().toISOString(),
      ...event,
    };

    try {
      const handle = await open(this.path, "a");
      try {
        await handle.appendFile(`${JSON.stringify(fullEvent)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return fullEvent;
    } finally {
      await release();
    }
  }

  async readAll(): Promise<StoreEvent[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as StoreEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
