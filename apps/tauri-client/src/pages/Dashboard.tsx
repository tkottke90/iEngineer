import { useEffect, useState } from 'preact/hooks';
import { FuelGauge, TireStatus } from '@iracing-engineer/ui';
import type { FuelModel, TireModel } from '@iracing-engineer/types';

export function Dashboard() {
  const [pttActive, _setPttActive] = useState(false);
  const [safeWindowOpen, _setSafeWindowOpen] = useState(false);
  const [lastMessage, _setLastMessage] = useState<string | null>(null);
  const [fuelModel, _setFuelModel] = useState<FuelModel | null>(null);
  const [tireModel, _setTireModel] = useState<TireModel | null>(null);

  useEffect(() => {
    // TODO: listen for state updates via Tauri event
    // invoke("get_connection_status").then(...)
  }, []);

  return (
    <div class="dashboard">
      <div class="status-bar">
        <span class={`ptt-indicator ${pttActive ? 'active' : ''}`}>
          {pttActive ? 'TRANSMITTING' : 'PTT READY'}
        </span>
        <span class={`safe-window ${safeWindowOpen ? 'open' : 'closed'}`}>
          {safeWindowOpen ? 'SAFE WINDOW' : 'UNSAFE'}
        </span>
      </div>

      {lastMessage && (
        <div class="last-message">
          <strong>Engineer:</strong> {lastMessage}
        </div>
      )}

      <div class="telemetry-panels">
        {fuelModel && <FuelGauge model={fuelModel} />}
        {tireModel && <TireStatus model={tireModel} />}
      </div>
    </div>
  );
}
