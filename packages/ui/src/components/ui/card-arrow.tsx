import { cn } from '../../lib/utils.js';

/** Width and height of the arrow a card (popover, tooltip) points at its
 *  trigger with — pass to the Radix `Arrow`, whose viewBox this shape fills. */
export const CARD_ARROW_SIZE: { readonly width: number; readonly height: number } = { width: 12, height: 6 };

/** The arrow's shape, for `<Primitive.Arrow asChild>`: the card's fill with
 *  its border on the two outer edges. Shifted one pixel into the card so the
 *  fill covers the card's own border across the arrow's base. Spreads what
 *  the Arrow's Slot passes (size, style, ref) onto the svg, which without its
 *  size draws nothing. */
export function CardArrowShape({ className, ...props }: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg
      {...props}
      viewBox="0 0 12 6"
      className={cn('block -translate-y-px overflow-visible', className)}
      aria-hidden="true"
      data-card-arrow=""
    >
      <path d="M0 0 L6 6 L12 0" className="fill-bg-secondary stroke-border" />
    </svg>
  );
}
