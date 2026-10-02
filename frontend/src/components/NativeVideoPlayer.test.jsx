import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import NativeVideoPlayer from './NativeVideoPlayer';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('NativeVideoPlayer', () => {
  it('shows preparation until ready and tears media down on source change and unmount', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const view = render(<NativeVideoPlayer label="Movie" source="/api/movies/1/stream" />);
    const video = screen.getByLabelText('Movie player');
    expect(screen.getByRole('status')).toHaveTextContent('Preparing video');
    fireEvent.loadedMetadata(video);
    expect(screen.queryByText(/Preparing video/)).not.toBeInTheDocument();

    view.rerender(<NativeVideoPlayer label="Movie" source="/api/movies/2/stream" />);
    expect(pause).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    expect(video).toHaveAttribute('src', '/api/movies/2/stream');
    view.unmount();
    expect(pause).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(2);
    expect(video).not.toHaveAttribute('src');
  });

  it('clears preparation when play throws synchronously', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    render(<NativeVideoPlayer label="Episode" source="/api/series/1/episodes/2/stream" />);
    await waitFor(() => expect(screen.queryByText(/Preparing video/)).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('Use the video controls');
  });

  it('reports media failure once and ignores a stale autoplay rejection', async () => {
    let rejectFirst;
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play');
    play.mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }));
    play.mockResolvedValueOnce();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const fatal = vi.fn();
    const view = render(<NativeVideoPlayer label="Movie" onFatalError={fatal} source="/first" />);
    const video = screen.getByLabelText('Movie player');
    view.rerender(<NativeVideoPlayer label="Movie" onFatalError={fatal} source="/second" />);
    await act(async () => { rejectFirst(new Error('old rejection')); await Promise.resolve(); });
    expect(screen.queryByText(/Autoplay was prevented/)).not.toBeInTheDocument();

    fireEvent.error(video);
    fireEvent.error(video);
    expect(fatal).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledWith('This movie could not be played in this browser. Try again, or download it to play in VLC.');
  });
});
