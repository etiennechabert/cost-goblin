import { useEffect, useRef, useState } from 'react';
import { GripVertical, Check, X, Plus, Trash2, ChevronRight, ChevronDown, Folder, FileText, Layers } from 'lucide-react';
import type { OrgNode } from '@costgoblin/core/browser';
import {
  findUnassignedValues,
  pathsEqual,
  isPathDescendantOf,
  getNodeAtPath,
  updateNodeAtPath,
  removeNodeAtPath,
  insertNodeAtPath,
  moveNode,
  appendChild,
  type NodePath,
} from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useUnsavedChanges } from '../hooks/use-unsaved-changes.js';
import { useQuery } from '../hooks/use-query.js';
import { CoinRainLoader } from './coin-rain-loader.js';
import { ConfirmModal } from './confirm-modal.js';

interface EditingNode {
  readonly path: NodePath;
  readonly name: string;
  readonly virtual: boolean;
}

interface OrgTreeEditorProps {
  readonly onClose?: () => void;
}

/** What's being dragged. Tree nodes carry a path; unassigned entities carry
 *  the entity name so we can append a new leaf when dropped. */
type DragRef =
  | { readonly source: 'tree'; readonly path: NodePath }
  | { readonly source: 'unassigned'; readonly entityName: string };

/** Where a drop will land, used purely for visual feedback. */
type DropTarget =
  | { readonly kind: 'into'; readonly path: NodePath }
  | { readonly kind: 'before'; readonly path: NodePath };

function dropTargetEqual(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && pathsEqual(a.path, b.path);
}

function NodeIcon({ virtual, isLeaf }: Readonly<{ virtual: boolean; isLeaf: boolean }>): React.JSX.Element {
  if (virtual) return <Folder className="h-3.5 w-3.5 text-accent" aria-label="Virtual node" />;
  if (isLeaf) return <FileText className="h-3.5 w-3.5 text-text-muted" aria-label="Leaf entity" />;
  return <Layers className="h-3.5 w-3.5 text-text-secondary" aria-label="Parent node" />;
}

