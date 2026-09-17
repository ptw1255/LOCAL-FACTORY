import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Icon, type IconName } from './icons';
import type { WorkflowNodeData } from './types';

export type CanvasNode = Node<WorkflowNodeData, 'workflow'>;

const categoryIcons: Record<string, IconName> = {
  Triggers: 'trigger',
  Data: 'data',
  Control: 'control',
  Connections: 'connections',
  Human: 'human',
  Agent: 'agent',
  Operations: 'operations',
};

export function WorkflowNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const entries = Object.entries(data.config);
  const summary = entries
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ');

  return (
    <article className={`workflow-node category-${data.category.toLowerCase()} ${selected ? 'selected' : ''}`} onDoubleClick={() => { if (typeof data.onOpenSource === 'function') data.onOpenSource(); }}>
      <Handle className="node-handle" position={Position.Left} type="target" />
      <div className="workflow-node-topline">
        <span className="node-icon">
          <Icon name={categoryIcons[data.category] ?? 'nodes'} size={15} />
        </span>
        <span className="node-category">{data.category}</span>
        <span className="node-menu" aria-hidden="true">•••</span>
      </div>
      <strong>{data.label}</strong>
      <span className="node-type">{data.nodeType}</span>
      <p>{summary || data.description}</p>
      <Handle className="node-handle" position={Position.Right} type="source" />
    </article>
  );
}
