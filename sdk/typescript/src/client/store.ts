import type { BootstrapResponse, Flag, PatchEvent, Segment } from '../types.js';

/** An immutable view of one environment's flag config at one state version. */
export interface Snapshot {
  envKey: string;
  stateVersion: number;
  flags: ReadonlyMap<string, Flag>;
  segments: ReadonlyMap<string, Segment>;
  /** When this snapshot was last written, from `Date.now()`. */
  updatedAt: number;
}

const EMPTY: Snapshot = {
  envKey: '',
  stateVersion: -1,
  flags: new Map(),
  segments: new Map(),
  updatedAt: 0,
};

/**
 * The in-memory config the evaluator reads.
 *
 * Snapshots are swapped wholesale rather than mutated, so an evaluation in flight always sees one
 * coherent version of the config and never a half-applied update. There is no locking because a
 * reference swap is atomic.
 */
export class ConfigStore {
  private snapshot: Snapshot = EMPTY;
  private initialised = false;

  get current(): Snapshot {
    return this.snapshot;
  }

  /** True once any config has been loaded, from the network or from `initialBootstrap`. */
  get isInitialised(): boolean {
    return this.initialised;
  }

  get stateVersion(): number {
    return this.snapshot.stateVersion;
  }

  getFlag(flagKey: string): Flag | undefined {
    return this.snapshot.flags.get(flagKey);
  }

  get flagKeys(): string[] {
    return [...this.snapshot.flags.keys()];
  }

  /**
   * Replaces the whole config: the SSE `put` event and every bootstrap response.
   *
   * Returns true when anything actually changed, so callers can skip a no-op change notification.
   */
  applyPut(payload: BootstrapResponse, now = Date.now()): boolean {
    const flags = new Map<string, Flag>();
    for (const flag of payload.flags ?? []) {
      flags.set(flag.key, flag);
    }
    const segments = new Map<string, Segment>();
    for (const segment of payload.segments ?? []) {
      segments.set(segment.key, segment);
    }
    const changed =
      !this.initialised ||
      this.snapshot.stateVersion !== payload.stateVersion ||
      this.snapshot.flags.size !== flags.size;
    this.snapshot = {
      envKey: payload.envKey,
      stateVersion: payload.stateVersion,
      flags,
      segments,
      updatedAt: now,
    };
    this.initialised = true;
    return changed;
  }

  /**
   * Upserts one flag's environment config: the SSE `patch` event.
   *
   * A patch carries only `{enabled, killSwitchActive, config, version}` - not `variations` or
   * `kind` - so it can only be merged onto a flag already in the snapshot. A patch for an unknown
   * flag returns false, which the client treats as "resynchronise from bootstrap".
   */
  applyPatch(patch: PatchEvent, now = Date.now()): boolean {
    const existing = this.snapshot.flags.get(patch.flagKey);
    if (existing === undefined) {
      // Still record the state version so a later reconnect resumes from the right place.
      this.snapshot = { ...this.snapshot, stateVersion: patch.stateVersion, updatedAt: now };
      return false;
    }
    const flags = new Map(this.snapshot.flags);
    flags.set(patch.flagKey, {
      ...existing,
      enabled: patch.enabled,
      killSwitchActive: patch.killSwitchActive,
      config: patch.config,
      version: patch.version ?? existing.version,
    });
    this.snapshot = {
      ...this.snapshot,
      stateVersion: patch.stateVersion,
      flags,
      updatedAt: now,
    };
    return true;
  }

  /** Drops everything. Used by `close()`; the store is reusable afterwards. */
  clear(): void {
    this.snapshot = EMPTY;
    this.initialised = false;
  }
}
