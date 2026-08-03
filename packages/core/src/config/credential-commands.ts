/** The sign-in commands the app tells the user to run, and shells out to on
 *  their behalf.
 *
 *  Single source of truth on purpose: each command appears in three places
 *  that must agree exactly — the rewritten error message
 *  (`toUserFriendlyError`), the renderer's sniff that decides which sign-in
 *  button to offer, and the spawn in the corresponding IPC handler. A drift
 *  between any two of them shows the user an error with no button.
 *
 *  Browser-safe (a plain string constant), so the renderer can match on the
 *  same value the main process embeds. */

/** Establishes GCP Application Default Credentials. Takes no profile — ADC is
 *  a single machine-wide credential. */
export const GCLOUD_ADC_LOGIN_COMMAND = 'gcloud auth application-default login';

/** Marker the AWS credential-expiry message carries. The full message names a
 *  profile, so consumers match on this prefix rather than the whole string. */
export const AWS_SSO_LOGIN_COMMAND_PREFIX = 'aws sso login';
