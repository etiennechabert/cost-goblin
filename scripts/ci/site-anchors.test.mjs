// costgoblin.com (docs/index.html) stays linkable: every section, both setup
// guides and each of their steps, and each feature tab has an anchor, and an
// open guide or a picked feature tab is in the address bar, so what a reader
// sees can be shared by copying the URL. The desktop app's setup wizard and the
// README link into the page too, so the anchors they use are pinned here: a
// renamed id would break links already shipped in released builds.
//
// The structure checks read the committed page; the behaviour checks run its
// own script in jsdom, with stubs for what jsdom lacks (layout, observers, the
// clipboard, the network).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const SITE = 'https://costgoblin.com/';
const html = readFileSync(join(repoRoot, 'docs', 'index.html'), 'utf-8');

// ---------------------------------------------------------------- structure

const page = new JSDOM(html).window.document;
const ids = [...page.querySelectorAll('[id]')].map((el) => el.id);

/** Files git sees (tracked, or new and not ignored) that still exist on disk. */
function repoFiles() {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed, and this suite needs a git checkout: ${result.stderr || result.error}`);
  }
  return result.stdout.split('\0').filter((file) => file !== '' && existsSync(join(repoRoot, file)));
}

const thisFile = fileURLToPath(import.meta.url);

/** Every link to an anchor on costgoblin.com from the repo's code and docs (this file aside). */
function linksIntoSite() {
  const links = [];
  for (const file of repoFiles()) {
    if (!/\.(md|html|ts|tsx|mjs|js|ya?ml)$/.test(file) || join(repoRoot, file) === thisFile) continue;
    const text = readFileSync(join(repoRoot, file), 'utf-8');
    for (const match of text.matchAll(/costgoblin\.com\/?#([\w-]+)/g)) links.push({ file, anchor: match[1] });
  }
  return links;
}

describe('costgoblin.com anchors', () => {
  it('gives every id once', () => {
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('links only in-page anchors that exist', () => {
    const anchors = [...page.querySelectorAll('a[href^="#"]')]
      .map((a) => a.getAttribute('href').slice(1))
      // The download buttons start as a bare "#"; the script fills in the release URLs.
      .filter((anchor) => anchor !== '');
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) expect(ids, `#${anchor}`).toContain(anchor);
  });

  it('anchors every section below the hero, with a permalink in its header', () => {
    const sections = [...page.querySelectorAll('section:not(.hero)')];
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.id).not.toBe('');
      expect(section.querySelector(`a.anchor-link[href="#${section.id}"]`), section.id).not.toBeNull();
    }
  });

  it('anchors each setup guide, opened from its card, and each of its steps', () => {
    const guides = [...page.querySelectorAll('.provider-modal')];
    expect(guides.map((guide) => guide.id)).toEqual(['get-started-aws', 'get-started-gcp']);
    for (const guide of guides) {
      expect(page.querySelector(`a.integration-card[href="#${guide.id}"]`), guide.id).not.toBeNull();
      // Beside the title rather than in it, which would put "Copy link" in the dialog's name.
      expect(guide.querySelector(`.provider-modal-head > a.anchor-link[href="#${guide.id}"]`), guide.id).not.toBeNull();
      expect(guide.querySelector(`#${guide.getAttribute('aria-labelledby')} a`), guide.id).toBeNull();
      const steps = [...guide.querySelectorAll('.step')];
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.id.startsWith(`${guide.id}-`), `${guide.id} step "${step.id}"`).toBe(true);
        expect(step.querySelector(`.step-header a.anchor-link[href="#${step.id}"]`), step.id).not.toBeNull();
      }
    }
  });

  it('anchors each feature tab, with a permalink on its slide', () => {
    const tabs = [...page.querySelectorAll('.showcase-tab')];
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs) {
      expect(tab.id).toMatch(/^feature-/);
      const slide = page.querySelector(`.showcase-slide[data-slide="${tab.dataset.slide}"]`);
      expect(slide?.querySelector(`a.anchor-link[href="#${tab.id}"]`), tab.id).not.toBeNull();
    }
  });

  it('keeps every anchor the app and the docs link to', () => {
    const links = linksIntoSite();
    // The setup wizard's "GCP setup guide" link, in every release since v0.7.
    expect(links.map((link) => link.anchor)).toContain('get-started-gcp');
    for (const { file, anchor } of links) expect(ids, `${file} links #${anchor}`).toContain(anchor);
  });
});

// ---------------------------------------------------------------- behaviour

