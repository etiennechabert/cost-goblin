import type { CostApi } from '@costgoblin/core/browser';

declare global {
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
    costgoblinPerf?: PerfApi;
    __PERF_REACT__?: RenderTiming[];
  }
  var costgoblin: CostApi;
  var costgoblinPerf: PerfApi | undefined;
  var __PERF_REACT__: RenderTiming[] | undefined;
}
