import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import { WorkflowNodeCard, type CanvasNode } from './WorkflowNodeCard';

export interface CanvasProjectionProps {
  nodes: CanvasNode[];
  edges: Edge[];
  onConnect: (connection: Connection) => void;
  onEdgesChange: (changes: EdgeChange<Edge>[]) => void;
  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onSelectionChange: (selection: OnSelectionChangeParams) => void;
  onNodeDoubleClick?: (node: CanvasNode) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}

const nodeTypes = { workflow: WorkflowNodeCard };

/** Compatibility canvas kept behind a lazy boundary so file-first authoring stays light. */
export function CanvasProjection({ nodes, edges, onConnect, onEdgesChange, onNodesChange, onSelectionChange, onNodeDoubleClick, canUndo = false, canRedo = false, onUndo, onRedo }: CanvasProjectionProps) {
  const renderedNodes = nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      ...(onNodeDoubleClick === undefined ? {} : { onOpenSource: () => onNodeDoubleClick(node) }),
    },
  }));
  return (
    <section
      aria-label="Workflow canvas"
      className="flow-canvas"
      onDoubleClick={(event) => {
        // React Flow's node callback is not emitted by every interactive child
        // (notably the custom node card). Resolve the stable DOM node id as a
        // fallback so double-click source navigation remains reliable.
        const element = event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>('.react-flow__node')
          : null;
        const nodeId = element?.getAttribute('data-id');
        const node = nodeId === null || nodeId === undefined ? undefined : nodes.find((candidate) => candidate.id === nodeId);
        if (node !== undefined) onNodeDoubleClick?.(node);
      }}
    >
      <div className="canvas-meta">
        <span>{nodes.length} nodes</span>
        <span>{edges.length} connections</span>
        <span className="canvas-history-actions">
          <button aria-label="Undo Canvas edit" className="text-button" disabled={!canUndo} onClick={onUndo} type="button">Undo</button>
          <button aria-label="Redo Canvas edit" className="text-button" disabled={!canRedo} onClick={onRedo} type="button">Redo</button>
        </span>
      </div>
      <ReactFlow
        colorMode="dark"
        deleteKeyCode={['Backspace', 'Delete']}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodeTypes={nodeTypes}
        nodes={renderedNodes}
        onConnect={onConnect}
        onEdgesChange={onEdgesChange}
        onNodesChange={onNodesChange}
        onNodeDoubleClick={(_event, node) => onNodeDoubleClick?.(node)}
        onSelectionChange={onSelectionChange}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#263246" gap={24} size={1} variant={BackgroundVariant.Dots} />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap maskColor="rgba(8, 13, 22, 0.72)" nodeColor="#33435e" pannable position="bottom-right" zoomable />
      </ReactFlow>
    </section>
  );
}
