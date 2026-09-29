import { CONFIG_PREFIX_SEPARATOR, type loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';

/** The loader's result, derived from the loader itself: the package's own
 *  `SharedConfigFiles` re-export is deprecated in favour of @smithy/types,
 *  which is not a dependency here. */
type SharedConfigFiles = Awaited<ReturnType<typeof loadSharedConfigFiles>>;

/** Config-file section types the SDK's loader keeps next to profiles, keyed
 *  `<type><CONFIG_PREFIX_SEPARATOR><name>`: they configure profiles, but are
 *  not profiles `S3Client({ profile })` can load. */
const NON_PROFILE_SECTIONS = ['sso-session', 'services'];

/** The profile names the AWS SDK can load, from the files as its own loader
 *  (`loadSharedConfigFiles`) parsed them: `default` plus every profile of the
 *  config and credentials files, sorted for the picker.
 *
 *  Taking the loader's output rather than reading `~/.aws` by hand is the
 *  point: the loader honours `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE`
 *  (with the SDK's `~/` expansion and home-dir rules), strips header comments
 *  (`[profile prod] # main`), and drops sections that are not profiles — so
 *  the picker offers exactly what the SDK will resolve. */
export function awsProfileNames(files: SharedConfigFiles): string[] {
  const names = new Set(['default']);
  for (const key of [...Object.keys(files.configFile), ...Object.keys(files.credentialsFile)]) {
    if (NON_PROFILE_SECTIONS.some(section => key.startsWith(`${section}${CONFIG_PREFIX_SEPARATOR}`))) continue;
    names.add(key);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
