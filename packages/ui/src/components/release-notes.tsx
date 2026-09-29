import { createElement, useMemo } from 'react';
import type { ReactNode } from 'react';
import { parseReleaseNotes } from '../lib/release-notes.js';
import type { ReleaseNoteNode, ReleaseNoteTag } from '../lib/release-notes.js';

/** Tags that don't start a block of their own. When the whole tree holds no
 *  other element (plain text or markdown in a `releaseNotes` yml key), line
 *  breaks in the text are the only structure, so they're preserved. */
const INLINE_TAGS: ReadonlySet<ReleaseNoteTag> = new Set<ReleaseNoteTag>(['strong', 'b', 'em', 'i', 'code']);

function isBlock(node: ReleaseNoteNode): boolean {
  switch (node.kind) {
    case 'text':
    case 'link':
      return false;
    case 'void':
      return node.tag === 'hr';
    case 'element':
      return !INLINE_TAGS.has(node.tag);
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function renderNode(node: ReleaseNoteNode, key: number): ReactNode {
  switch (node.kind) {
    case 'text':
      return node.text;
    case 'void':
      return createElement(node.tag, { key });
    case 'element':
      return createElement(node.tag, { key }, ...renderChildren(node.children));
    case 'link':
      // target=_blank routes the click through the main process's window-open
      // handler (URL-validated, opened in the system browser) instead of
      // navigating the app window away.
      return (
        <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
          {renderChildren(node.children)}
        </a>
      );
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

/** Siblings keyed by position. The explicit arrow pins what `renderNode`
 *  receives: `.map(renderNode)` would also pass the array as a third argument,
 *  and silently change meaning if `renderNode` ever grew one. */
function renderChildren(nodes: readonly ReleaseNoteNode[]): ReactNode[] {
  return nodes.map((child, i) => renderNode(child, i));
}

/** Renders auto-updater release notes (GitHub HTML, or whatever a
 *  `latest*.yml` `releaseNotes` key carries) from an allow-listed tree —
 *  never as raw HTML, so no attribute, meta refresh, form or same-window
 *  link reaches the DOM. */
export function ReleaseNotes({ html }: Readonly<{ html: string }>): React.JSX.Element | null {
  const tree = useMemo(() => parseReleaseNotes(html), [html]);
  if (tree.length === 0) return null;
  const children = renderChildren(tree);
  if (!tree.some(isBlock)) return <div className="whitespace-pre-line">{children}</div>;
  return <>{children}</>;
}
