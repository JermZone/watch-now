import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import SearchField from './SearchField';

const SearchExample = () => {
  const [query, setQuery] = useState('');
  return <SearchField label="Movies" onChange={setQuery} placeholder="Search Movies…" value={query} />;
};

describe('SearchField', () => {
  it('keeps the query and dismisses the keyboard when Return is pressed', async () => {
    const user = userEvent.setup();
    render(<SearchExample />);
    const search = screen.getByRole('searchbox', { name: 'Search Movies' });

    await user.type(search, 'Anne Frank{Enter}');

    expect(search).toHaveValue('Anne Frank');
    expect(search).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Clear Movies search' })).toBeInTheDocument();
  });
});
