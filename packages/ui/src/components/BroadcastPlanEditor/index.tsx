import { useState } from 'preact/hooks';
import type {
  BroadcastPlan,
  BroadcastType,
  CutRate,
  CoverageStyle,
  EditorialAggression,
} from '@iracing-engineer/types';

interface BroadcastPlanEditorProps {
  plan: BroadcastPlan | null;
  onSave: (plan: BroadcastPlan) => void;
}

export function BroadcastPlanEditor({ plan, onSave }: BroadcastPlanEditorProps) {
  const [broadcastType, setBroadcastType] = useState<BroadcastType>(plan?.broadcastType ?? 'hero');
  const [cutRate, setCutRate] = useState<CutRate>(plan?.productionStyle.cutRate ?? 'default');
  const [coverageStyle, setCoverageStyle] = useState<CoverageStyle>(
    plan?.productionStyle.coverageStyle ?? 'default',
  );
  const [editorialAggression, setEditorialAggression] = useState<EditorialAggression>(
    plan?.productionStyle.editorialAggression ?? 'default',
  );

  function handleSave() {
    const updated: BroadcastPlan = {
      id: plan?.id ?? crypto.randomUUID(),
      sessionId: plan?.sessionId ?? '',
      broadcastType,
      primarySubjects: plan?.primarySubjects ?? [],
      dnfBehavior: plan?.dnfBehavior ?? 'convert_to_general',
      productionStyle: { cutRate, coverageStyle, editorialAggression },
      preRaceNotes: plan?.preRaceNotes ?? null,
      createdAt: plan?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    onSave(updated);
  }

  return (
    <div class="broadcast-plan-editor">
      <div class="field">
        <label>Broadcast Type</label>
        <select
          value={broadcastType}
          onChange={(e) => setBroadcastType((e.target as HTMLSelectElement).value as BroadcastType)}
        >
          <option value="hero">Hero</option>
          <option value="general">General</option>
        </select>
      </div>
      <div class="field">
        <label>Cut Rate</label>
        <select
          value={cutRate}
          onChange={(e) => setCutRate((e.target as HTMLSelectElement).value as CutRate)}
        >
          <option value="conservative">Conservative</option>
          <option value="default">Default</option>
          <option value="dynamic">Dynamic</option>
        </select>
      </div>
      <div class="field">
        <label>Coverage Style</label>
        <select
          value={coverageStyle}
          onChange={(e) => setCoverageStyle((e.target as HTMLSelectElement).value as CoverageStyle)}
        >
          <option value="hero_focused">Hero Focused</option>
          <option value="default">Default</option>
          <option value="narrative">Narrative</option>
        </select>
      </div>
      <div class="field">
        <label>Editorial Aggression</label>
        <select
          value={editorialAggression}
          onChange={(e) =>
            setEditorialAggression((e.target as HTMLSelectElement).value as EditorialAggression)
          }
        >
          <option value="reactive">Reactive</option>
          <option value="default">Default</option>
          <option value="anticipatory">Anticipatory</option>
        </select>
      </div>
      <button onClick={handleSave}>Save Plan</button>
    </div>
  );
}
