import type { UpdateStatus } from '@costgoblin/core/browser';

export interface UpdateRowInputs {
  readonly state: UpdateStatus['state'];
  /** A check (startup or manual) ran this session. */
  readonly checked: boolean;
  /** The saved "Update check" preference (Automatic = true). */
  readonly checkOnStartup: boolean;
  /** '' until the main process has answered. */
  readonly appVersion: string;
}

/** Description under Settings → General → "Software updates". Idle alone can't
 *  say "up to date": with the startup check off (or before it finishes) nothing
 *  was checked, so the row says so instead. Every other state is described by
 *  the row's own control, so it returns undefined. */
export function describeUpdateRow({ state, checked, checkOnStartup, appVersion }: UpdateRowInputs): string | undefined {
  if (state !== 'idle') return undefined;
  const versionSuffix = appVersion === '' ? '' : ` · v${appVersion}`;
  if (checked) return `You're up to date${versionSuffix}`;
  if (!checkOnStartup) return `Automatic check is off${versionSuffix}`;
  return `Not checked yet${versionSuffix}`;
}