const loaded = [];

/** The committed page at `url`, with its script running. */
function loadPage(url = SITE) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  // jsdom reports the APIs it lacks (canvas, for the arch sniffing) as "not
  // implemented"; anything else is the page script failing.
  virtualConsole.on('jsdomError', (error) => {
    if (error.type !== 'not-implemented') errors.push(error);
  });
  const scrolledTo = [];
  const focused = [];
  const copied = [];
  const intervals = [];
  const observers = [];
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.Element.prototype.scrollIntoView = function scrollIntoView() {
        scrolledTo.push(this);
      };
      const focus = window.HTMLElement.prototype.focus;
      window.HTMLElement.prototype.focus = function recordFocus(options) {
        focused.push({ element: this, options });
        return focus.call(this, options);
      };
      window.IntersectionObserver = class {
        constructor(callback) {
          this.callback = callback;
          this.targets = [];
          observers.push(this);
        }
        observe(target) {
          this.targets.push(target);
        }
        unobserve() {}
        disconnect() {}
      };
      const setInterval = window.setInterval.bind(window);
      window.setInterval = (handler, ms, ...rest) => {
        intervals.push(ms);
        return setInterval(handler, ms, ...rest);
      };
      window.fetch = () => Promise.reject(new Error('no network in tests'));
      Object.defineProperty(window.navigator, 'clipboard', {
        value: {
          writeText(text) {
            copied.push(text);
            return Promise.resolve();
          },
        },
      });
    },
  });
  const { window } = dom;
  loaded.push({ window, errors });
  /** Reports `target` as scrolled into view to every observer watching it. */
  function reveal(target) {
    for (const observer of observers) {
      if (observer.targets.includes(target)) observer.callback([{ target, isIntersecting: true }]);
    }
  }
  return { window, document: window.document, scrolledTo, focused, copied, intervals, reveal };
}

/** Resolves on the window's next hashchange (history traversal is asynchronous). */
function nextHashChange(window) {
  return new Promise((resolve) => window.addEventListener('hashchange', resolve, { once: true }));
}

const isOpen = (guide) => guide.classList.contains('open');

afterEach(() => {
  const pages = loaded.splice(0);
  // Close every window before asserting, so a failure can't leave one running.
  for (const { window } of pages) window.close();
  expect(pages.flatMap(({ errors }) => errors.map((error) => error.message))).toEqual([]);
});

describe('costgoblin.com setup guides follow the URL', () => {
  it('writes the guide anchor when its card opens it, and steps back over it on close', async () => {
    const { window, document } = loadPage(`${SITE}#get-started`);
    const card = document.querySelector('a.integration-card[href="#get-started-aws"]');
    const guide = document.getElementById('get-started-aws');
    const historyLength = window.history.length;

    card.click();
    expect(isOpen(guide)).toBe(true);
    expect(window.location.hash).toBe('#get-started-aws');
    expect(window.history.length).toBe(historyLength + 1);

    const back = nextHashChange(window);
    guide.querySelector('.provider-modal-close').click();
    expect(isOpen(guide)).toBe(false);
    await back;
    expect(window.location.hash).toBe('#get-started');
    expect(document.activeElement).toBe(card);
  });

  it('opens a linked guide over the setup section, and leaves #get-started on close', () => {
    const { window, document, scrolledTo } = loadPage(`${SITE}#get-started-gcp`);
    const guide = document.getElementById('get-started-gcp');
    expect(isOpen(guide)).toBe(true);
    expect(isOpen(document.getElementById('get-started-aws'))).toBe(false);
    expect(scrolledTo).toContain(document.getElementById('get-started'));

    // Nothing to step back over: the guide came with the page.
    const historyLength = window.history.length;
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isOpen(guide)).toBe(false);
    expect(window.location.hash).toBe('#get-started');
    expect(window.history.length).toBe(historyLength);
    expect(document.activeElement).toBe(document.querySelector('a.integration-card[href="#get-started-gcp"]'));
  });

  it('opens the guide a step anchor belongs to, scrolled to that step', () => {
    const { document, scrolledTo } = loadPage(`${SITE}#get-started-gcp-read-access`);
    expect(isOpen(document.getElementById('get-started-gcp'))).toBe(true);
    expect(scrolledTo).toContain(document.getElementById('get-started-gcp-read-access'));
  });

  it('closes on Back and swaps guides when the anchor changes', async () => {
    const { window, document } = loadPage();
    const aws = document.getElementById('get-started-aws');
    const gcp = document.getElementById('get-started-gcp');

    document.querySelector('a.integration-card[href="#get-started-aws"]').click();
    let change = nextHashChange(window);
    window.history.back();
    await change;
    expect(isOpen(aws)).toBe(false);
    expect(window.location.hash).toBe('');

    change = nextHashChange(window);
    window.location.hash = '#get-started-aws';
    await change;
    expect(isOpen(aws)).toBe(true);
    change = nextHashChange(window);
    window.location.hash = '#get-started-gcp';
    await change;
    expect(isOpen(aws)).toBe(false);
    expect(isOpen(gcp)).toBe(true);

    // Reached by links, not by its card: closing rewrites the entry instead of going back.
    const historyLength = window.history.length;
    gcp.querySelector('.provider-modal-close').click();
    expect(window.location.hash).toBe('#get-started');
    expect(window.history.length).toBe(historyLength);
  });

  it('leaves a modified click on a card to the browser, which opens the guide from its anchor', async () => {
    const { window, document } = loadPage();
    const card = document.querySelector('a.integration-card[href="#get-started-aws"]');
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    const followed = nextHashChange(window);
    card.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    // jsdom has no tabs, so it follows the link in place rather than in a new one.
    await followed;
    expect(isOpen(document.getElementById('get-started-aws'))).toBe(true);
  });

  it('returns focus to the card without scrolling the page away from where the URL went', async () => {
    const { window, document, focused } = loadPage(`${SITE}#get-started-gcp`);
    const change = nextHashChange(window);
    window.location.hash = '#roadmap';
    await change;
    expect(isOpen(document.getElementById('get-started-gcp'))).toBe(false);
    const card = document.querySelector('a.integration-card[href="#get-started-gcp"]');
    expect(document.activeElement).toBe(card);
    // The browser has already scrolled to #roadmap; focusing must not pull the page back up to the card.
    expect(focused.findLast((call) => call.element === card)?.options).toEqual({ preventScroll: true });
  });

  it('leaves the URL alone when Escape has no guide to close', () => {
    const { window, document } = loadPage(`${SITE}#download`);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(window.location.hash).toBe('#download');
  });
});

