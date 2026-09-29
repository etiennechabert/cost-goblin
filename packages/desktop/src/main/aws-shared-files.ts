import { join } from 'node:path';

/** The AWS config and credentials files, resolved the way the SDK resolves
 *  them (`getConfigFilepath` / `getCredentialsFilepath` in
 *  @smithy/shared-ini-file-loader, which it does not export):
 *  `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` when set and non-empty,
 *  else the files under `~/.aws`.
 *
 *  The profile picker must list the profiles the SDK can actually load.
 *  Reading `~/.aws` unconditionally offered profiles from a file the SDK
 *  ignores whenever an override is set — and read the developer's real
 *  profiles in the e2e harness, which points both variables into a sandbox. */
export function awsSharedConfigFiles(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): { configFile: string; credentialsFile: string } {
  const configOverride = env['AWS_CONFIG_FILE'];
  const credentialsOverride = env['AWS_SHARED_CREDENTIALS_FILE'];
  return {
    configFile: configOverride === undefined || configOverride.length === 0
      ? join(homeDir, '.aws', 'config')
      : configOverride,
    credentialsFile: credentialsOverride === undefined || credentialsOverride.length === 0
      ? join(homeDir, '.aws', 'credentials')
      : credentialsOverride,
  };
}
