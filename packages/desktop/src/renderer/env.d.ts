import type { CostApi, UpdateApi, RollupApi, BaselinesApi } from '@costgoblin/core/browser';

declare global {
  interface DebugQueryLogEntry {
    readonly id: number;
    readonly sql: string;
    readonly paramCount: number;
    readonly status: 'queued' | 'running' | 'success' | 'error';
    readonly startedAt: number;
    readonly durationMs: number | null;
    readonly rowCount: number | null;
    readonly error: string | null;
    readonly materialized: boolean;
    readonly cached: boolean;
    readonly origin: string | null;
  }

  interface BranchPrInfo {
    readonly url: string;
    readonly title: string;
    readonly number: number;
  }

  interface DebugApi {
    isDev(): boolean;
    isE2E(): boolean;
    fakeNowMs(): number | null;
    getMemoryMB(): Promise<number>;
    getGitBranch(): Promise<string | null>;
    getBranchPr(): Promise<BranchPrInfo | null>;
    getInFlightCount(): number;
    getQueryLog(): Promise<DebugQueryLogEntry[]>;
    runExplain(queryId: number): Promise<string>;
    clearLog(): Promise<void>;
  }

  interface IpcTiming {
    readonly channel: string;
    readonly durationMs: number;
    readonly timestamp: string;
  }

  interface PerfApi {
    getIpcTimings(): IpcTiming[];
    clearIpcTimings(): void;
    startCpuProfile(): Promise<undefined>;
    stopCpuProfile(label: string): Promise<{ path: string }>;
  }

  interface RenderTiming {
    readonly id: string;
    readonly phase: string;
    readonly actualDuration: number;
    readonly baseDuration: number;
    readonly startTime: number;
    readonly commitTime: number;
  }

  interface Window {
    costgoblin: CostApi;
    costgoblinUpdate: UpdateApi;
    costgoblinRollup: RollupApi;
    costgoblinBaselines: BaselinesApi;
    costgoblinDebug: DebugApi;
    costgoblinPerf?: PerfApi;
    __PERF_REACT__?: RenderTiming[];
  }
  var costgoblin: CostApi;
  var costgoblinUpdate: UpdateApi;
  var costgoblinRollup: RollupApi;
  var costgoblinBaselines: BaselinesApi;
  var costgoblinDebug: DebugApi;
  var costgoblinPerf: PerfApi | undefined;
  var __PERF_REACT__: RenderTiming[] | undefined;
}
