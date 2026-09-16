import type { ReactElement, SVGProps } from 'react';

export type IconName =
  | 'spark'
  | 'studio'
  | 'runs'
  | 'connections'
  | 'agent'
  | 'factory'
  | 'plus'
  | 'save'
  | 'check'
  | 'play'
  | 'close'
  | 'search'
  | 'clock'
  | 'cost'
  | 'person'
  | 'success'
  | 'nodes'
  | 'trigger'
  | 'data'
  | 'control'
  | 'human'
  | 'operations'
  | 'chevron'
  | 'refresh'
  | 'menu'
  | 'warning'
  | 'code'
  | 'edit'
  | 'trash'
  | 'folder'
  | 'chevronDown';

const paths: Record<IconName, ReactElement> = {
  spark: <path d="m12 2 1.5 6.5L20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5L12 2Zm7 13 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z" />,
  studio: <path d="M4 5h16v14H4zM8 9h2v2H8zm6 4h2v2h-2zM10 10l4 4" />,
  runs: <path d="M4 19V5m0 14h16M8 15l3-4 3 2 5-7" />,
  connections: <path d="M8 12h8M5 9v6m14-6v6M2 8h6v8H2zm14 0h6v8h-6z" />,
  agent: <path d="M8 4h8l3 5v8l-3 3H8l-3-3V9l3-5Zm1 7h.01M15 11h.01M9 16h6M12 4V2" />,
  factory: <path d="M3 21V9l6 3V8l6 4V5h6v16H3Zm4-4h2m4 0h2m4 0h2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  save: <path d="M5 3h12l2 2v16H5V3Zm3 0v6h8V3m-8 18v-7h8v7" />,
  check: <path d="m5 12 4 4L19 6" />,
  play: <path d="m8 5 11 7-11 7V5Z" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  search: <path d="m20 20-4-4m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" />,
  clock: <path d="M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
  cost: <path d="M12 3v18m4-14H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H7" />,
  person: <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 0v6m3-3h-6" />,
  success: <path d="M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3" />,
  nodes: <path d="M4 4h6v6H4zm10 10h6v6h-6zM7 10v4h10v-4" />,
  trigger: <path d="M13 2 5 14h7l-1 8 8-12h-7l1-8Z" />,
  data: <path d="M4 6c0-2 3.6-3 8-3s8 1 8 3-3.6 3-8 3-8-1-8-3Zm0 0v6c0 2 3.6 3 8 3s8-1 8-3V6m-16 6v6c0 2 3.6 3 8 3s8-1 8-3v-6" />,
  control: <path d="M6 4h12v6H6zM4 14h7v6H4zm9 0h7v6h-7zM12 10v4" />,
  human: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7 9a7 7 0 0 0-14 0" />,
  operations: <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0-12v2m0 13v2m8.5-8.5h-2m-13 0h-2m14.5-6-1.5 1.5m-9 9L6 18m12 0-1.5-1.5m-9-9L6 6" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  refresh: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  warning: <path d="M12 3 2 21h20L12 3Zm0 6v5m0 3h.01" />,
  code: <path d="m8 9-3 3 3 3m8-6 3 3-3 3m-2-9-4 12" />,
  edit: <path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Zm10-12 3 3" />,
  trash: <path d="M5 7h14m-9 4v5m4-5v5M9 7V4h6v3m-9 0 1 14h10l1-14" />,
  folder: <path d="M3 6h7l2 2h9v11H3V6Zm0 4h18" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
};

export function Icon({
  name,
  size = 18,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
