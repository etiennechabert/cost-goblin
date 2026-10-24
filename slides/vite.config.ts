import { fileURLToPath } from 'node:url'

// The goblin art and app screenshots stay where the website and the app keep
// them; the decks read them in place instead of holding copies that drift.
const site = fileURLToPath(new URL('../docs', import.meta.url))
const app = fileURLToPath(new URL('../packages/desktop/src/renderer/public', import.meta.url))

// A plain object, merged by Slidev into its own Vite config: importing
// `defineConfig` would need `vite`, which is only Slidev's dependency.
export default {
  resolve: {
    alias: {
      '@site': site,
      '@app': app,
    },
  },
  server: {
    fs: {
      allow: [site, app],
    },
  },
  // Slidev 53.0.0's own stylesheet comes out of the production build with two
  // malformed rules (code line numbers, KaTeX highlights), and the minifier
  // rejects them, failing even an empty deck. Unminified, the browser drops
  // just those two rules, which these decks never use.
  build: {
    cssMinify: false,
  },
}
