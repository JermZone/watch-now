import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import VirtualChannelList from './VirtualChannelList';

afterEach(cleanup);

describe('VirtualChannelList', () => {
  it('reaches and activates distant rows using the keyboard with bounded DOM', () => {
    const channels = Array.from({ length: 10000 }, (_, index) => ({ id: String(index), name: `Station ${index}` }));
    const select = vi.fn();
    render(<VirtualChannelList channels={channels} onSelect={select} />);
    const list = screen.getByRole('listbox');
    list.focus();
    fireEvent.keyDown(list, { key: 'End' });
    const last = screen.getByRole('option', { name: 'Station 9999' });
    expect(list).toHaveAttribute('aria-activedescendant', last.id);
    expect(last).toHaveAttribute('aria-posinset', '10000');
    expect(last).toHaveClass('is-focused');
    expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(select).toHaveBeenLastCalledWith(channels[9999]);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: ' ' });
    expect(select).toHaveBeenLastCalledWith(channels[9998]);
    fireEvent.keyDown(list, { key: 'Home' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(select).toHaveBeenLastCalledWith(channels[1]);
    expect(list).toHaveFocus();
    expect(screen.getAllByRole('option').length).toBeLessThan(30);
  });
  it('renders a bounded window instead of the complete channel catalog', () => {
    const channels = Array.from({ length: 250 }, (_, index) => ({
      id: String(index + 1),
      name: `Channel ${index + 1}`,
      channel_number: String(index + 1),
    }));

    render(
      <VirtualChannelList
        channels={channels}
        onSelect={vi.fn()}
        selectedID="1"
      />,
    );

    const renderedRows = screen.getAllByRole('option');
    expect(renderedRows.length).toBeGreaterThan(5);
    expect(renderedRows.length).toBeLessThan(30);
    expect(screen.getByRole('option', { name: /Channel 1$/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Channel 250$/ })).not.toBeInTheDocument();
  });

  it('shows an empty state', () => {
    render(<VirtualChannelList channels={[]} onSelect={vi.fn()} selectedID={null} />);
    expect(screen.getByText(/No live channels/)).toBeInTheDocument();
  });

  it('uses denser virtual row geometry when compact', () => {
    render(
      <VirtualChannelList
        channels={[
          { id: '1', name: 'News', channel_number: '7' },
          { id: '2', name: 'Sports', channel_number: '8' },
        ]}
        compact
        onSelect={vi.fn()}
        selectedID="1"
      />,
    );

    const viewport = screen.getByRole('listbox', { name: 'Live channels' });
    expect(viewport).toHaveClass('is-compact');
    expect(screen.getByRole('option', { name: /News/ })).toHaveStyle({ height: '58px' });
    expect(viewport.firstElementChild).toHaveStyle({ height: '128px' });
  });
});
