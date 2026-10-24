import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { NO_DRAG, cn } from '../../lib/utils.js';
import { CARD_ARROW_SIZE, CardArrowShape } from './card-arrow.js';

/** Radix positions the card inside a wrapper of the card's size, which the
 *  card's own pointer-events can't reach: make the wrapper click-through too,
 *  so the tooltip holds to it wherever it is rendered. */
function makeWrapperClickThrough(card: HTMLDivElement | null): void {
  if (card !== null && card.parentElement !== null) card.parentElement.style.pointerEvents = 'none';
}

function TooltipCard({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={makeWrapperClickThrough}
        side="bottom"
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          // pointer-events-none: a tooltip only describes, so it must never take
          // a click meant for whatever it covers, even while it fades out.
          // NO_DRAG: it can overlap the header's drag band (see PopoverContent).
          'pointer-events-none z-50 rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-text-primary shadow-md',
          NO_DRAG,
        )}
      >
        {children}
        <TooltipPrimitive.Arrow asChild {...CARD_ARROW_SIZE}>
          <CardArrowShape />
        </TooltipPrimitive.Arrow>
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn']);

/** Whether a keystroke is being handled right now: set by a key press and
 *  cleared once the press has done its work (its keyup, or the next task).
 *  Radix opens a tooltip on every focus. Focus that lands within a keystroke
 *  was moved by it (a Tab), so it opens one. Focus a closing menu, palette or
 *  modal hands back to its opener lands later, from a timer or an effect, so
 *  it pops no stray tooltip there, however the user closed it. A bare modifier
 *  (the Cmd of Cmd+Tab) is no keystroke. */
let keystrokeInProgress = false;
let keystrokeTimer = 0;
let keystrokeTracking = false;

function trackKeystrokes(): void {
  if (keystrokeTracking) return;
  keystrokeTracking = true;
  const end = (): void => { keystrokeInProgress = false; };
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || MODIFIER_KEYS.has(event.key)) return;
    keystrokeInProgress = true;
    window.clearTimeout(keystrokeTimer);
    keystrokeTimer = window.setTimeout(end, 0);
  }, true);
  document.addEventListener('keyup', end, true);
  document.addEventListener('pointerdown', end, true);
}

/** An open popover, menu or select. Radix positions them in the same popper
 *  wrapper as a tooltip, and marks them `data-state="open"`, which an open
 *  tooltip never is ("delayed-open" or "instant-open"). */
const OPEN_POPUP = '[data-radix-popper-content-wrapper] > [data-state="open"]';

/** A live status shown under a tooltip's line, toned by its dot. */
export interface TooltipStatus {
  readonly text: string;
  readonly tone: 'ok' | 'busy' | 'warning' | 'error';
}

const STATUS_DOT: Record<TooltipStatus['tone'], string> = {
  ok: 'bg-text-muted',
  busy: 'bg-accent animate-pulse motion-reduce:animate-none',
  warning: 'bg-warning',
  error: 'bg-negative',
};

interface ButtonTooltipProps {
  /** The feature's name, in bold. */
  readonly name: string;
  /** One short line on what it does. */
  readonly description: string;
  /** A live status line under the description, for an indicator button. */
  readonly status?: TooltipStatus | undefined;
  /** Holds the tooltip shut, e.g. while the button's own popover is open. */
  readonly suppressed?: boolean | undefined;
  /** The button. */
  readonly children: React.ReactElement;
}

/** What a trigger slotting onto the tooltip (`PopoverTrigger asChild` around
 *  it) passes down to the button: its handlers, ARIA and `data-state`. */
type ForwardedTriggerProps = Omit<React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>, 'asChild' | 'children' | 'name'>;

/** Instant, arrowed hover/focus tooltip naming an icon button and what it
 *  does, in place of a native `title` (late, unstyled, no arrow). Carries its
 *  own provider: at zero delay a shared one would add nothing.
 *
 *  A button that opens a popover nests it as `PopoverTrigger asChild` >
 *  `ButtonTooltip` > button: the popover's props reach the button through
 *  this one and win over the tooltip's, so the button keeps the popover's
 *  `data-state`. */
export const ButtonTooltip = React.forwardRef<HTMLButtonElement, ButtonTooltipProps & ForwardedTriggerProps>(
  ({ name, description, status, suppressed = false, children, onFocus, ...triggerProps }, ref) => {
    const [open, setOpen] = React.useState(false);
    // Suppression closes it outright rather than only hiding it: Radix's
    // zero-delay open can land between the hover and the click that opens the
    // button's popover, and a merely hidden tooltip would reappear when the
    // popover closes.
    const [wasSuppressed, setWasSuppressed] = React.useState(suppressed);
    if (suppressed !== wasSuppressed) {
      setWasSuppressed(suppressed);
      if (suppressed) setOpen(false);
    }
    React.useEffect(trackKeystrokes, []);
    return (
      <TooltipPrimitive.Provider delayDuration={0} disableHoverableContent>
        <TooltipPrimitive.Root
          open={open && !suppressed}
          onOpenChange={(next) => {
            // Never over an open popover or menu: the tooltip would cover it,
            // and as the newest Radix layer it would take the Escape meant to
            // close it.
            setOpen(next && !suppressed && document.querySelector(OPEN_POPUP) === null);
          }}
        >
          <TooltipPrimitive.Trigger
            asChild
            {...triggerProps}
            ref={ref}
            onFocus={(event) => {
              onFocus?.(event);
              // Focus opens it only when a keystroke moved it here; preventing
              // the event's default makes Radix skip its own open-on-focus.
              if (!keystrokeInProgress) event.preventDefault();
            }}
          >
            {children}
          </TooltipPrimitive.Trigger>
          <TooltipCard>
            <span className="flex max-w-[220px] flex-col gap-0.5">
              <span className="font-semibold text-text-primary">{name}</span>
              <span className="text-text-secondary">{description}</span>
              {status !== undefined && (
                // break-words: sync errors carry raw provider text, such as
                // URLs with no break opportunity.
                <span className="mt-1 flex items-start gap-1.5 border-t border-border pt-1.5 break-words" data-tone={status.tone}>
                  <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status.tone]}`} aria-hidden="true" />
                  <span className="min-w-0 text-text-primary">{status.text}</span>
                </span>
              )}
            </span>
          </TooltipCard>
        </TooltipPrimitive.Root>
      </TooltipPrimitive.Provider>
    );
  },
);

ButtonTooltip.displayName = 'ButtonTooltip';
