import type { CostApi } from '@costgoblin/core/browser';

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
  }

  interface DebugApi {
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
    costgoblinDebug: DebugApi;
    costgoblinPerf?: PerfApi;
    __PERF_REACT__?: RenderTiming[];
  }
  var costgoblin: CostApi;
  var costgoblinDebug: DebugApi;
  var costgoblinPerf: PerfApi | undefined;
  var __PERF_REACT__: RenderTiming[] | undefined;
}