function InlineNodeEditor({ initial, onSave, onCancel }: Readonly<{
  initial: { name: string; virtual: boolean };
  onSave: (next: { name: string; virtual: boolean }) => void;
  onCancel: () => void;
}>): React.JSX.Element {
  const [name, setName] = useState(initial.name);
  const [virtual, setVirtual] = useState(initial.virtual);
  const trimmed = name.trim();
  const canSave = trimmed.length > 0;

  function commit(): void {
    if (!canSave) return;
    onSave({ name: trimmed, virtual });
  }

  return (
    <>
      <input
        type="text"
        value={name}
        onChange={(e) => { setName(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        className="flex-1 min-w-0 bg-bg-primary border border-border rounded px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        placeholder="Node name"
        autoFocus
      />
      <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={virtual}
          onChange={(e) => { setVirtual(e.target.checked); }}
          className="cursor-pointer"
        />
        <span>Virtual</span>
      </label>
      <button
        type="button"
        onClick={commit}
        disabled={!canSave}
        className="rounded p-1 bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title="Save (Enter)"
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded p-1 bg-bg-secondary text-text-secondary hover:bg-bg-tertiary transition-colors"
        title="Cancel (Esc)"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </>
  );
}

interface NodeViewProps {
  readonly node: OrgNode;
  readonly depth: number;
  readonly path: NodePath;
  readonly draggedItem: DragRef | null;
  readonly dropTarget: DropTarget | null;
  readonly editingNode: EditingNode | null;
  readonly onDragStart: (path: NodePath) => void;
  readonly onDragOverInto: (path: NodePath) => void;
  readonly onDragOverBefore: (path: NodePath) => void;
  readonly onDragLeave: () => void;
  readonly onDropInto: (path: NodePath) => void;
  readonly onDropBefore: (path: NodePath) => void;
  readonly onDragEnd: () => void;
  readonly onStartEdit: (path: NodePath, name: string, virtual: boolean) => void;
  readonly onSaveEdit: (next: { name: string; virtual: boolean }) => void;
  readonly onCancelEdit: () => void;
  readonly onAddChild: (parentPath: NodePath) => void;
  readonly onDelete: (path: NodePath) => void;
}

function NodeView(props: NodeViewProps): React.JSX.Element {
  const { node, depth, path, draggedItem, dropTarget, editingNode } = props;
  const [collapsed, setCollapsed] = useState(false);

  const hasChildren = node.children !== undefined && node.children.length > 0;
  const isVirtual = node.virtual === true;
  const isLeaf = !hasChildren && !isVirtual;

  const isDragging = draggedItem?.source === 'tree' && pathsEqual(draggedItem.path, path);
  const isDropInto = dropTarget?.kind === 'into' && pathsEqual(dropTarget.path, path);
  const isDropBefore = dropTarget?.kind === 'before' && pathsEqual(dropTarget.path, path);
  const isEditing = editingNode !== null && pathsEqual(editingNode.path, path);

  // Decide whether the drag is in the top or bottom band of the row. Top band
  // → drop *before* this node; bottom band on a virtual node → drop *into* it
  // as a new child; bottom band on a leaf → drop *before the next sibling*.
  function handleDragOver(e: React.DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const offset = e.clientY - rect.top;
    if (offset < rect.height / 3) {
      props.onDragOverBefore(path);
    } else if (isVirtual) {
      props.onDragOverInto(path);
    } else {
      const lastIdx = path[path.length - 1] ?? 0;
      props.onDragOverBefore([...path.slice(0, -1), lastIdx + 1]);
    }
  }

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (dropTarget === null) return;
    if (dropTarget.kind === 'into') props.onDropInto(dropTarget.path);
    else props.onDropBefore(dropTarget.path);
  }

  return (
    <div className="flex flex-col">
      {isDropBefore && <div className="h-0.5 bg-accent rounded-full mx-2" style={{ marginLeft: `${String(depth * 1.5 + 0.5)}rem` }} />}
      <div
        className={`group flex items-center gap-2 py-1.5 px-2 rounded transition-colors ${
          isDragging ? 'opacity-40' : ''
        } ${
          isDropInto ? 'bg-accent/15 ring-1 ring-accent/40' : 'hover:bg-bg-tertiary/30'
        }`}
        style={{ paddingLeft: `${String(depth * 1.5 + 0.5)}rem` }}
        draggable={!isEditing}
        onDragStart={(e) => {
          e.stopPropagation();
          props.onDragStart(path);
        }}
        onDragOver={handleDragOver}
        onDragLeave={(e) => { e.stopPropagation(); props.onDragLeave(); }}
        onDrop={handleDrop}
        onDragEnd={(e) => { e.stopPropagation(); props.onDragEnd(); }}
      >
        <GripVertical className="h-3.5 w-3.5 text-text-muted cursor-grab active:cursor-grabbing flex-shrink-0" />

        {hasChildren ? (
          <button
            type="button"
            onClick={() => { setCollapsed(v => !v); }}
            className="text-text-muted hover:text-text-primary transition-colors flex-shrink-0"
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-3.5 flex-shrink-0" />
        )}

        <NodeIcon virtual={isVirtual} isLeaf={isLeaf} />

        {isEditing ? (
          <InlineNodeEditor
            initial={{ name: editingNode.name, virtual: editingNode.virtual }}
            onSave={props.onSaveEdit}
            onCancel={props.onCancelEdit}
          />
        ) : (
          <>
            <button
              type="button"
              onClick={() => { props.onStartEdit(path, node.name, isVirtual); }}
              className="text-sm text-text-primary font-medium hover:text-accent transition-colors text-left truncate"
            >
              {node.name}
            </button>
            {isVirtual && (
              <span className="rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 text-[10px] text-accent flex-shrink-0">
                virtual
              </span>
            )}
            <button
              type="button"
              onClick={() => { props.onDelete(path); }}
              className="ml-auto rounded p-1 text-text-muted opacity-0 group-hover:opacity-100 hover:bg-negative/10 hover:text-negative transition-all"
              title="Delete node"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {hasChildren && !collapsed && (
        <div className="flex flex-col">
          {node.children.map((child, idx) => (
            <NodeView
              key={`${child.name}-${String(idx)}`}
              {...props}
              node={child}
              depth={depth + 1}
              path={[...path, idx]}
            />
          ))}
        </div>
      )}

      {isVirtual && !collapsed && (
        <button
          type="button"
          onClick={() => { props.onAddChild(path); }}
          className="flex items-center gap-2 py-1 px-2 text-xs text-text-muted hover:text-accent hover:bg-bg-tertiary/30 transition-colors rounded"
          style={{ paddingLeft: `${String((depth + 1) * 1.5 + 0.5)}rem` }}
        >
          <Plus className="h-3 w-3" />
          <span>Add child node</span>
        </button>
      )}
    </div>
  );
}

function UnassignedEntityView({ entityName, isDragging, onDragStart, onDragEnd }: Readonly<{
  entityName: string;
  isDragging: boolean;
  onDragStart: (entityName: string) => void;
  onDragEnd: () => void;
}>): React.JSX.Element {
  return (
    <div
      className={`flex items-center gap-2 py-1.5 px-2 rounded transition-colors ${
        isDragging ? 'opacity-40' : 'hover:bg-bg-tertiary/30'
      }`}
      draggable
      onDragStart={(e) => { e.stopPropagation(); onDragStart(entityName); }}
      onDragEnd={(e) => { e.stopPropagation(); onDragEnd(); }}
    >
      <GripVertical className="h-3.5 w-3.5 text-text-muted cursor-grab active:cursor-grabbing flex-shrink-0" />
      <FileText className="h-3.5 w-3.5 text-text-muted" />
      <span className="text-sm text-text-primary font-medium truncate">{entityName}</span>
      <span className="rounded-full border border-yellow-500/50 bg-yellow-500/10 px-2 py-0.5 text-[10px] text-yellow-600 dark:text-yellow-400 flex-shrink-0">
        unassigned
      </span>
    </div>
  );
}

export function OrgTreeEditor({ onClose }: OrgTreeEditorProps): React.JSX.Element {
  const api = useCostApi();
  const treeQuery = useQuery(() => api.getOrgTree(), []);
  const dimensionsQuery = useQuery(() => api.getDimensions(), []);

  const [tree, setTree] = useState<readonly OrgNode[] | null>(null);
  const initialRef = useRef<readonly OrgNode[] | null>(null);

  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<NodePath | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = useState(false);

  const [draggedItem, setDraggedItem] = useState<DragRef | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [editingNode, setEditingNode] = useState<EditingNode | null>(null);

  const ownerDimension = dimensionsQuery.status === 'success'
    ? dimensionsQuery.data.find(d => 'concept' in d && d.concept === 'owner')
    : undefined;
  const ownerDimensionId = ownerDimension !== undefined
    ? ('tagName' in ownerDimension ? ownerDimension.tagName : ownerDimension.name)
    : undefined;

  const allValuesQuery = useQuery(
    async () => {
      if (ownerDimensionId === undefined) return [];
      const result = await api.getFilterValues(ownerDimensionId, {});
      return result.map(v => v.value);
    },
    [ownerDimensionId],
  );

  const unassignedValues = tree !== null && allValuesQuery.status === 'success'
    ? findUnassignedValues(tree, allValuesQuery.data)
    : [];

  useEffect(() => {
    if (treeQuery.status === 'success' && tree === null) {
      const loaded = treeQuery.data;
      setTree(loaded);
      initialRef.current = loaded;
    }
  }, [treeQuery, tree]);

  const isDirty = tree !== null && initialRef.current !== null &&
    JSON.stringify(tree) !== JSON.stringify(initialRef.current);

  useUnsavedChanges(isDirty, 'Org tree editor');

  function setDropTargetIfChanged(next: DropTarget | null): void {
    setDropTarget(prev => (dropTargetEqual(prev, next) ? prev : next));
  }

  function requestClose(): void {
    if (isDirty) setDiscardConfirm(true);
    else onClose?.();
  }

  async function handleSave(): Promise<void> {
    if (tree === null) return;
    setSaveInProgress(true);
    setSaveError(null);
    try {
      await api.saveOrgTree(tree);
      initialRef.current = tree;
      setSaveInProgress(false);
      onClose?.();
    } catch (err: unknown) {
      setSaveInProgress(false);
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }

  function isValidTreeMove(fromPath: NodePath, target: DropTarget): boolean {
    if (target.kind === 'into') {
      return !isPathDescendantOf(target.path, fromPath);
    }
    const parentPath = target.path.slice(0, -1);
    return !isPathDescendantOf(parentPath, fromPath);
  }

  function handleDragOverInto(path: NodePath): void {
    if (draggedItem === null) return;
    if (draggedItem.source === 'tree' && !isValidTreeMove(draggedItem.path, { kind: 'into', path })) return;
    setDropTargetIfChanged({ kind: 'into', path });
  }

  function handleDragOverBefore(path: NodePath): void {
    if (draggedItem === null) return;
    if (draggedItem.source === 'tree' && !isValidTreeMove(draggedItem.path, { kind: 'before', path })) return;
    setDropTargetIfChanged({ kind: 'before', path });
  }

  function handleDropInto(targetPath: NodePath): void {
    if (draggedItem === null || tree === null) { resetDrag(); return; }
    if (draggedItem.source === 'unassigned') {
      const { tree: next } = appendChild(tree, targetPath, { name: draggedItem.entityName });
      setTree(next);
    } else {
      const target = getNodeAtPath(tree, targetPath);
      const childCount = target?.children?.length ?? 0;
      setTree(moveNode(tree, draggedItem.path, targetPath, childCount));
    }
    resetDrag();
  }

  function handleDropBefore(targetPath: NodePath): void {
    if (draggedItem === null || tree === null) { resetDrag(); return; }
    const parentPath = targetPath.slice(0, -1);
    const insertIdx = targetPath[targetPath.length - 1] ?? 0;
    if (draggedItem.source === 'unassigned') {
      setTree(insertNodeAtPath(tree, parentPath, insertIdx, { name: draggedItem.entityName }));
    } else {
      setTree(moveNode(tree, draggedItem.path, parentPath, insertIdx));
    }
    resetDrag();
  }

  function resetDrag(): void {
    setDraggedItem(null);
    setDropTarget(null);
  }

  function handleSaveEdit(next: { name: string; virtual: boolean }): void {
    if (tree === null || editingNode === null) return;
    setTree(updateNodeAtPath(tree, editingNode.path, (node) => {
      // OrgNode.virtual is `true | undefined`; toggling off must omit the key.
      if (next.virtual) return { ...node, name: next.name, virtual: true };
      return node.children === undefined
        ? { name: next.name }
        : { name: next.name, children: node.children };
    }));
    setEditingNode(null);
  }

  function handleAddChild(parentPath: NodePath): void {
    if (tree === null) return;
    const { tree: next, path } = appendChild(tree, parentPath, { name: 'New node', virtual: true });
    setTree(next);
    setEditingNode({ path, name: 'New node', virtual: true });
  }

  function handleDelete(path: NodePath): void {
    if (tree === null) return;
    setTree(removeNodeAtPath(tree, path));
    setDeleteConfirm(null);
    if (editingNode !== null && pathsEqual(editingNode.path, path)) setEditingNode(null);
  }

  if (treeQuery.status === 'loading' || tree === null) {
    return (
      <div className="flex items-center justify-center py-20">
        <CoinRainLoader />
      </div>
    );
  }

  if (treeQuery.status === 'error') {
    return (
      <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3 text-sm text-negative">
        Failed to load org tree: {treeQuery.error.message}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Organization Tree Editor</h2>
          <p className="text-xs text-text-muted mt-1">
            Drag nodes to rearrange. Drop into a virtual folder, or between siblings to reorder.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={requestClose}
            disabled={saveInProgress}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-bg-tertiary transition-colors disabled:opacity-50"
          >
            {isDirty ? 'Cancel' : 'Close'}
          </button>
          <button
            type="button"
            onClick={() => { handleSave().catch(() => undefined); }}
            disabled={!isDirty || saveInProgress}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white bg-accent hover:bg-accent-hover transition-colors disabled:opacity-40"
          >
            {saveInProgress ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {saveError !== null && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3 text-sm text-negative">
          Failed to save: {saveError}
        </div>
      )}

      <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
        <div className="p-3">
          {tree.length > 0 ? (
            <>
              {tree.map((node, idx) => (
                <NodeView
                  key={`${node.name}-${String(idx)}`}
                  node={node}
                  depth={0}
                  path={[idx]}
                  draggedItem={draggedItem}
                  dropTarget={dropTarget}
                  editingNode={editingNode}
                  onDragStart={(path) => { setDraggedItem({ source: 'tree', path }); }}
                  onDragOverInto={handleDragOverInto}
                  onDragOverBefore={handleDragOverBefore}
                  onDragLeave={() => { setDropTarget(null); }}
                  onDropInto={handleDropInto}
                  onDropBefore={handleDropBefore}
                  onDragEnd={resetDrag}
                  onStartEdit={(path, name, virtual) => { setEditingNode({ path, name, virtual }); }}
                  onSaveEdit={handleSaveEdit}
                  onCancelEdit={() => { setEditingNode(null); }}
                  onAddChild={handleAddChild}
                  onDelete={(path) => { setDeleteConfirm(path); }}
                />
              ))}
              <button
                type="button"
                onClick={() => { handleAddChild([]); }}
                className="flex items-center gap-2 py-2 px-2 text-xs text-text-muted hover:text-accent hover:bg-bg-tertiary/30 transition-colors rounded mt-2"
              >
                <Plus className="h-3 w-3" />
                <span>Add root node</span>
              </button>
            </>
          ) : (
            <div className="p-5 text-center">
              <p className="text-sm text-text-muted mb-3">
                No organizational tree configured. Add nodes to get started.
              </p>
              <button
                type="button"
                onClick={() => { handleAddChild([]); }}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm text-white bg-accent hover:bg-accent-hover transition-colors rounded-md"
              >
                <Plus className="h-4 w-4" />
                <span>Add first node</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {ownerDimensionId !== undefined && unassignedValues.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
          <div className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-sm font-semibold text-text-primary">Unassigned Entities</h3>
              <span className="rounded-full bg-yellow-500/10 border border-yellow-500/30 px-2 py-0.5 text-[10px] text-yellow-600 dark:text-yellow-400">
                {unassignedValues.length}
              </span>
            </div>
            <p className="text-xs text-text-muted mb-3">
              Drag entities below into the tree to organize them.
            </p>
            <div className="flex flex-col gap-0.5">
              {unassignedValues.map(entityName => (
                <UnassignedEntityView
                  key={entityName}
                  entityName={entityName}
                  isDragging={draggedItem?.source === 'unassigned' && draggedItem.entityName === entityName}
                  onDragStart={(name) => { setDraggedItem({ source: 'unassigned', entityName: name }); }}
                  onDragEnd={resetDrag}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {discardConfirm && (
        <ConfirmModal
          title="Discard changes?"
          message="You have unsaved changes to the org tree. Discard them and close the editor?"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => { setDiscardConfirm(false); onClose?.(); }}
          onCancel={() => { setDiscardConfirm(false); }}
        />
      )}

      {deleteConfirm !== null && (
        <ConfirmModal
          title="Delete node?"
          message={`Remove "${getNodeAtPath(tree, deleteConfirm)?.name ?? ''}" and all its descendants from the tree?`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          destructive
          onConfirm={() => { handleDelete(deleteConfirm); }}
          onCancel={() => { setDeleteConfirm(null); }}
        />
      )}
    </div>
  );
}
