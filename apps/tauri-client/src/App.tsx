import { useState } from 'preact/hooks';
import { Dashboard } from './pages/Dashboard.js';
import { Setup } from './pages/Setup.js';
import { Debrief } from './pages/Debrief.js';

type Page = 'dashboard' | 'setup' | 'debrief';

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
      </nav>
      <main>
        {page === 'dashboard' && <Dashboard />}
        {page === 'setup' && <Setup />}
        {page === 'debrief' && <Debrief />}
      </main>
    </div>
  );
}
