/** How every rejection the query engine's supervisor makes itself starts
 *  (`duckdb-supervisor.ts`). */
export const ENGINE_MESSAGE_PREFIX = 'The query engine ';

/** True for a rejection the supervisor made itself: the process the query was
 *  sent to is gone, or none is running. It says nothing about the query or
 *  the files it read, so a caller that falls back on a failed read must not
 *  fall back on this one. */
export function isQueryEngineUnavailable(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(ENGINE_MESSAGE_PREFIX);
}
