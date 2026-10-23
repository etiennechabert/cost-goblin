import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { NO_DRAG, cn } from '../../lib/utils.js';
import { CARD_ARROW_SIZE, CardArrowShape } from './card-arrow.js';

export const TooltipProvider = TooltipPrimitive.Provider;

export const Tooltip = TooltipPrimitive.Root;

export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, side = 'bottom', sideOffset = 6, collisionPadding = 8, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      side={side}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        // pointer-events-none: a tooltip only describes, so it must never take
        // a click meant for whatever it covers, even while it fades out.
        // NO_DRAG: it can overlap the header's drag band (see PopoverContent).
        'pointer-events-none z-50 rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-text-primary shadow-md',
        NO_DRAG,
        className,
      )}
      {...props}
    >
      {children}
      <TooltipPrimitive.Arrow asChild {...CARD_ARROW_SIZE}>
        <CardArrowShape />
      </TooltipPrimitive.Arrow>
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));

TooltipContent.displayName = TooltipPrimitive.Content.displayName;

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn']);

/** Whether the last input was a keystroke, as Chromium's `:focus-visible`
 *  judges it: a bare modifier (the Cmd of Cmd+Tab) doesn't count. Radix opens
 *  a tooltip on every focus, so without this, focus a closing menu or modal
 *  hands back to its opener after a mouse click pops a stray tooltip there. */
let lastInputWasKey = false;
let inputTracking = false;

function trackInputModality(): void {
  if (inputTracking) return;
  inputTracking = true;
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || MODIFIER_KEYS.has(event.key)) return;
    lastInputWasKey = true;
  }, true);
  document.addEventListener('pointerdown', () => { lastInputWasKey = false; }, true);
}

interface ButtonTooltipProps {
  /** The feature's name, in bold. */
  readonly name: string;
  /** One short line on what it does. */
  readonly description: string;
  /** Holds the tooltip shut, e.g. while the button's own popover is open. */
  readonly suppressed?: boolean | undefined;
  /** The button — or a `PopoverTrigger asChild` around it. */
  readonly children: React.ReactElement;
}

/** Instant, arrowed hover/focus tooltip naming an icon button and what it
 *  does, in place of a native `title` (late, unstyled, no arrow). Carries its
 *  own provider: at zero delay a shared one would add nothing. */
export function ButtonTooltip({ name, description, suppressed = false, children }: ButtonTooltipProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  React.useEffect(trackInputModality, []);
  return (
    <TooltipPrimitive.Provider delayDuration={0} disableHoverableContent>
      <Tooltip
        open={open && !suppressed}
        onOpenChange={(next) => { setOpen(next && !suppressed); }}
      >
        {/* Focus opens it for keyboard users only; preventing the event's
            default makes Radix skip its own open-on-focus. */}
        <TooltipTrigger asChild onFocus={(event) => { if (!lastInputWasKey) event.preventDefault(); }}>{children}</TooltipTrigger>
        <TooltipContent>
          <span className="flex max-w-[220px] flex-col gap-0.5">
            <span className="font-semibold text-text-primary">{name}</span>
            <span className="text-text-secondary">{description}</span>
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipPrimitive.Provider>
  );
}
