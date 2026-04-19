import { useEffect, useRef, useState } from 'react';
import { parse, stringify } from 'yaml';
import { validateViews, viewToYaml, ConfigValidationError } from '@costgoblin/core/browser';
import type { ViewSpec } from '@costgoblin/core/browser';

interface ExportProps {
  readonly mode: 'export';
  readonly view: ViewSpec;
  readonly onClose: () => void;
}

interface ImportProps {
  readonly mode: 'import';
  readonly existingIds: ReadonlySet<string>;
  readonly onImport: (view: ViewSpec) => void;
  readonly onClose: () => void;
}

type ViewYamlModalProps = ExportProps | ImportProps;

export function ViewYamlModal(props: ViewYamlModalProps): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState(() =>
    props.mode === 'export' ? stringify(viewToYaml(props.view)) : '',
  );
  const [copied, setCopied] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') props.onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); };
  }, [props]);

  async function handleCopy(): Promise<void> {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => { setCopied(false); }, 1500);
  }

  function handleImport(): void {
    if (props.mode !== 'import') return;
    setImportError(null);
    try {
      // Accept either a single view YAML or a { views: [...] } config. The
      // single-view form is what `export` produces, so the common case is a
      // paste-back round-trip.
      const parsed: unknown = parse(text);
      const wrapped = isViewLike(parsed) ? { views: [parsed] } : parsed;
      const cfg = validateViews(wrapped);
      const first = cfg.views[0];
      if (first === undefined) {
        setImportError('No view found in pasted text.');
        return;
      }
      if (props.existingIds.has(first.id)) {
        setImportError(`A view with id "${first.id}" already exists. Rename it in the YAML before importing.`);
        return;
      }
      props.onImport(first);
    } catch (err: unknown) {
      setImportError(err instanceof ConfigValidationError ? err.message : err instanceof Error ? err.message : String(err));
    }
  }

  const isExport = props.mode === 'export';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={props.onClose}
        aria-hidden="true"
      />

      <div className="relative rounded-xl border border-border bg-bg-secondary p-5 shadow-2xl max-w-2xl w-full mx-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">
            {isExport ? 'Export view' : 'Import view'}
          </h3>
          <span className="text-[11px] text-text-muted">
            {isExport ? 'Copy this YAML to share or back up the view.' : 'Paste a view YAML (from Export) to add it.'}
          </span>
        </div>

        <textarea
          value={text}
          readOnly={isExport}
          onChange={(e) => { setText(e.target.value); setImportError(null); }}
          spellCheck={false}
          className="font-mono text-[11px] leading-relaxed bg-bg-primary border border-border rounded-md px-3 py-2 text-text-primary h-72 resize-none"
        />

        {importError !== null && (
          <div className="rounded-md border border-negative/50 bg-negative-muted px-3 py-2 text-xs text-negative">
            {importError}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            ref={closeRef}
            type="button"
            onClick={props.onClose}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-bg-tertiary transition-colors"
          >
            Close
          </button>
          {isExport ? (
            <button
              type="button"
              onClick={() => { void handleCopy(); }}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-white bg-accent hover:bg-accent-hover transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleImport}
              disabled={text.trim() === ''}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-white bg-accent hover:bg-accent-hover transition-colors disabled:opacity-40"
            >
              Import
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function isViewLike(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  return 'id' in x && 'rows' in x && !('views' in x);
}
