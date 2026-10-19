import type {
  BaselineRecomputeStatus,
  BaselinesApi,
  RollupApi,
  RollupStats,
  RollupStatus,
  UpdateApi,
  UpdateSnapshot,
  UpdateStatus,
} from '@costgoblin/core/browser';
import { MockCostApi } from '@costgoblin/ui';

/** Typed stand-ins for the window bridges the preload exposes to the renderer
 *  (see preload.ts and renderer/env.d.ts). Each fake keeps its state in plain
 *  fields a test sets directly; a push channel lets a test deliver what the
 *  main process would push. renderer-setup.ts installs them on `globalThis` and
 *  resets them in place after every test. */

/** A preload `onStatusChanged` bridge: subscribers stay until they
 *  unsubscribe, and `emit` delivers to each of them. */
class PushChannel<T> {
  private readonly listeners = new Set<(value: T) => void>();

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
}

export class FakeDebugApi implements DebugApi {
  dev = false;
  e2e = false;
  memoryMB = 0;
  gitBranch: string | null = null;
  branchPr: BranchPrInfo | null = null;
  inFlightCount = 0;
  queryLog: DebugQueryLogEntry[] = [];
  /** EXPLAIN ANALYZE output per query id; an id without one resolves to ''. */
  explainPlans = new Map<number, string>();

  isDev(): boolean { return this.dev; }
  isE2E(): boolean { return this.e2e; }
  fakeNowMs(): number | null { return null; }
  getMemoryMB(): Promise<number> { return Promise.resolve(this.memoryMB); }
  getGitBranch(): Promise<string | null> { return Promise.resolve(this.gitBranch); }
  getBranchPr(): Promise<BranchPrInfo | null> { return Promise.resolve(this.branchPr); }
  getInFlightCount(): number { return this.inFlightCount; }
  // A copy, like a fresh IPC payload — a test mutating `queryLog` afterwards
  // must not reach into what the renderer already holds.
  getQueryLog(): Promise<DebugQueryLogEntry[]> { return Promise.resolve([...this.queryLog]); }
  runExplain(queryId: number): Promise<string> { return Promise.resolve(this.explainPlans.get(queryId) ?? ''); }
  clearLog(): Promise<void> {
    this.queryLog = [];
    return Promise.resolve();
  }

  /** Back to the field defaults above. */
  reset(): void { Object.assign(this, new FakeDebugApi()); }
}

export class FakeUpdateApi implements UpdateApi {
  appVersion = '';
  snapshot: UpdateSnapshot = { status: { state: 'idle' }, checkedThisSession: false };
  checkOnStartup = true;
  statusPushes = new PushChannel<UpdateStatus>();

  checkForUpdates(): Promise<void> { return Promise.resolve(); }
  downloadUpdate(): Promise<void> { return Promise.resolve(); }
  quitAndInstall(): void { /* no app to quit under test */ }
  relaunch(): void { /* no app to relaunch under test */ }
  onStatusChanged(callback: (status: UpdateStatus) => void): () => void { return this.statusPushes.subscribe(callback); }
  getAppVersion(): Promise<string> { return Promise.resolve(this.appVersion); }
  getStatus(): Promise<UpdateSnapshot> { return Promise.resolve(this.snapshot); }
  getCheckOnStartup(): Promise<boolean> { return Promise.resolve(this.checkOnStartup); }
  setCheckOnStartup(value: boolean): Promise<void> {
    this.checkOnStartup = value;
    return Promise.resolve();
  }

  reset(): void { Object.assign(this, new FakeUpdateApi()); }
}

export class FakeRollupApi implements RollupApi {
  status: RollupStatus = { state: 'idle' };
  stats: RollupStats | null = null;
  statusPushes = new PushChannel<RollupStatus>();

  getStatus(): Promise<RollupStatus> { return Promise.resolve(this.status); }
  getStats(): Promise<RollupStats | null> { return Promise.resolve(this.stats); }
  onStatusChanged(callback: (status: RollupStatus) => void): () => void { return this.statusPushes.subscribe(callback); }

  reset(): void { Object.assign(this, new FakeRollupApi()); }
}

export class FakeBaselinesApi implements BaselinesApi {
  status: BaselineRecomputeStatus = { state: 'idle', lastRun: null };
  statusPushes = new PushChannel<BaselineRecomputeStatus>();

  getStatus(): Promise<BaselineRecomputeStatus> { return Promise.resolve(this.status); }
  onStatusChanged(callback: (status: BaselineRecomputeStatus) => void): () => void { return this.statusPushes.subscribe(callback); }

  reset(): void { Object.assign(this, new FakeBaselinesApi()); }
}

export const fakeDebug = new FakeDebugApi();
export const fakeUpdate = new FakeUpdateApi();
export const fakeRollup = new FakeRollupApi();
export const fakeBaselines = new FakeBaselinesApi();

/** Expose the fakes where the preload exposes the real bridges. Perf mode
 *  stays off: the preload only defines `costgoblinPerf` under
 *  COSTGOBLIN_PERF_MODE=1. */
export function installRendererBridges(): void {
  globalThis.costgoblin = new MockCostApi();
  globalThis.costgoblinDebug = fakeDebug;
  globalThis.costgoblinUpdate = fakeUpdate;
  globalThis.costgoblinRollup = fakeRollup;
  globalThis.costgoblinBaselines = fakeBaselines;
}

/** Reset every bridge in place. The singletons are never replaced, because a
 *  renderer module may hold the reference it read at import time. */
export function resetRendererBridges(): void {
  fakeDebug.reset();
  fakeUpdate.reset();
  fakeRollup.reset();
  fakeBaselines.reset();
  globalThis.costgoblin = new MockCostApi();
}
