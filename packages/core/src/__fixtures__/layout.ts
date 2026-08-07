/** The provider instance name used by ALL committed fixtures: the fixture
 *  config (config/costgoblin.yaml `providers[0].name`) and the synthetic
 *  Parquet tree (`synthetic/{name}/raw/...`) must agree — the data layout
 *  keys off the provider name since #516. Import this constant instead of
 *  hard-coding either side. */
export const FIXTURE_PROVIDER_NAME = 'aws-main';

/** Second provider instance, present in the synthetic tree but listed only by
 *  the `config-multi` fixture. The single-provider config never names it, and
 *  `buildSource` globs per CONFIGURED provider — so the extra directory is
 *  inert for every existing suite while giving the mixed-workspace e2e a real
 *  GCP branch to query. Its Parquet is written by the real canonicalizer, not
 *  hand-shaped, so it carries the genuine post-sync layout. */
export const FIXTURE_GCP_PROVIDER_NAME = 'gcp-main';
