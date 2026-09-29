import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import * as browserEntry from '../browser.js';

// `@costgoblin/core/browser` is the renderer's only door into core. The
// bounded strip executor (normalize/strip-bounded.ts) needs node:vm, so it is
// exported from the Node entry alone — this guard walks every module the
// browser entry can load and fails if one of them reaches a Node-only
// isolation primitive, or if the executor leaks into the browser barrel.

const srcDir = join(import.meta.dirname, '..');
const browserEntryPath = join(srcDir, 'browser.ts');

const FORBIDDEN_SPECIFIERS = new Set(['node:vm', 'vm', 'node:worker_threads', 'worker_threads']);

/** Module specifiers of a file's runtime (non-type-only) static imports and
 *  re-exports. A clause-level `import type` / `export type` is erased and
 *  never loads its module, so it is skipped; per-specifier `type` imports are
 *  kept (under verbatimModuleSyntax the import statement survives). Dynamic
 *  `import('…')` specifiers are collected too, for the forbidden check only. */
function runtimeSpecifiers(filePath: string): { staticSpecifiers: string[]; dynamicSpecifiers: string[] } {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf-8'), ts.ScriptTarget.ES2022, true);
  const staticSpecifiers: string[] = [];
  const dynamicSpecifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) staticSpecifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) staticSpecifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteral(arg)) dynamicSpecifiers.push(arg.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { staticSpecifiers, dynamicSpecifiers };
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, join(base, 'index.ts')];
  const found = candidates.find(c => existsSync(c));
  if (found === undefined) throw new Error(`cannot resolve ${specifier} from ${fromFile}`);
  return found;
}

function walkBrowserGraph(): { files: Set<string>; bareSpecifiers: Set<string> } {
  const files = new Set<string>();
  const bareSpecifiers = new Set<string>();
  const queue = [browserEntryPath];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    const { staticSpecifiers, dynamicSpecifiers } = runtimeSpecifiers(file);
    for (const specifier of staticSpecifiers) {
      if (specifier.startsWith('.')) queue.push(resolveRelative(file, specifier));
      else bareSpecifiers.add(specifier);
    }
    for (const specifier of dynamicSpecifiers) {
      if (!specifier.startsWith('.')) bareSpecifiers.add(specifier);
    }
  }
  return { files, bareSpecifiers };
}

describe('browser entry', () => {
  const { files, bareSpecifiers } = walkBrowserGraph();

  it('walks a non-trivial module graph (the walker is not vacuous)', () => {
    expect(files.size).toBeGreaterThan(10);
    expect(files.has(join(srcDir, 'config', 'strip-pattern-limits.ts'))).toBe(true);
  });

  it('never reaches node:vm or worker_threads', () => {
    expect([...bareSpecifiers].filter(s => FORBIDDEN_SPECIFIERS.has(s))).toEqual([]);
  });

  it('never loads the bounded strip executor', () => {
    expect(files.has(join(srcDir, 'normalize', 'strip-bounded.ts'))).toBe(false);
  });

  it('exports neither stripNamesBounded nor the removed applyStripPatterns', () => {
    expect(Object.keys(browserEntry)).not.toContain('stripNamesBounded');
    expect(Object.keys(browserEntry)).not.toContain('applyStripPatterns');
  });

  it('exports the pattern caps the editor validates against', () => {
    expect(typeof browserEntry.nameStripPatternViolations).toBe('function');
    expect(browserEntry.MAX_NAME_STRIP_PATTERNS).toBe(16);
    expect(browserEntry.MAX_NAME_STRIP_PATTERN_LENGTH).toBe(256);
  });
});
