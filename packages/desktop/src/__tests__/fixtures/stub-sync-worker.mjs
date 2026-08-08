// Minimal stand-in for the real sync worker, used to unit-test SyncClient's
// per-key mutex and keyed cancellation without spawning a real download.
//
// Protocol (subset of the real worker):
//  - posts { kind: 'ready' } on start
//  - on { kind: 'sync', id, bucketPath }: completes immediately when bucketPath
//    contains 'complete-now', otherwise stays in-flight (hangs) so the test can
//    hold a key active and then cancel it
//  - on { kind: 'cancel', id }: replies { kind: 'error', id, message: 'Download cancelled' }
import { parentPort } from 'node:worker_threads';

if (parentPort !== null) {
  const port = parentPort;
  port.postMessage({ kind: 'ready' });
  port.on('message', (msg) => {
    if (msg?.kind === 'sync') {
      if (typeof msg.bucketPath === 'string' && msg.bucketPath.includes('complete-now')) {
        port.postMessage({ kind: 'complete', id: msg.id, filesDownloaded: 1, rowsProcessed: 10 });
      }
      // else: intentionally leave the request in-flight until cancelled.
    } else if (msg?.kind === 'cancel') {
      port.postMessage({ kind: 'error', id: msg.id, message: 'Download cancelled' });
    }
  });
}
