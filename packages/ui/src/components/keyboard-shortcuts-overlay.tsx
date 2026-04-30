import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog.js';
import { formatShortcut } from '../lib/keyboard-utils.js';

interface ShortcutItem {
  keys: string[];
  description: string;
}

interface ShortcutCategory {
  category: string;
  items: ShortcutItem[];
}

interface KeyboardShortcutsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shortcuts: ShortcutCategory[];
}

export function KeyboardShortcutsOverlay({
  open,
  onOpenChange,
  shortcuts,
}: Readonly<KeyboardShortcutsOverlayProps>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            Use these shortcuts to navigate CostGoblin faster
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 mt-4">
          {shortcuts.map((section) => (
            <div key={section.category}>
              <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
                {section.category}
              </h4>
              <div className="space-y-2">
                {section.items.map((item, index) => (
                  <div
                    key={`${section.category}-${index.toString()}`}
                    className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-bg-tertiary transition-colors"
                  >
                    <span className="text-sm text-text-primary">
                      {item.description}
                    </span>
                    <div className="flex items-center gap-1">
                      {item.keys.map((key, keyIndex) => (
                        <kbd
                          key={`${section.category}-${index.toString()}-${keyIndex.toString()}`}
                          className="inline-flex items-center justify-center min-w-[1.75rem] h-6 px-2 text-xs font-mono font-medium text-text-primary bg-bg-primary border border-border rounded shadow-sm"
                        >
                          {formatShortcut([key])}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 pt-4 border-t border-border">
          <p className="text-xs text-text-tertiary text-center">
            Press <kbd className="inline-flex items-center justify-center min-w-[1.75rem] h-5 px-1.5 text-xs font-mono font-medium text-text-primary bg-bg-primary border border-border rounded">Esc</kbd> to close
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
