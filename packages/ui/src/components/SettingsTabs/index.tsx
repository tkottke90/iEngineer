import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

export interface SettingsTab {
  id: string;
  label: string;
  content: ComponentChildren;
}

export interface SettingsTabsProps {
  tabs: SettingsTab[];
  /** Tab to open first (e.g. the /diagnostics redirect opens "debug"). Falls
   *  back to the first tab when absent or unknown. */
  initialTabId?: string;
}

/**
 * Tab bar + content area for the Settings page (M10 T006). Display-only: the
 * parent owns all form state and passes rendered content per tab, so unsaved
 * values survive tab switches — this component never holds or resets them.
 */
export function SettingsTabs({ tabs, initialTabId }: SettingsTabsProps) {
  const [activeId, setActiveId] = useState<string | undefined>(
    initialTabId && tabs.some((t) => t.id === initialTabId) ? initialTabId : tabs[0]?.id,
  );
  const active = tabs.find((t) => t.id === activeId);

  return (
    <div class="settings-tabs">
      <div
        role="tablist"
        class="settings-tabs-bar"
        style={{
          display: 'flex',
          gap: '0.25rem',
          borderBottom: '1px solid #333',
          marginBottom: '1rem',
          flexWrap: 'wrap',
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              class={isActive ? 'active' : ''}
              onClick={() => setActiveId(tab.id)}
              style={{
                padding: '0.4rem 0.9rem',
                border: 'none',
                borderBottom: isActive ? '2px solid #2563eb' : '2px solid transparent',
                background: 'transparent',
                color: isActive ? '#fff' : '#9ca3af',
                fontWeight: isActive ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" class="settings-tabs-content">
        {active?.content}
      </div>
    </div>
  );
}
