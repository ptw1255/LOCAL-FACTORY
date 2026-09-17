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
}

const nodeTypes = { workflow: WorkflowNodeCard };

/** Compatibility canvas kept behind a lazy boundary so file-first authoring stays light. */
export function CanvasProjection({ nodes, edges, onConnect, onEdgesChange, onNodesChange, onSelectionChange }: CanvasProjectionProps) {
  return (
    <section className="flow-canvas" aria-label="Workflow canvas">
      <div className="canvas-meta">
        <span>{nodes.length} nodes</span>
        <span>{edges.length} connections</span>
      </div>
      <ReactFlow
        colorMode="dark"
        deleteKeyCode={['Backspace', 'Delete']}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodeTypes={nodeTypes}
        nodes={nodes}
        onConnect={onConnect}
        onEdgesChange={onEdgesChange}
        onNodesChange={onNodesChange}
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
