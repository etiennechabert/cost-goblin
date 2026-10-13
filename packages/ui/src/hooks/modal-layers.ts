import { useEffect, useMemo, useSyncExternalStore } from 'react';

/** What kind of surface a layer is — diagnostics and tests only; every kind
 *  counts the same. */
export type ModalLayerKind = 'dialog' | 'palette' | 'modal-shell';

/** Identity of one registered layer, so it can ask whether a layer OTHER than
 *  itself is open. */
export interface ModalLayerHandle {
  readonly kind: ModalLayerKind;
}

/** The modal layers open right now, in open order.
 *
 *  Module-level rather than in a context: every consumer (the update
 *  auto-open, the palette's Cmd+K gate) must see layers opened anywhere in the
 *  app — Radix dialogs, the palette, ModalShell — and a store that needs no
 *  provider keeps every existing test rendering without a wrapper. */
const openLayers = new Set<ModalLayerHandle>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Adds a layer to the stack; returns its removal. Idempotent both ways, so
 *  StrictMode's mount → unmount → mount counts a layer once. */
function registerModalLayer(handle: ModalLayerHandle): () => void {
  if (!openLayers.has(handle)) {
    openLayers.add(handle);
    notify();
  }
  return () => {
    if (openLayers.delete(handle)) notify();
  };
}

/** How many modal layers are open. For event handlers and effects; render
 *  code subscribes with useModalLayerCount. */
export function getModalLayerCount(): number {
  return openLayers.size;
}

/** The kinds of the open layers, in open order. */
export function getOpenModalLayerKinds(): readonly ModalLayerKind[] {
  return [...openLayers].map((layer) => layer.kind);
}

/** True when a layer other than `self` is open (any layer, without `self`).
 *  A layer that registers itself while open asks this to gate its own opening
 *  without also blocking its own close. */
export function isAnotherModalLayerOpen(self: ModalLayerHandle | null = null): boolean {
  for (const layer of openLayers) {
    if (layer !== self) return true;
  }
  return false;
}

/** The number of open modal layers, re-rendering when it changes. */
export function useModalLayerCount(): number {
  return useSyncExternalStore(subscribe, getModalLayerCount, getModalLayerCount);
}

/** Registers the calling component as an open modal layer while `active`.
 *  Returns the layer's handle (stable across renders) for
 *  isAnotherModalLayerOpen. */
export function useRegisterModalLayer(active = true, kind: ModalLayerKind = 'dialog'): ModalLayerHandle {
  const handle = useMemo((): ModalLayerHandle => ({ kind }), [kind]);
  useEffect(() => {
    if (!active) return undefined;
    return registerModalLayer(handle);
  }, [active, handle]);
  return handle;
}

/** Registers a layer for as long as it is mounted. Rendered inside a Radix
 *  `Content`, it follows that layer's Presence — a wrapper component's own
 *  body runs even while the dialog is closed. */
export function ModalLayer({ kind }: Readonly<{ kind: ModalLayerKind }>): null {
  useRegisterModalLayer(true, kind);
  return null;
}
