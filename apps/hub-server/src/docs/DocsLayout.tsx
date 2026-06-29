import type { ComponentChildren } from 'preact';

export default function DocsLayout({ children }: { children: ComponentChildren }) {
  return (
    <div
      style={{
        maxWidth: '768px',
        margin: '2rem auto',
        padding: '0 1rem',
        fontFamily: 'system-ui, sans-serif',
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}
