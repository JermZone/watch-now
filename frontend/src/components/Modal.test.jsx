import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from './Modal';

afterEach(cleanup);

it('contains keyboard focus, isolates the background, and restores it on close', async () => {
  const user = userEvent.setup();
  const trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  const close = vi.fn();
  const { container, unmount } = render(<Modal labelledBy="test-title" onClose={close}><h2 id="test-title">Confirmation</h2><a href="#help">Help</a><button>Cancel</button><button>Confirm</button></Modal>);
  expect(container.inert).toBe(true);
  expect(trigger.inert).toBe(true);
  expect(screen.getByRole('link')).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('link')).toHaveFocus();
  trigger.focus();
  expect(screen.getByRole('link')).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(close).toHaveBeenCalledOnce();
  unmount();
  expect(trigger.inert).toBeFalsy();
  expect(trigger).toHaveFocus();
  trigger.remove();
});
