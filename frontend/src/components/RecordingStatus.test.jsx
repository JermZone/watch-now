import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import RecordingStatus from './RecordingStatus';

afterEach(cleanup);

describe('RecordingStatus', () => {
  it('uses a channel status label without replacing the finished state', () => {
    const view = render(<RecordingStatus recording label="Now Recording" showFinished />);
    expect(screen.getByRole('status')).toHaveTextContent('Now Recording');
    view.rerender(<RecordingStatus recording={false} label="Now Recording" showFinished />);
    expect(screen.getByRole('status')).toHaveTextContent('Recording finished');
  });

  it('announces recording in text alongside a decorative red indicator', () => {
    render(<RecordingStatus recording title="Example programme" />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Recording in progress');
    expect(status).toHaveTextContent('Example programme');
    expect(status).toHaveClass('is-recording');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status.querySelector('.recording-status-dot')).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not show an inactive channel as a finished recording', () => {
    const { container } = render(<RecordingStatus recording={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('removes the pulse when recording finishes', () => {
    const view = render(<RecordingStatus recording showFinished />);
    view.rerender(<RecordingStatus recording={false} showFinished />);
    expect(screen.getByRole('status')).toHaveTextContent('Recording finished');
    expect(screen.getByRole('status')).toHaveClass('is-finished');
    expect(screen.getByRole('status')).not.toHaveClass('is-recording');
  });
});
