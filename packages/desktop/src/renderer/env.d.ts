import type { CostApi, UpdateApi } from '@costgoblin/core/browser';

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
  }

  interface DebugApi {
    isDev(): boolean;
    isE2E(): boolean;
    getMemoryMB(): Promise<number>;
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

  interface VaultApi {
    getStatus(): Promise<{ state: 'not-configured' | 'locked' | 'unlocked' }>;
    unlock(password: string): Promise<{ success: boolean; dataDir: string | null }>;
    setup(password: string | null): Promise<void>;
    reset(): Promise<void>;
  }

  interface Window {
    costgoblin: CostApi;
    costgoblinUpdate: UpdateApi;
    costgoblinDebug: DebugApi;
    costgoblinVault: VaultApi;
    costgoblinPerf?: PerfApi;
    __PERF_REACT__?: RenderTiming[];
  }
  var costgoblin: CostApi;
  var costgoblinUpdate: UpdateApi;
  var costgoblinDebug: DebugApi;
  var costgoblinVault: VaultApi;
  var costgoblinPerf: PerfApi | undefined;
  var __PERF_REACT__: RenderTiming[] | undefined;
}
