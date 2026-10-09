import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RecordingOptions from './RecordingOptions';

afterEach(cleanup);

describe('Recording options', () => {
  it('supports keyboard navigation and restores focus on Escape without changing capture', () => {
    const onSelect = vi.fn();
    render(<RecordingOptions onSelect={onSelect} />);
    const trigger = screen.getByRole('button', { name: 'Recording options' });
    fireEvent.click(trigger);
    const extend = screen.getByRole('menuitem', { name: 'Extend 30 minutes' });
    const stop = screen.getByRole('menuitem', { name: 'Stop recording' });
    expect(extend).toHaveFocus();
    fireEvent.keyDown(extend, { key: 'ArrowDown' });
    expect(stop).toHaveFocus();
    fireEvent.keyDown(stop, { key: 'ArrowDown' });
    expect(extend).toHaveFocus();
    fireEvent.keyDown(extend, { key: 'End' });
    expect(stop).toHaveFocus();
    fireEvent.keyDown(stop, { key: 'Home' });
    expect(extend).toHaveFocus();
    fireEvent.keyDown(extend, { key: 'ArrowUp' });
    expect(stop).toHaveFocus();
    fireEvent.keyDown(stop, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(['Extend 30 minutes', 'Stop recording'])('keeps %s available through touch focus changes until click', (label) => {
    const onSelect = vi.fn();
    render(<RecordingOptions onSelect={onSelect} />);
    const trigger = screen.getByRole('button', { name: 'Recording options' });
    fireEvent.click(trigger);
    const item = screen.getByRole('menuitem', { name: label });
    fireEvent.pointerDown(item, { pointerType: 'touch' });
    fireEvent.focusIn(document.body);
    expect(item).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.pointerUp(item, { pointerType: 'touch' });
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(label.startsWith('Extend') ? 'extend' : 'stop', { currentTarget: trigger });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('dismisses on outside interaction and closes when management becomes busy', () => {
    const onSelect = vi.fn();
    const view = render(<RecordingOptions onSelect={onSelect} />);
    const trigger = screen.getByRole('button', { name: 'Recording options' });
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement, { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    view.rerender(<RecordingOptions disabled onSelect={onSelect} />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
