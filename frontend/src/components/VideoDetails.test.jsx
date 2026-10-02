import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import VideoDetails, { videoDetailsMetadata } from './VideoDetails';

afterEach(cleanup);

describe('VideoDetails', () => {
  it('shows available facts without a compatibility action or prediction', () => {
    render(<VideoDetails streamInfo={{ container: 'mp4', video_codec: 'h264', audio_codec: 'aac' }} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Stream details' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['H.264', 'AAC', 'MP4']);
  });

  it('updates the badges when loaded details replace an empty or partial response', () => {
    const { rerender } = render(<VideoDetails streamInfo={{ container: 'mp4' }} />);
    expect(within(screen.getByRole('list', { name: 'Stream details' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<VideoDetails streamInfo={{ container: 'mp4', video_codec: 'h264', audio_codec: 'aac', width: 1920, height: 1080 }} />);
    expect(within(screen.getByRole('list', { name: 'Stream details' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['1920x1080', 'H.264', 'AAC', 'MP4']);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<VideoDetails />);
    expect(screen.queryByRole('list', { name: 'Stream details' })).not.toBeInTheDocument();
  });

  it('shows complete metadata as badges', () => {
    render(<VideoDetails streamInfo={{ container: 'mp4', video_codec: 'avc1', audio_codec: 'aac', resolution: '1080p' }} />);

    expect(within(screen.getByRole('list', { name: 'Stream details' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['1080p', 'H.264', 'AAC', 'MP4']);
  });

  it('shows only available facts when metadata is incomplete', () => {
    render(<VideoDetails streamInfo={{ container: 'mp4' }} />);
    expect(screen.getByRole('list', { name: 'Stream details' })).toHaveTextContent(/^MP4$/);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/unknown|unavailable/i)).not.toBeInTheDocument();
  });

  it.each([undefined, null, ''])('does not infer no audio from a missing channel count', (audio_channels) => {
    render(<VideoDetails streamInfo={{ container: 'mp4', audio_channels }} />);
    expect(screen.getByRole('list', { name: 'Stream details' })).toHaveTextContent(/^MP4$/);
    expect(screen.queryByText('No audio')).not.toBeInTheDocument();
  });

  it.each([
    [{ resolution: '1080p', height: 1080 }, '1080p'],
    [{ resolution: '1080i' }, '1080i'],
    [{ width: 1920, height: 1040 }, '1920x1040'],
    [{ width: 1080, height: 1920 }, '1080x1920'],
    [{ height: 1080 }, '1080 px high'],
    [{ width: 1920 }, '1920 px wide'],
    [{ resolution: '2160p', width: 1920, height: 1080 }, '1920x1080'],
    [{ resolution: '3840x2160', width: 1920, height: 1080 }, '1920x1080'],
  ])('shows explicit resolution or exact partial dimensions without rounding', (streamInfo, expected) => {
    render(<VideoDetails streamInfo={streamInfo} />);
    expect(screen.getByLabelText('Stream details')).toHaveTextContent(expected);
    expect(screen.queryByText('Resolution unavailable')).not.toBeInTheDocument();
  });

  it.each([
    undefined,
    { resolution: 'Full HD' },
    { resolution: '999999p' },
    { width: true, height: 1080.5 },
    { resolution: 'https://provider.invalid/secret' },
  ])('hides empty details and arbitrary source labels', (streamInfo) => {
    render(<VideoDetails streamInfo={streamInfo} />);
    expect(screen.queryByText('Resolution unavailable')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Stream details')).not.toBeInTheDocument();
  });

  it('does not infer resolution or exact file size from names, bitrate, duration, or unverified size fields', () => {
    render(<VideoDetails streamInfo={{
      container: 'MP4', name: 'Film 1080p', bitrate: 8000000, duration_secs: 3600,
      file_size: 3600000000, size: '3.6 GB', tags: { NUMBER_OF_BYTES: '3600000000' },
    }} />);
    expect(screen.getByLabelText('Stream details')).toHaveTextContent(/^MP4$/);
    expect(screen.queryByText('Resolution unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText(/1080p|3600000000|3\.6 GB/)).not.toBeInTheDocument();
  });

  it('presents only normalized media fields and ignores provider data', () => {
    const streamInfo = {
      audio_codec: 'ac3', container: 'mkv', height: 2160, provider_url: 'https://provider.invalid/secret',
      raw: { password: 'secret' }, video_codec: 'hevc', width: 3840,
    };
    render(<VideoDetails streamInfo={streamInfo} />);

    expect(within(screen.getByRole('list', { name: 'Stream details' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['3840x2160', 'HEVC', 'AC3', 'MKV']);
    expect(screen.queryByText(/provider|secret/i)).not.toBeInTheDocument();
    expect(videoDetailsMetadata(streamInfo)).toEqual(['3840x2160', 'HEVC', 'AC3', 'MKV']);
  });
});
