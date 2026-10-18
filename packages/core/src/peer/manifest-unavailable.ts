/** The status a publisher answers `GET /manifest` with when it can't build
 *  its manifest because one of its config files doesn't load (a hand-edited
 *  cost-scope.yaml that fails validation). The text/plain body is that
 *  file's name and nothing else: the local error can quote a path. */
export const MANIFEST_UNAVAILABLE_STATUS = 503;

const CONFIG_FILE_NAME = /^[a-z][a-z0-9-]{0,63}\.yaml$/;

/** A bare config file name, such as `cost-scope.yaml`: never a path or a
 *  message. The publisher sends nothing else, and the peer shows nothing
 *  else. */
export function isConfigFileName(text: string): boolean {
  return CONFIG_FILE_NAME.test(text);
}

/** Thrown by a sharing server's `getManifest` when `file` (a bare name) is
 *  why there is no manifest. The server tells the peer which file, so it can
 *  say who has to fix what instead of blaming the network. */
export class ManifestUnavailableError extends Error {
  readonly file: string;

  constructor(file: string, options?: ErrorOptions) {
    super(`${file} doesn't load`, options);
    this.name = 'ManifestUnavailableError';
    this.file = file;
  }
}
