import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ModalLayer } from '../../hooks/modal-layers.js';
import { returnFocusToOpener } from '../../lib/return-focus.js';
import { NO_DRAG, cn } from '../../lib/utils.js';

export const Dialog = DialogPrimitive.Root;

export const DialogTrigger = DialogPrimitive.Trigger;

export const DialogPortal = DialogPrimitive.Portal;

/** Closes the dialog. Renders its child as the close control (`asChild`
 *  defaults to true): every caller passes its own button, and Radix's default
 *  `<button>` around it would nest two buttons — two tab stops, with the
 *  dialog's auto-focus landing on the unstyled outer one. */
export const DialogClose = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ asChild = true, ...props }, ref) => (
  <DialogPrimitive.Close ref={ref} asChild={asChild} {...props} />
));

DialogClose.displayName = DialogPrimitive.Close.displayName;

export const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm',
      // The overlay covers the app header, a window drag region: without the
      // opt-out, clicks in the top band would drag the window instead.
      NO_DRAG,
      'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));

DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/** Records what had focus when the dialog opened. Rendered inside Content, so
 *  it mounts with each opening, and reads focus during that first render:
 *  by the time an effect runs, an autofocused child has already taken it. */
function RememberOpener({ into }: Readonly<{ into: React.RefObject<Element | null> }>): null {
  const [opener] = React.useState(() => document.activeElement);
  React.useEffect(() => { into.current = opener; }, [into, opener]);
  return null;
}

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onCloseAutoFocus, ...props }, ref) => {
  const openerRef = React.useRef<Element | null>(null);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed left-[50%] top-[50%] z-50 flex max-h-[90vh] w-full max-w-md translate-x-[-50%] translate-y-[-50%] flex-col overflow-y-auto rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl duration-200',
          // A tall dialog reaches up into the header's drag band.
          NO_DRAG,
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
          className,
        )}
        // Radix gives focus back only to a Trigger, and the app's dialogs are
        // controlled without one: focus would drop to <body>. Return it to
        // whatever had it when the dialog opened (see returnFocusToOpener).
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (!event.defaultPrevented && returnFocusToOpener(openerRef.current)) event.preventDefault();
        }}
        {...props}
      >
        {/* Inside Content so they follow the dialog's presence: this wrapper
            renders even while the dialog is closed. */}
        <ModalLayer kind="dialog" />
        <RememberOpener into={openerRef} />
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

DialogContent.displayName = DialogPrimitive.Content.displayName;

export function DialogTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-sm font-semibold text-text-primary', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-sm text-text-secondary', className)}
      {...props}
    />
  );
}
