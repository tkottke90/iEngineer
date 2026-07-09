/** @jsxRuntime automatic */
/** @jsxImportSource preact */
// SettingsTabs component contract (M10 T006b — Constitution VI: mocha + chai
// for packages/ui component contracts). The load-bearing case is (4): parent
// -owned form state survives tab switches, the contract behind the cross-tab
// unsaved-state edge case in spec 006.
// The pragma above is required: this test dir is outside tsconfig's `include`,
// so tsx would otherwise compile JSX with the classic React runtime.
import { expect } from 'chai';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { SettingsTabs } from '../src/components/SettingsTabs/index.js';

afterEach(cleanup);

const THREE_TABS = [
  { id: 'audio', label: 'Audio', content: <p>audio content</p> },
  { id: 'connection', label: 'Connection', content: <p>connection content</p> },
  { id: 'debug', label: 'Debug', content: <p>debug content</p> },
];

describe('SettingsTabs', () => {
  it('renders one tab label per entry in the tabs prop', () => {
    const { getAllByRole, getByText } = render(<SettingsTabs tabs={THREE_TABS} />);
    expect(getAllByRole('tab')).to.have.length(3);
    getByText('Audio');
    getByText('Connection');
    getByText('Debug');
  });

  it('defaults the active tab to the first tab', () => {
    const { getByRole, getByText, queryByText } = render(<SettingsTabs tabs={THREE_TABS} />);
    expect(getByRole('tab', { name: 'Audio' }).getAttribute('aria-selected')).to.equal('true');
    getByText('audio content');
    expect(queryByText('connection content')).to.equal(null);
  });

  it('opens on initialTabId when provided (falls back to first if unknown)', () => {
    const { getByRole, getByText, unmount } = render(
      <SettingsTabs tabs={THREE_TABS} initialTabId="debug" />,
    );
    expect(getByRole('tab', { name: 'Debug' }).getAttribute('aria-selected')).to.equal('true');
    getByText('debug content');
    unmount();

    const { getByRole: getByRole2 } = render(
      <SettingsTabs tabs={THREE_TABS} initialTabId="nonsense" />,
    );
    expect(getByRole2('tab', { name: 'Audio' }).getAttribute('aria-selected')).to.equal('true');
  });

  it('clicking a tab label switches the visible content to that tab', () => {
    const { getByRole, getByText, queryByText } = render(<SettingsTabs tabs={THREE_TABS} />);
    fireEvent.click(getByRole('tab', { name: 'Connection' }));
    getByText('connection content');
    expect(queryByText('audio content')).to.equal(null);
    expect(getByRole('tab', { name: 'Connection' }).getAttribute('aria-selected')).to.equal(
      'true',
    );
    expect(getByRole('tab', { name: 'Audio' }).getAttribute('aria-selected')).to.equal('false');
  });

  it('preserves parent-owned state across tab switches (edit in A, visit B, return)', () => {
    // Stateful parent harness: the value lives in the PARENT (as Setup.tsx
    // lifts formState); tabs are display-only views over it.
    function Harness() {
      const [value, setValue] = useState('initial');
      return (
        <SettingsTabs
          tabs={[
            {
              id: 'a',
              label: 'Tab A',
              content: (
                <input
                  aria-label="field-a"
                  value={value}
                  onInput={(e) => setValue((e.target as HTMLInputElement).value)}
                />
              ),
            },
            { id: 'b', label: 'Tab B', content: <p>tab b content</p> },
          ]}
        />
      );
    }

    const { getByRole, getByLabelText, getByText } = render(<Harness />);

    const input = getByLabelText('field-a') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'unsaved edit' } });
    expect((getByLabelText('field-a') as HTMLInputElement).value).to.equal('unsaved edit');

    fireEvent.click(getByRole('tab', { name: 'Tab B' }));
    getByText('tab b content');

    fireEvent.click(getByRole('tab', { name: 'Tab A' }));
    expect((getByLabelText('field-a') as HTMLInputElement).value).to.equal('unsaved edit');
  });
});
