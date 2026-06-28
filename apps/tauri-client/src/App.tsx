import { useState } from 'preact/hooks';
import { Dashboard } from './pages/Dashboard.js';
import { Setup } from './pages/Setup.js';
import { Debrief } from './pages/Debrief.js';
import { Diagnostics } from './pages/Diagnostics.js';

type Page = 'dashboard' | 'setup' | 'debrief' | 'diagnostics';

export function App() {
  const [page, setPage] = useState<Page>('dashboard');

  return (
    <div class="app">
      <nav class="tabs">
        <button class={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}>
          Dashboard
        </button>
        <button class={page === 'setup' ? 'active' : ''} onClick={() => setPage('setup')}>
          Setup
        </button>
        <button class={page === 'debrief' ? 'active' : ''} onClick={() => setPage('debrief')}>
          Debrief
        </button>
        <button
          class={page === 'diagnostics' ? 'active' : ''}
          onClick={() => setPage('diagnostics')}
        >
          Diagnostics
        </button>
      </nav>
      <main>
        {page === 'dashboard' && <Dashboard />}
        {page === 'setup' && <Setup />}
        {page === 'debrief' && <Debrief />}
        {page === 'diagnostics' && <Diagnostics />}
      </main>
    </div>
  );
}
