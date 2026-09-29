/**
 * Parse auto-updater release notes into an allow-listed tree.
 *
 * The notes are GitHub's rendered release body — or, when a `latest*.yml`
 * carries a `releaseNotes` key, arbitrary HTML, markdown or text. Rendering
 * them as raw HTML lets a `<meta http-equiv="refresh">`, a `<form>` or a plain
 * same-window link navigate the app window away (the CSP blocks script, not
 * navigation). Instead, the markup is parsed into an inert document and only
 * an allow-listed set of tags survives, with NO attributes: links keep just an
 * `https:` href, and the renderer opens them in a new window (i.e. the system
 * browser).
 */

export type ReleaseNoteTag =
  | 'p' | 'h2' | 'h3' | 'h4' | 'ul' | 'ol' | 'li' | 'strong' | 'b' | 'em' | 'i' | 'code' | 'pre'
  | 'blockquote' | 'table' | 'thead' | 'tbody' | 'tfoot' | 'tr' | 'th' | 'td';

export type ReleaseNoteNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'void'; readonly tag: 'br' | 'hr' }
  | { readonly kind: 'element'; readonly tag: ReleaseNoteTag; readonly children: readonly ReleaseNoteNode[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly ReleaseNoteNode[] };

/** Input past this is ignored — notes are a few KB; this bounds parse cost. */
export const MAX_RELEASE_NOTES_LENGTH = 256 * 1024;

/** Element nesting past this is flattened to text. Bounds the recursion of
 *  the walk and of React's render. */
export const MAX_RELEASE_NOTES_DEPTH = 32;

const RELEASE_NOTE_TAGS: ReadonlySet<string> = new Set<ReleaseNoteTag>([
  'p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'code', 'pre',
  'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
]);

function isReleaseNoteTag(tag: string): tag is ReleaseNoteTag {
  return RELEASE_NOTE_TAGS.has(tag);
}

/** Subtrees dropped whole, content included: executable or non-HTML content,
 *  and table parts whose content would otherwise land directly under
 *  `<table>` once unwrapped. */
const DROPPED_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math',
  'title', 'head', 'caption', 'colgroup',
]);

const RENAMED_TAGS: ReadonlyMap<string, ReleaseNoteTag> = new Map<string, ReleaseNoteTag>([
  ['h1', 'h2'],
  ['h5', 'h4'],
  ['h6', 'h4'],
  ['tt', 'code'],
]);

/** Parents under which React rejects text nodes (validateDOMNesting). */
const TABLE_STRUCTURE_TAGS: ReadonlySet<ReleaseNoteTag> = new Set<ReleaseNoteTag>([
  'table', 'thead', 'tbody', 'tfoot', 'tr',
]);

/** HTML whitespace (not `\s`, which also matches U+00A0 and friends). */
const HTML_WHITESPACE_ONLY = /^[ \t\n\f\r]*$/;

function httpsHref(raw: string | null): string | null {
  if (raw === null) return null;
  let url: URL;
  try {
    // No base: relative, protocol-relative and fragment-only hrefs throw.
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? url.href : null;
}

/** Concatenated text of a subtree, skipping dropped tags. Iterative (explicit
 *  stack) because this is what runs past the depth cap. */
function flattenText(root: Element): string {
  let text = '';
  const stack: ChildNode[] = [...root.childNodes].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node instanceof Text) {
      text += node.data;
    } else if (node instanceof Element && !DROPPED_TAGS.has(node.tagName.toLowerCase())) {
      for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
        const child = node.childNodes[i];
        if (child !== undefined) stack.push(child);
      }
    }
  }
  return text;
}

/** Walk `nodes`, appending the allow-listed tree to `out`. `parentTag` is the
 *  nearest KEPT ancestor (unwrapped elements are transparent). */
function walk(
  nodes: NodeListOf<ChildNode>,
  parentTag: ReleaseNoteTag | null,
  depth: number,
  out: ReleaseNoteNode[],
): void {
  const underTableStructure = parentTag !== null && TABLE_STRUCTURE_TAGS.has(parentTag);
  for (const node of nodes) {
    if (node instanceof Text) {
      const text = node.data;
      if (text.length === 0) continue;
      if (underTableStructure && HTML_WHITESPACE_ONLY.test(text)) continue;
      out.push({ kind: 'text', text });
      continue;
    }
    // Comments, processing instructions, doctypes: skipped.
    if (!(node instanceof Element)) continue;

    const rawTag = node.tagName.toLowerCase();
    if (DROPPED_TAGS.has(rawTag)) continue;

    if (depth >= MAX_RELEASE_NOTES_DEPTH) {
      const text = flattenText(node);
      // Text directly under a table part is a React nesting error; at this
      // depth the input is adversarial anyway, so it is dropped.
      if (text.length > 0 && !underTableStructure) out.push({ kind: 'text', text });
      continue;
    }

    if (rawTag === 'br' || rawTag === 'hr') {
      out.push({ kind: 'void', tag: rawTag });
      continue;
    }

    if (rawTag === 'a') {
      const href = httpsHref(node.getAttribute('href'));
      if (href !== null) {
        const children: ReleaseNoteNode[] = [];
        walk(node.childNodes, null, depth + 1, children);
        out.push({ kind: 'link', href, children });
        continue;
      }
      // Not https (or no href): fall through and unwrap, keeping the text.
    }

    const tag = RENAMED_TAGS.get(rawTag) ?? rawTag;
    if (isReleaseNoteTag(tag)) {
      const children: ReleaseNoteNode[] = [];
      walk(node.childNodes, tag, depth + 1, children);
      out.push({ kind: 'element', tag, children });
    } else {
      // Unknown tag (div, span, g-emoji, img, meta, base, form, button, …):
      // unwrap — keep the children, drop the element and every attribute.
      walk(node.childNodes, parentTag, depth + 1, out);
    }
  }
}

export function parseReleaseNotes(html: string): readonly ReleaseNoteNode[] {
  const input = html.slice(0, MAX_RELEASE_NOTES_LENGTH);
  if (input.length === 0) return [];
  // DOMParser documents are inert: no script runs, no resource loads. Never
  // assign innerHTML on an element of the live document instead — even a
  // detached one fetches <img> and fires its handlers.
  const doc = new DOMParser().parseFromString(input, 'text/html');
  const out: ReleaseNoteNode[] = [];
  walk(doc.body.childNodes, null, 0, out);
  return out;
}
