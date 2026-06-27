import { app } from 'electron';
// Statically imported (not lazy) so init can run SYNCHRONOUSLY before Electron's
// `ready` event — the only window in which @sentry/electron can arm the native
// crash handler. Importing the module is side-effect-free; nothing is captured
// or sent until `Sentry.init` runs, which only happens when the user opts in.
import * as Sentry from '@sentry/electron/main';
import type { Event } from '@sentry/electron/main';
import {
  isTelemetryEnabled,
  logger,
  summarizeEventForOutbox,
  TELEMETRY_DEFAULTS,
} from '@costgoblin/core';
import type { TelemetryPreferences, TelemetryStatus } from '@costgoblin/core';
import { redactEventInPlace } from './scrub-event.js';
import { readDevTagsSync } from './dev-tags.js';
import { TelemetryOutbox } from './outbox.js';

/** DSN for the Sentry project. Without it, no channel can actually send — the
 *  app stays dark even if the user opts in. Kept in env (not hard-coded) so the
 *  endpoint is configurable for self-hosted collectors (SPEC.md). */
const DSN_ENV = 'COSTGOBLIN_SENTRY_DSN';
/** Optional self-hosted tunnel/relay endpoint (Sentry `tunnel` option). */
const TUNNEL_ENV = 'COSTGOBLIN_SENTRY_TUNNEL';

/**
 * Owns the opt-in Sentry SDK lifecycle in the main process. `Sentry.init` only
 * runs — and nothing is captured or sent — when the user has enabled a channel
 * AND a DSN is configured. Every event is scrubbed and mirrored to a local audit
 * outbox before it leaves.
 *
 * `@sentry/electron` can only arm the native crash handler (Crashpad) BEFORE
 * Electron's `ready` event, so the opt-in is decided at startup from the saved
 * preference and {@link start} inits SYNCHRONOUSLY on the boot path. A mid-session
 * toggle saves the new choice and the renderer restarts the app to re-arm — see
 * {@link applyPreferences}.
 */
class TelemetryController {
  private prefs: TelemetryPreferences = TELEMETRY_DEFAULTS;
  private active = false;
  // The channel state the SDK actually armed with at init(). Native capture and
  // tracing can only arm at boot, so this is the source of truth for "what's
  // really live" — a later applyPreferences changes `prefs` (desired state) but
  // not what Crashpad/tracing are doing until the next launch.
  private initSnapshot: TelemetryPreferences | null = null;
  private outbox: TelemetryOutbox | null = null;

  /** Called once at startup with the directory that holds the audit log. */
  initialize(outboxDir: string): void {
    this.outbox = new TelemetryOutbox(outboxDir);
  }

  private dsn(): string | undefined {
    const env = process.env[DSN_ENV];
    if (typeof env === 'string' && env.length > 0) return env;
    // Build-time default, inlined by electron-vite from MAIN_VITE_SENTRY_DSN.
    // Undefined when none was baked in — lets packaged builds report without the
    // user setting an env var, while dev/forks/tests stay dark.
    const baked = import.meta.env.MAIN_VITE_SENTRY_DSN;
    return typeof baked === 'string' && baked.length > 0 ? baked : undefined;
  }

  getStatus(): TelemetryStatus {
    return {
      dsnConfigured: this.dsn() !== undefined,
      active: this.active,
      preferences: this.prefs,
      armed: this.armedChannels(),
    };
  }

  /** What each channel is *actually* doing this session (vs. the desired state in
   *  {@link prefs}). JS error capture is live whenever the SDK is active — its
   *  per-event gate reads the current pref. Native capture and tracing only arm
   *  at init(), so they're live only if armed at boot AND still wanted. */
  private armedChannels(): TelemetryPreferences {
    if (!this.active || this.initSnapshot === null) return TELEMETRY_DEFAULTS;
    return {
      errorReports: this.prefs.errorReports,
      nativeCrashReports: this.initSnapshot.nativeCrashReports && this.prefs.nativeCrashReports,
      performance: this.initSnapshot.performance && this.prefs.performance,
      analytics: false,
    };
  }

  async getOutbox(): ReturnType<TelemetryOutbox['list']> {
    return this.outbox === null ? [] : this.outbox.list();
  }

