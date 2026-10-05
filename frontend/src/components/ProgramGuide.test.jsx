import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import ProgramGuide from './ProgramGuide';

const now = Date.parse('2026-09-21T18:30:00Z');

describe('ProgramGuide', () => {
  it('shows current, upcoming, and progress states', () => {
    render(
      <ProgramGuide
        error=""
        guide={{
          current: { title: 'Current show', description: 'Current description', start: '2026-09-21T18:00:00Z', end: '2026-09-21T19:00:00Z' },
          upcoming: { title: 'Next show', description: 'Next description', start: '2026-09-21T19:00:00Z', end: '2026-09-21T20:00:00Z' },
        }}
        loading={false}
        now={now}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Current show' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Next show' })).toBeInTheDocument();
    expect(screen.getByText('Current description')).toBeInTheDocument();
    expect(screen.getByText('Next description')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('shows loading and missing-guide states', () => {
    const { rerender } = render(<ProgramGuide error="" guide={null} loading now={now} onRetry={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading program guide');
    rerender(<ProgramGuide error="" guide={{ current: null, upcoming: null }} loading={false} now={now} onRetry={vi.fn()} />);
    expect(screen.getByText(/No program information is available/)).toBeInTheDocument();
  });

  it('shows an error and retries', async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    render(<ProgramGuide error="Guide failed" guide={null} loading={false} now={now} onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Guide failed');
    await user.click(screen.getByRole('button', { name: 'Retry guide' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
