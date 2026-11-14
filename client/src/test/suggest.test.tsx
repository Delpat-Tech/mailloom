import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

const suggest = vi.fn();
vi.mock('../services/mailExtras.js', () => ({ suggestContacts: (...a: unknown[]) => suggest(...a) }));

import { RecipientField } from '../components/RecipientField.js';
import { mergeRecipients } from '../services/recipients.js';

afterEach(() => {
  cleanup();
  suggest.mockReset();
});

function Harness({ initial = [] as string[] }) {
  const [list, setList] = useState<string[]>(initial);
  const [input, setInput] = useState('');
  return (
    <>
      <RecipientField
        id="to"
        label="To"
        list={list}
        input={input}
        onInput={setInput}
        onAdd={(v) => {
          setList((l) => mergeRecipients(l, v));
          setInput('');
        }}
        onRemove={(i) => setList((l) => l.filter((_, k) => k !== i))}
        nameOf={() => ''}
      />
      <output data-testid="chips">{JSON.stringify(list)}</output>
    </>
  );
}

const people = [
  { name: 'Priya Shah', email: 'priya@delpat.test', count: 5, lastUsed: '' },
  { name: 'Pat Lee', email: 'pat@delpat.test', count: 2, lastUsed: '' }
];

describe('recipient suggestions', () => {
  it('uses the plain placeholder', () => {
    suggest.mockResolvedValue([]);
    render(<Harness />);
    expect(screen.getByPlaceholderText('Name or email')).toBeTruthy();
  });

  it('opens after one character, moves with the arrows and picks with Enter', async () => {
    suggest.mockResolvedValue(people);
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('combobox'), 'p');
    expect(await screen.findAllByRole('option')).toHaveLength(2);
    expect(suggest).toHaveBeenCalledWith('p');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(screen.getByTestId('chips').textContent).toContain('Pat Lee <pat@delpat.test>');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Tab takes the first suggestion, Escape closes without picking', async () => {
    suggest.mockResolvedValue(people);
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('combobox'), 'pr');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByTestId('chips').textContent).toBe('[]');
    await user.keyboard('i');
    await screen.findByRole('listbox');
    await user.keyboard('{Tab}');
    expect(screen.getByTestId('chips').textContent).toContain('priya@delpat.test');
  });

  it('a tap picks a suggestion', async () => {
    suggest.mockResolvedValue(people);
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('combobox'), 'p');
    await user.click(await screen.findByRole('option', { name: /Priya Shah/ }));
    expect(screen.getByTestId('chips').textContent).toContain('priya@delpat.test');
  });

  it('Backspace on an empty field removes the last chip', async () => {
    suggest.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<Harness initial={['a@x.test', 'b@x.test']} />);
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('{Backspace}');
    expect(JSON.parse(screen.getByTestId('chips').textContent!)).toEqual(['a@x.test']);
  });

  it('pasting several addresses makes several chips', async () => {
    suggest.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox'));
    await user.paste('a@x.test, b@x.test;c@x.test\nd@x.test e@x.test');
    await waitFor(() => expect(JSON.parse(screen.getByTestId('chips').textContent!)).toHaveLength(5));
  });
});
