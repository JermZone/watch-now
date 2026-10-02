import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ChannelArtwork from './ChannelArtwork';

describe('ChannelArtwork', () => {
  it('uses a Now-owned path and falls back when artwork fails', () => {
    render(<ChannelArtwork categoryID="2" channel={{ id: '41', name: 'World News', has_artwork: true }} />);
    const image = screen.getByRole('img', { name: 'World News logo' });
    expect(image).toHaveAttribute('src', '/api/live/channels/41/artwork?category_id=2');

    fireEvent.error(image);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('WN')).toBeInTheDocument();
  });

  it('renders a missing-artwork fallback without requesting an image', () => {
    render(<ChannelArtwork channel={{ id: '9', name: 'Local' }} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('L')).toBeInTheDocument();
  });
});