  /**
   * Boot-time init — MUST run synchronously before Electron's `ready` event so
   * @sentry/electron can arm the native Crashpad handler. Inits when a channel
   * is on and a DSN is configured; otherwise stays dark. Opt-in comes from the
   * saved prefs. Synchronous: any `await` here would yield to the event loop and
   * let `ready` fire first.
   */
  start(prefs: TelemetryPreferences): void {
    this.prefs = prefs;
    const dsn = this.dsn();
    if (!isTelemetryEnabled(prefs) || dsn === undefined) return;
    this.init(dsn);
  }

  /**
   * Mid-session preference change from the Settings toggle. Native capture can
   * only arm at boot ({@link start}), so the new state takes full effect on the
   * next launch and the renderer prompts a restart. We still stop the running
   * SDK immediately when telemetry is turned OFF, so nothing more leaves the
   * machine before the user restarts.
   */
  async applyPreferences(prefs: TelemetryPreferences): Promise<void> {
    this.prefs = prefs;
    if (this.active && !isTelemetryEnabled(prefs)) await this.shutdown();
  }

  private init(dsn: string): void {
    try {
      const tunnel = process.env[TUNNEL_ENV];
      // Dev builds get { branch, commit } tags so locally-run sessions can be
      // told apart; packaged builds get none (they're a release version).
      const devTags = readDevTagsSync(app.isPackaged, app.getAppPath());
      Sentry.init({
        dsn,
        ...(typeof tunnel === 'string' && tunnel.length > 0 ? { tunnel } : {}),
        environment: app.isPackaged ? 'production' : 'development',
        release: `costgoblin@${app.getVersion()}`,
        ...(Object.keys(devTags).length > 0 ? { initialScope: { tags: devTags } } : {}),
        // Native crash capture (Crashpad minidumps = raw, unscrubbed memory) is a
        // separate opt-in: keep every default integration only when the native
        // channel is on; otherwise drop SentryMinidump — the first default, which
        // arms the native crash handler. Scrubbed JS error capture flows either way.
        integrations: (defaults) =>
          this.prefs.nativeCrashReports ? defaults : defaults.filter((i) => i.name !== 'SentryMinidump'),
        // Tracing only when the performance channel is on.
        tracesSampleRate: this.prefs.performance ? 0.1 : 0,
        // Never let the SDK attach IP/user/cookies — our scrub is the backstop,
        // but default-off is the first line of defence.
        sendDefaultPii: false,
        beforeSend: (event) => this.scrubAndRecord(event),
        beforeSendTransaction: (event) => this.scrubAndRecord(event),
      });
      this.active = true;
      this.initSnapshot = this.prefs;
      logger.info('telemetry: Sentry initialised', {
        errorReports: this.prefs.errorReports,
        nativeCrashReports: this.prefs.nativeCrashReports,
        performance: this.prefs.performance,
      });
    } catch (err: unknown) {
      this.active = false;
      logger.warn(`telemetry: failed to initialise Sentry — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async shutdown(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.initSnapshot = null;
    try {
      await Sentry.flush(2000);
      await Sentry.close(2000);
      logger.info('telemetry: Sentry shut down');
    } catch (err: unknown) {
      logger.warn(`telemetry: error during shutdown — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** beforeSend / beforeSendTransaction hook: gate by channel, scrub PII, and
   *  mirror to the audit outbox. Returning null drops the event. Generic so the
   *  SDK's ErrorEvent / TransactionEvent return types are preserved. */
  private scrubAndRecord<T extends Event>(event: T): T | null {
    // Gate by channel. Native crash events (Crashpad minidumps, which
    // @sentry/electron emits with platform: 'native' via captureEvent) belong to
    // nativeCrashReports — independent of errorReports. So a native-only opt-in
    // works, and disabling native mid-session drops the dump (and its attachment)
    // here before the user restarts, even though Crashpad stays armed until then.
    if (event.type === 'transaction') {
      if (!this.prefs.performance) return null;
    } else if (event.platform === 'native') {
      if (!this.prefs.nativeCrashReports) return null;
    } else if (!this.prefs.errorReports) {
      return null;
    }

    redactEventInPlace(event);
    if (this.outbox !== null) {
      // Best-effort audit mirror: the write is async and the event is returned to
      // the transport regardless. Native crashes are replayed on the NEXT launch
      // (process alive), so they always record; only an immediate fatal JS crash
      // could exit before this flushes — an acceptable gap for the scrubbed
      // channel, and not worth blocking beforeSend on synchronous disk I/O.
      void this.outbox.record(summarizeEventForOutbox(event, new Date().toISOString()));
    }
    return event;
  }
}

/** Process-wide singleton — main.ts initialises it, the IPC handler drives it. */
export const telemetry = new TelemetryController();
