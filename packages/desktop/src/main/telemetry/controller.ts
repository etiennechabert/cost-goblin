import { app } from 'electron';
import type { Event } from '@sentry/electron/main';
import {
  isTelemetryEnabled,
  logger,
  summarizeEventForOutbox,
  TELEMETRY_DEFAULTS,
} from '@costgoblin/core';
import type { TelemetryPreferences, TelemetryStatus } from '@costgoblin/core';
import { redactEventInPlace } from './scrub-event.js';
import { readDevTags } from './dev-tags.js';
import { TelemetryOutbox } from './outbox.js';

/** DSN for the Sentry project. Without it, no channel can actually send — the
 *  app stays dark even if the user opts in. Kept in env (not hard-coded) so the
 *  endpoint is configurable for self-hosted collectors (SPEC.md). */
const DSN_ENV = 'COSTGOBLIN_SENTRY_DSN';
/** Optional self-hosted tunnel/relay endpoint (Sentry `tunnel` option). */
const TUNNEL_ENV = 'COSTGOBLIN_SENTRY_TUNNEL';

type SentryMain = typeof import('@sentry/electron/main');

/**
 * Owns the opt-in Sentry SDK lifecycle in the main process. The SDK is loaded
 * lazily — only when the user has enabled a channel AND a DSN is configured — so
 * a default install never pulls in or runs the reporter. Every event is scrubbed
 * and mirrored to a local audit outbox before it leaves.
 */
class TelemetryController {
  private prefs: TelemetryPreferences = TELEMETRY_DEFAULTS;
  private sentry: SentryMain | null = null;
  private outbox: TelemetryOutbox | null = null;
  // Serializes reconcile() so two quick toggles can't overlap a shutdown with a
  // start (or two inits). Each call records the latest desired prefs, then the
  // chain reconciles to whatever that is when it runs.
  private reconcileChain: Promise<void> = Promise.resolve();

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
      active: this.sentry !== null,
      preferences: this.prefs,
    };
  }

  async getOutbox(): ReturnType<TelemetryOutbox['list']> {
    return this.outbox === null ? [] : this.outbox.list();
  }

  /** Persist-then-apply is the handler's job; this just reconciles the running
   *  SDK with the desired preferences. Closing then re-initialising on every
   *  change keeps sample rates and channel gating correct. Serialized so
   *  concurrent toggles can't interleave shutdown/start. */
  applyPreferences(prefs: TelemetryPreferences): Promise<void> {
    this.prefs = prefs;
    const run = this.reconcileChain.then(() => this.reconcile());
    this.reconcileChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reconcile(): Promise<void> {
    const prefs = this.prefs; // always reconcile to the latest desired state
    const dsn = this.dsn();
    if (this.sentry !== null) await this.shutdown();
    if (!isTelemetryEnabled(prefs) || dsn === undefined) return;
    await this.start(dsn);
  }

  private async start(dsn: string): Promise<void> {
    try {
      const tunnel = process.env[TUNNEL_ENV];
      // Dev builds get { branch, commit } tags so locally-run sessions can be
      // told apart; packaged builds get none (they're a release version).
      const devTags = await readDevTags(app.isPackaged, app.getAppPath());
      const Sentry = await import('@sentry/electron/main');
      Sentry.init({
        dsn,
        ...(typeof tunnel === 'string' && tunnel.length > 0 ? { tunnel } : {}),
        environment: app.isPackaged ? 'production' : 'development',
        release: `costgoblin@${app.getVersion()}`,
        ...(Object.keys(devTags).length > 0 ? { initialScope: { tags: devTags } } : {}),
        // Tracing only when the performance channel is on.
        tracesSampleRate: this.prefs.performance ? 0.1 : 0,
        // Never let the SDK attach IP/user/cookies — our scrub is the backstop,
        // but default-off is the first line of defence.
        sendDefaultPii: false,
        beforeSend: (event) => this.scrubAndRecord(event),
        beforeSendTransaction: (event) => this.scrubAndRecord(event),
      });
      this.sentry = Sentry;
      logger.info('telemetry: Sentry initialised', {
        crashReports: this.prefs.crashReports,
        performance: this.prefs.performance,
      });
    } catch (err: unknown) {
      this.sentry = null;
      logger.warn(`telemetry: failed to initialise Sentry — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async shutdown(): Promise<void> {
    const sdk = this.sentry;
    this.sentry = null;
    if (sdk === null) return;
    try {
      await sdk.flush(2000);
      await sdk.close(2000);
      logger.info('telemetry: Sentry shut down');
    } catch (err: unknown) {
      logger.warn(`telemetry: error during shutdown — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** beforeSend / beforeSendTransaction hook: gate by channel, scrub PII, and
   *  mirror to the audit outbox. Returning null drops the event. Generic so the
   *  SDK's ErrorEvent / TransactionEvent return types are preserved. */
  private scrubAndRecord<T extends Event>(event: T): T | null {
    const isTransaction = event.type === 'transaction';
    if (isTransaction && !this.prefs.performance) return null;
    if (!isTransaction && !this.prefs.crashReports) return null;

    redactEventInPlace(event);
    if (this.outbox !== null) {
      void this.outbox.record(summarizeEventForOutbox(event, new Date().toISOString()));
    }
    return event;
  }
}

/** Process-wide singleton — main.ts initialises it, the IPC handler drives it. */
export const telemetry = new TelemetryController();
