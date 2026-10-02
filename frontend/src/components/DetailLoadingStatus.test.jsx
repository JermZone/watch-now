import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import DetailLoadingStatus from './DetailLoadingStatus';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('DetailLoadingStatus', () => {
  it('communicates ongoing work without relying on animation or repeated live announcements', () => {
    vi.useFakeTimers();
    render(<DetailLoadingStatus />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading details…');
    expect(screen.getByText('Request in progress.')).toBeVisible();
    expect(screen.getByRole('status').querySelector('.spinner')).toHaveAttribute('aria-hidden', 'true');

    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('Request in progress · 5s elapsed.')).toHaveAttribute('aria-live', 'off');
    expect(screen.getByRole('status')).toHaveTextContent(/^Loading details…$/);
  });

  it('cleans up its timer when loading ends and starts fresh for the next request', () => {
    vi.useFakeTimers();
    const view = render(<DetailLoadingStatus label="Loading series details…" />);
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole('status')).toHaveTextContent('Loading series details…');
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);

    render(<DetailLoadingStatus />);
    expect(screen.getByText('Request in progress.')).toBeVisible();
    expect(screen.queryByText(/elapsed/)).not.toBeInTheDocument();
  });
});
