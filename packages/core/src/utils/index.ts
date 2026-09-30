export { isStringRecord, parseJsonArray, parseJsonObject } from './json.js';
// Node-only (node:fs) — fine here: only the Node entry re-exports this barrel;
// browser-graph modules import './json.js' directly.
export { hasErrnoCode, quarantineFile, readTextIfExists, writeFileAtomic } from './atomic-file.js';
