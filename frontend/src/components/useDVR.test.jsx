import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDVR } from './DVR';
import { APIError, getDVRConnection, getDVRRecordings } from '../api';
vi.mock('../api', async (original) => ({ ...await original(), getDVRConnection: vi.fn(), getDVRRecordings: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('does not restore a revoked recording catalog while retrying permission verification', async () => {
  const recording = { id: '7', channel_id: '41', status: 'recording' };
  getDVRConnection.mockResolvedValue({ connected: true, access: 'manage' });
  getDVRRecordings.mockResolvedValueOnce({ items: [recording], access: 'manage' });
  const expired = vi.fn();
  const { result } = renderHook(() => useDVR(true, { csrf_token: 'test-token' }, expired));
  await waitFor(() => expect(result.current.items).toEqual([recording]));
  getDVRRecordings.mockRejectedValueOnce(new APIError('DVR access revoked.', { status: 403, code: 'dvr_permission_denied' }));
  await act(async () => { await result.current.refresh(); });
  expect(result.current.access).toBe('none');
  expect(result.current.items).toEqual([]);
  expect(expired).not.toHaveBeenCalled();

  let finish;
  getDVRRecordings.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let retry;
  await act(async () => { retry = result.current.refresh(); });
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(result.current.loading).toBe(true);
  expect(result.current.access).toBe('none');
  expect(result.current.items).toEqual([]);
  await act(async () => { finish({ items: [recording], access: 'view' }); await retry; });
  expect(result.current.access).toBe('view');
  expect(result.current.items).toEqual([recording]);
});
