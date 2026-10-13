import * as React from 'react';
import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ModalLayer } from '../../hooks/modal-layers.js';
import { returnFocusToOpener } from '../../lib/return-focus.js';
import { NO_DRAG, cn } from '../../lib/utils.js';

export type ModalShellSize = 'sm' | 'md' | '2xl' | 'auto';

const CARD = 'rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl';

/** Card width per size; `auto` is bare — the child brings its own card (the
 *  setup wizard). */
const SIZE_CLASSES: Record<ModalShellSize, string> = {
  sm: `${CARD} w-full max-w-sm`,
  md: `${CARD} w-full max-w-md`,
  '2xl': `${CARD} w-full max-w-2xl`,
  auto: '',
};

export interface ModalShellProps {
  /** Called on Escape and on a backdrop click. The shell is open while
   *  mounted: callers close it by unmounting it. */
  readonly onClose: () => void;
  /** When false, Escape and backdrop clicks do nothing — the dialog is locked
   *  open (e.g. while an import pull runs). Defaults to true. */
  readonly dismissable?: boolean;
  /** Focused on open in place of the dialog itself (e.g. a confirm's Cancel). */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  /** Accessible name for a shell without a ModalShellTitle. */
  readonly ariaLabel?: string;
  readonly size?: ModalShellSize;
  /** Test id for the backdrop (the overlay the dialog sits in). Defaults to
   *  `modal-backdrop`. */
  readonly backdropTestId?: string;
  /** Extra classes for the dialog card. */
  readonly className?: string;
  readonly children: React.ReactNode;
}

/** The app's modal dialog chrome, on Radix Dialog so every modal shares one
 *  layer stack: whichever opened last is the one that gets pointer, focus and
 *  Escape, and it paints on top (one z-index, body portal, DOM order).
 *
 *  - Named by a ModalShellTitle (or `ariaLabel`) and described by a
 *    ModalShellDescription; `aria-modal` is set explicitly — Radix leaves it
 *    off.
 *  - Focus moves in on open — to `initialFocusRef`, else the dialog itself
 *    (without scrolling: a tall dialog opens at its top), so it is announced
 *    by name — unless a child already took it (an autoFocus
 *    input). It stays inside while open and returns to the opener on close:
 *    Radix only restores focus to a `Trigger`, which these modals do not use.
 *  - Escape closes only the topmost layer, and not while an IME composition
 *    is being cancelled.
 *  - The overlay is the scroll container, with the dialog nested inside it
 *    (Radix's scrollable-overlay pattern): a dialog taller than the window
 *    scrolls instead of being cut off at both edges. Nothing on the way up
 *    from the dialog has a transform or filter, which would make it the
 *    containing block of fixed descendants — only opacity animates.
 *  - The overlay opts out of the window drag region it covers. */
export function ModalShell({
  onClose,
  dismissable = true,
  initialFocusRef,
  ariaLabel,
  size = 'md',
  backdropTestId = 'modal-backdrop',
  className,
  children,
}: Readonly<ModalShellProps>): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  // Captured during the first render: by the time an effect runs, a child
  // that autofocuses an input has already moved focus off the opener.
  const [opener] = useState(() => document.activeElement);

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-testid={backdropTestId}
          className={cn('fixed inset-0 z-50 flex overflow-y-auto bg-black/60 p-4 motion-safe:animate-modal-in', NO_DRAG)}
        >
          <DialogPrimitive.Content
            ref={contentRef}
            aria-modal="true"
            aria-label={ariaLabel}
            className={cn('relative m-auto outline-none', SIZE_CLASSES[size], className)}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              const initial = initialFocusRef?.current;
              if (initial !== null && initial !== undefined) {
                initial.focus();
                return;
              }
              // Without preventScroll, focusing a dialog taller than the
              // window scrolls the overlay to the dialog's top edge, past the
              // overlay's padding: whatever pokes out above the card (the
              // setup wizard's ✕) opens cut off.
              contentRef.current?.focus({ preventScroll: true });
            }}
            onCloseAutoFocus={(event) => {
              if (returnFocusToOpener(opener)) event.preventDefault();
            }}
            onEscapeKeyDown={(event) => {
              if (!dismissable || event.isComposing) event.preventDefault();
            }}
            onPointerDownOutside={(event) => { if (!dismissable) event.preventDefault(); }}
            onInteractOutside={(event) => { if (!dismissable) event.preventDefault(); }}
          >
            <ModalLayer kind="modal-shell" />
            {children}
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Names the enclosing ModalShell. Wraps the caller's own heading, which
 *  keeps its tag and styling. */
export function ModalShellTitle({ children }: Readonly<{ children: React.ReactElement }>): React.JSX.Element {
  return <DialogPrimitive.Title asChild>{children}</DialogPrimitive.Title>;
}

/** Describes the enclosing ModalShell. Wraps the caller's own element. */
export function ModalShellDescription({ children }: Readonly<{ children: React.ReactElement }>): React.JSX.Element {
  return <DialogPrimitive.Description asChild>{children}</DialogPrimitive.Description>;
}