describe('costgoblin.com feature tabs follow the URL', () => {
  it('shows the linked feature and keeps it there', () => {
    const { document, intervals, reveal } = loadPage(`${SITE}#feature-dimensions`);
    const tab = document.getElementById('feature-dimensions');
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector(`.showcase-slide[data-slide="${tab.dataset.slide}"]`).classList).toContain('is-active');

    // Scrolling the gallery into view would start the rotation, carrying the reader off the linked slide.
    reveal(document.querySelector('.showcase-gallery'));
    expect(intervals).not.toContain(6000);
  });

  it('rotates when no feature is linked', () => {
    const { document, intervals, reveal } = loadPage();
    reveal(document.querySelector('.showcase-gallery'));
    expect(intervals).toContain(6000);
  });

  it('puts the tab a reader picks in the URL, without a history entry', () => {
    const { window, document } = loadPage();
    const historyLength = window.history.length;
    document.getElementById('feature-trends').click();
    expect(window.location.hash).toBe('#feature-trends');
    expect(window.history.length).toBe(historyLength);

    document
      .getElementById('feature-trends')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(window.location.hash).toBe('#feature-tags');
  });
});

describe('costgoblin.com permalinks', () => {
  it('write their anchor without a history entry and copy the full URL', async () => {
    const { window, document, copied } = loadPage();
    const historyLength = window.history.length;
    const link = document.querySelector('#download a.anchor-link[href="#download"]');
    link.click();
    expect(window.location.hash).toBe('#download');
    expect(window.history.length).toBe(historyLength);
    await Promise.resolve();
    expect(copied).toEqual([`${SITE}#download`]);
    expect(link.classList).toContain('is-copied');
  });

  it('keep an open guide closable back to where the reader was', async () => {
    const { window, document, copied } = loadPage(`${SITE}#get-started`);
    document.querySelector('a.integration-card[href="#get-started-aws"]').click();
    document.querySelector('a.anchor-link[href="#get-started-aws-cloudformation"]').click();
    expect(window.location.hash).toBe('#get-started-aws-cloudformation');
    await Promise.resolve();
    expect(copied).toEqual([`${SITE}#get-started-aws-cloudformation`]);

    const back = nextHashChange(window);
    document.querySelector('#get-started-aws .provider-modal-close').click();
    await back;
    expect(window.location.hash).toBe('#get-started');
  });
});
