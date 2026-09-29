import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseNotes } from '../components/release-notes.js';
import { parseReleaseNotes } from '../lib/release-notes.js';

// jsdom proves the structure of what reaches the DOM, not that it is inert —
// the inertness argument is that nothing outside the allow-list (no attribute
// but href/target/rel, no meta/form/base/iframe) is ever created.

afterEach(() => {
  vi.restoreAllMocks();
});

function renderNotes(html: string): HTMLElement {
  return render(<ReleaseNotes html={html} />).container;
}

const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'target', 'rel']);

function strip(text: string | null): string {
  return (text ?? '').replace(/\s+/g, '');
}

describe('ReleaseNotes — dangerous markup', () => {
  const PAYLOADS: readonly string[] = [
    '<meta http-equiv="refresh" content="0;url=https://e.invalid/">',
    '<form action="https://e.invalid/"><button>go</button></form>',
    '<base href="https://e.invalid/">',
    '<iframe src="https://e.invalid/"></iframe>',
    '<object data="https://e.invalid/"></object>',
    '<embed src="https://e.invalid/">',
    '<img src="x" onerror="alert(1)">',
    '<svg><a href="https://e.invalid/"><text>svg link</text></a></svg>',
    '<script>alert(1)</script>',
    '<style>*{}</style>',
  ];

  it.each(PAYLOADS)('renders none of the dangerous elements for %s', (payload) => {
    const container = renderNotes(`<p>before</p>${payload}<p>after</p>`);
    expect(container.querySelector('meta, form, button, base, iframe, object, embed, img, svg, script, style, a')).toBeNull();
    expect(container.textContent).not.toContain('alert(1)');
    expect(container.textContent).not.toContain('*{}');
    expect(container.textContent).toContain('before');
    expect(container.textContent).toContain('after');
  });

  it('copies no attribute other than href, target and rel', () => {
    const attrs = 'class="c" style="color:red" id="i" data-hovercard-type="user" onclick="x()" onmouseover="y()"';
    const container = renderNotes(
      `<p ${attrs}>text <a ${attrs} href="https://github.com/o/r">link</a> <code ${attrs}>c</code></p>`,
    );
    const elements = container.querySelectorAll('*');
    expect(elements.length).toBeGreaterThanOrEqual(3);
    for (const el of elements) {
      for (const name of el.getAttributeNames()) {
        expect(ALLOWED_ATTRIBUTES.has(name)).toBe(true);
      }
    }
  });

  const REJECTED_HREFS: readonly string[] = [
    'javascript:x()',
    'data:text/html,x',
    'file:///etc/hosts',
    'http://e.invalid/',
    '//e.invalid/',
    '/relative',
    '#frag',
    'https://',
  ];

  it.each(REJECTED_HREFS)('unwraps a link to %s, keeping its text', (href) => {
    const container = renderNotes(`<p><a href="${href}">link text</a></p>`);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('link text');
  });

  it('unwraps a link with no href, keeping its text', () => {
    const container = renderNotes('<p><a name="x">link text</a></p>');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('link text');
  });

  it('keeps an https link, opening it outside the app window', () => {
    const container = renderNotes('<p><a href="https://github.com/o/r/pull/1">#1</a></p>');
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://github.com/o/r/pull/1');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.textContent).toBe('#1');
  });
});

describe('parseReleaseNotes', () => {
  it('remaps headings and tt, and emits br/hr as void nodes', () => {
    expect(parseReleaseNotes('<h1>a</h1><h5>b</h5><h6>c</h6><tt>d</tt><br><hr>')).toEqual([
      { kind: 'element', tag: 'h2', children: [{ kind: 'text', text: 'a' }] },
      { kind: 'element', tag: 'h4', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'element', tag: 'h4', children: [{ kind: 'text', text: 'c' }] },
      { kind: 'element', tag: 'code', children: [{ kind: 'text', text: 'd' }] },
      { kind: 'void', tag: 'br' },
      { kind: 'void', tag: 'hr' },
    ]);
  });

  it('unwraps unknown tags and normalises kept hrefs', () => {
    expect(parseReleaseNotes('<div><span>x</span><a href="HTTPS://Example.com">y</a></div>')).toEqual([
      { kind: 'text', text: 'x' },
      { kind: 'link', href: 'https://example.com/', children: [{ kind: 'text', text: 'y' }] },
    ]);
  });

  it('returns an empty tree for empty input', () => {
    expect(parseReleaseNotes('')).toEqual([]);
  });
});

describe('ReleaseNotes — rendering', () => {
  it('renders mapped tags as their allow-listed elements', () => {
    const container = renderNotes('<h1>a</h1><h5>b</h5><tt>d</tt><br><hr>');
    expect(container.querySelector('h1, h5, tt')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('a');
    expect(container.querySelector('h4')?.textContent).toBe('b');
    expect(container.querySelector('code')?.textContent).toBe('d');
    expect(container.querySelector('br')).not.toBeNull();
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('keeps the structure, text and links of genuine GitHub release notes', () => {
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'release-notes-github.html'),
      'utf8',
    );
    const container = renderNotes(html);

    const tags = new Set([...container.querySelectorAll('*')].map((el) => el.tagName.toLowerCase()));
    expect([...tags].sort()).toEqual(
      ['a', 'blockquote', 'code', 'em', 'h2', 'h3', 'li', 'p', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'].sort(),
    );

    const source = new DOMParser().parseFromString(html, 'text/html');
    expect(strip(container.textContent)).toBe(strip(source.body.textContent));

    const links = container.querySelectorAll('a');
    expect(links.length).toBe(source.body.querySelectorAll('a').length);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('href')).toMatch(/^https:\/\/github\.com\//);
    }
  });

  it('renders an indented table without a React nesting error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = renderNotes(
      '<table>\n  <thead>\n    <tr>\n      <th>h</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td>x</td>\n    </tr>\n  </tbody>\n</table>',
    );
    expect(container.querySelector('table tbody tr td')?.textContent).toBe('x');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps tfoot and drops caption without a React nesting error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = renderNotes('<table><tfoot><tr><td>f</td></tr></tfoot><caption><p>c</p></caption></table>');
    expect(container.querySelector('caption')).toBeNull();
    expect(container.querySelector('table tfoot tr td')?.textContent).toBe('f');
    expect(container.textContent).toBe('f');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps line breaks in plain-text or markdown notes', () => {
    const container = renderNotes('## Heading\n\n- one\n- two');
    const wrapper = container.querySelector('div.whitespace-pre-line');
    expect(wrapper?.textContent).toBe('## Heading\n\n- one\n- two');
  });

  it('renders nothing for empty notes', () => {
    const container = renderNotes('');
    expect(container.childNodes.length).toBe(0);
  });

  it('caps nesting depth without throwing', () => {
    const depth = 2000;
    const html = `${'<blockquote>'.repeat(depth)}deep${'</blockquote>'.repeat(depth)}`;
    const container = renderNotes(html);
    expect(container.textContent).toContain('deep');
    let deepest = 0;
    for (const el of container.querySelectorAll('blockquote')) {
      let level = 0;
      for (let node: Element | null = el; node !== null && node !== container; node = node.parentElement) level += 1;
      deepest = Math.max(deepest, level);
    }
    expect(deepest).toBeGreaterThan(0);
    expect(deepest).toBeLessThanOrEqual(32);
  });

  it('caps the input size', () => {
    const container = renderNotes(`<p>${'x'.repeat(400 * 1024)}</p>`);
    expect(container.textContent.length).toBeLessThanOrEqual(256 * 1024);
    expect(container.textContent.length).toBeGreaterThan(0);
  });
});
