import type { Platform } from "../models.ts";
import { FacebookCollector } from "./facebook.ts";
import { InstagramCollector } from "./instagram.ts";
import { ThreadsCollector } from "./threads.ts";
import type { Collector, CollectorDeps, ConnectionConfig } from "./types.ts";
import { XCollector } from "./x.ts";

export function createCollector(cfg: ConnectionConfig, deps: CollectorDeps = {}): Collector {
  const map: Record<Platform, new (c: ConnectionConfig, d: CollectorDeps) => Collector> = {
    instagram: InstagramCollector, facebook: FacebookCollector, threads: ThreadsCollector, x: XCollector,
  };
  return new map[cfg.platform](cfg, deps);
}

export { ApiError } from "./http.ts";
export type { CollectResult, CollectedPost, AccountSnapshot } from "./http.ts";
export type { CollectOptions, Collector, ConnectionConfig } from "./types.ts";
export { XCollector };
