// Imported for its side effect, as the main process's FIRST import: libuv
// sizes its thread pool on first use and never again, so this must run before
// any other module of the bundle gets to use it. Keep it free of imports that
// do work at load time.
import { ensureUvThreadpoolSize } from './uv-threadpool.js';

ensureUvThreadpoolSize(process.env);
