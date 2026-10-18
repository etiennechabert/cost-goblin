# Onboarding video slides

Two [Slidev](https://sli.dev) decks for the CostGoblin onboarding videos, in the website's look (near-black, emerald, the goblin):

| Deck | Video | Covers |
|---|---|---|
| [`aws.md`](aws.md) | Part 1: AWS | Billing prep, an AWS profile, the CloudFormation stack from the setup wizard, the first sync, dimensions |
| [`gcp.md`](gcp.md) | Part 2: Google Cloud | The FOCUS BigQuery export, the bucket, the exporter job, read access, the setup wizard |

The slides frame the live parts. Each **Live demo** slide says what is about to happen on screen. Switch the recording to your screen share after it, then back to the slides for the next chapter.

## Run

```bash
cd slides
npm ci          # npm >= 11.16 (Node >= 24.18), as at the root
npm run aws     # http://localhost:3030
npm run gcp     # http://localhost:3031, so both can run at once
```

## Present and record

- **Presenter view**: `http://localhost:3030/presenter` shows the current and next slide, a timer, and the notes. Every slide has notes: talking points, and on demo slides the clicks to make.
- **Keys**: <kbd>→</kbd> or <kbd>Space</kbd> next, <kbd>←</kbd> back, <kbd>f</kbd> fullscreen, <kbd>o</kbd> overview, <kbd>g</kbd> go to a slide.
- **Recording**: the decks are 16:9. Fullscreen the slides window on a 1920×1080 display, and record it and your screen share as two scenes (OBS or similar).
- **Offline**: fonts and images are bundled, so nothing is fetched while you record.

### YouTube chapters

The chapter slides line up with these chapters; add the timestamps after recording.

| Part 1: AWS | Part 2: Google Cloud |
|---|---|
| Intro | Intro |
| How it works | How it works |
| 1. Before you start | 1. Enable the FOCUS export |
| 2. An AWS profile | 2. Create the bucket |
| 3. Create the exports | 3. Deploy the exporter |
| 4. Connect and sync | 4. Grant read access |
| 5. Dimensions | 5. Connect and sync |
| Gotchas and recap | Troubleshooting and recap |

## Edit

Both decks share the theme in this folder. `theme: none` means Slidev adds no styles of its own: everything comes from [`styles/brand.css`](styles/brand.css), whose tokens are the website's (`docs/index.html`).

The goblin art and app screenshots are read in place from `docs/` and `packages/desktop/src/renderer/public/` (the `@site` and `@app` aliases in [`vite.config.ts`](vite.config.ts)), so they never drift from the website and the app.

### Layouts

| Layout | For | Frontmatter |
|---|---|---|
| `cover` | The title slide | `badge`, `provider` (`aws` or `gcp`), `pipeline` |
| `chapter` | Opening a chapter | `step`, `of`, `kicker` (replaces "Step N of M"), `goblin` |
| `demo` | The cue before a live demo | `screen` (the window), `where` (`A > B > C`) |
| `default` | Content | `kicker`, the small label above the title |
| `end` | The outro | `goblin` |

### Components

| Component | Renders |
|---|---|
| `<Ui>Create export</Ui>` | A label exactly as it reads on screen |
| `<Crumbs to="Billing > Data Exports" />` | A console path |
| `<Callout type="warn" title="…">` | A callout: `warn` (gold), `tip`, `danger` or `info` |
| `<Flow>`, `<Zone label>`, `<FlowNode title sub icon accent />` | A left-to-right data flow |
| `<Goblin name="trap" size="210px" />` | One of the app's goblins: `detective`, `throne`, `dive`, `jeweler`, `polish`, `abacus`, `trap`, `vault`, `alchemist`, `hauler`, or the main `goblin` |
| `<Screenshot name="cost-overview" />` | A website screenshot (`docs/screenshots/<name>.png`) in a window frame |
| `<ProviderMark provider="aws" />` | The AWS or Google Cloud mark |

Classes for Markdown: `cg-card` (and `cg-card--accent`), `cg-checklist` around a list, `cg-muted`, `cg-small`, and `cg-icon` on an icon. Icons are [Lucide](https://lucide.dev), the app's icon set, as `i-lucide-<name>`. `*word*` in a title turns it emerald.

### Keep them accurate

The decks quote the setup wizard's labels and the setup guides word for word. When either changes, update the slides with it:

- the wizard: `packages/ui/src/views/setup-wizard.tsx`, and `packages/ui/src/views/dimensions.tsx` for the Dimensions demo
- the AWS guide: the root `README.md` and the stack, `scripts/aws-exports/costgoblin-exports.yaml`
- the GCP guide: `scripts/gcp-focus-exporter/README.md` and its `deploy.sh`

## Build or export

`npm run build` writes both decks as static sites to `dist/aws` and `dist/gcp`. CSS minification is off in `vite.config.ts`: Slidev 53.0.0's own stylesheet fails the minifier, even in an empty deck.

To export a PDF, a PPTX or PNGs (for a video editor, say), open `http://localhost:3030/export` while the deck runs: Slidev's browser exporter needs nothing else installed.

## Dependencies

This folder has its own lockfile, and an `.npmrc` that repeats the root's supply-chain guards (see "Dependency supply chain" in `CLAUDE.md`). It has no Dependabot entry, since nothing in CI builds the decks. To upgrade Slidev, bump it, run both decks, and click through every slide.
