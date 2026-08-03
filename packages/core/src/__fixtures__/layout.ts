/** The provider instance name used by ALL committed fixtures: the fixture
 *  config (config/costgoblin.yaml `providers[0].name`) and the synthetic
 *  Parquet tree (`synthetic/{name}/raw/...`) must agree — the data layout
 *  keys off the provider name since #516. Import this constant instead of
 *  hard-coding either side. */
export const FIXTURE_PROVIDER_NAME = 'aws-main';
