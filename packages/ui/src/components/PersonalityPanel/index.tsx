// Plain-number trait values (each 1-5). The panel clamps input to that range; the
// hub validates the values again in parsePersonality, so strict typing here would
// only fight the config, which carries plain numbers.
export interface PersonalityValue {
  openness: number;
  warmth: number;
  energy: number;
  conscientiousness: number;
  assertiveness: number;
}

interface PersonalityPanelProps {
  value: PersonalityValue;
  onChange: (next: PersonalityValue) => void;
}

type TraitKey = keyof PersonalityValue;

const TRAITS: Array<{ key: TraitKey; label: string; words: [string, string, string, string, string] }> = [
  { key: 'openness', label: 'Openness', words: ['Conventional', 'Cautious', 'Balanced', 'Inquisitive', 'Visionary'] },
  { key: 'warmth', label: 'Warmth', words: ['Detached', 'Reserved', 'Cordial', 'Empathetic', 'Nurturing'] },
  { key: 'energy', label: 'Energy', words: ['Tranquil', 'Measured', 'Steady', 'Animated', 'Exuberant'] },
  { key: 'conscientiousness', label: 'Conscientiousness', words: ['Spontaneous', 'Flexible', 'Organized', 'Methodical', 'Meticulous'] },
  { key: 'assertiveness', label: 'Assertiveness', words: ['Deferential', 'Accommodating', 'Diplomatic', 'Confident', 'Commanding'] },
];

/**
 * Five OCEAN personality sliders (each 1-5) with word-anchored levels. Presentation
 * only — the parent owns the value and persists it (Constitution II). Energy=1
 * (Tranquil) is the quiet setting that suppresses Tier 2/Tier 3 commentary.
 */
export function PersonalityPanel({ value, onChange }: PersonalityPanelProps) {
  const set = (key: TraitKey, level: number) =>
    onChange({ ...value, [key]: Math.min(5, Math.max(1, level)) });

  return (
    <div class="personality-panel">
      {TRAITS.map((t) => {
        const level = value[t.key];
        return (
          <div key={t.key} class="trait-row" style={{ marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <label for={`trait-${t.key}`}>{t.label}</label>
              <span style={{ fontWeight: 600 }}>
                {level} — {t.words[level - 1]}
              </span>
            </div>
            <input
              id={`trait-${t.key}`}
              type="range"
              min={1}
              max={5}
              step={1}
              value={level}
              onInput={(e) => set(t.key, Number((e.currentTarget as HTMLInputElement).value))}
              style={{ width: '100%' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#9ca3af' }}>
              <span>{t.words[0]}</span>
              <span>{t.words[4]}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
