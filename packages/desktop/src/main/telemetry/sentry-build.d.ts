/**
 * Build-time-injected default Sentry DSN. electron-vite inlines
 * `import.meta.env.MAIN_VITE_SENTRY_DSN` from the `MAIN_VITE_SENTRY_DSN` env var
 * present during the build (statically replaced — no runtime lookup), so
 * packaged builds can report without the user setting anything. Undefined in
 * dev/forks/tests when the var isn't set; the runtime `COSTGOBLIN_SENTRY_DSN`
 * env var takes precedence. A DSN only permits sending, so baking it is safe;
 * injecting at build time keeps it out of the public source.
 */
interface ImportMetaEnv {
  readonly MAIN_VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
