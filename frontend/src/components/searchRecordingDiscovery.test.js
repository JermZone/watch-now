import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getChannelRecordings } = vi.hoisted(() => ({ getChannelRecordings: vi.fn() }));
vi.mock('../api', () => ({ getChannelRecordings }));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let getSearchChannelRecordings;
beforeEach(async () => {
  vi.resetModules();
  getChannelRecordings.mockReset();
  ({ getSearchChannelRecordings } = await import('./searchRecordingDiscovery'));
});

describe('search recording discovery request queue', () => {
  it('runs at most two requests and starts waiting channels as each slot becomes free', async () => {
    const responses = Array.from({ length: 4 }, deferred);
    getChannelRecordings.mockImplementation(channelID => responses[Number(channelID)].promise);
    const requests = responses.map((_, index) => getSearchChannelRecordings(String(index)));

    expect(getChannelRecordings.mock.calls.map(([channelID]) => channelID)).toEqual(['0', '1']);
    responses[1].resolve({ items: ['second'], access: 'view' });
    await expect(requests[1]).resolves.toEqual({ items: ['second'], access: 'view' });
    expect(getChannelRecordings.mock.calls.map(([channelID]) => channelID)).toEqual(['0', '1', '2']);
    responses[2].resolve({ items: [] });
    await requests[2];
    expect(getChannelRecordings.mock.calls.map(([channelID]) => channelID)).toEqual(['0', '1', '2', '3']);
    responses[0].resolve({ items: [] });
    responses[3].resolve({ items: [] });
    await Promise.all(requests);
  });

  it('removes an aborted waiting request without dispatching it or blocking later channels', async () => {
    const first = deferred();
    const second = deferred();
    const fourth = deferred();
    getChannelRecordings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(fourth.promise);
    const firstRequest = getSearchChannelRecordings('first');
    const secondRequest = getSearchChannelRecordings('second');
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const cancelled = getSearchChannelRecordings('cancelled', { signal: controller.signal });
    const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const fourthRequest = getSearchChannelRecordings('fourth');

    controller.abort();
    await rejection;
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(getChannelRecordings.mock.calls.map(([channelID]) => channelID)).toEqual(['first', 'second']);
    first.resolve({ items: [] });
    await firstRequest;
    expect(getChannelRecordings.mock.calls.map(([channelID]) => channelID)).toEqual(['first', 'second', 'fourth']);
    second.resolve({ items: [] });
    fourth.resolve({ items: [] });
    await Promise.all([secondRequest, fourthRequest]);
  });

  it('rejects an already aborted request without calling the API', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getSearchChannelRecordings('cancelled', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(getChannelRecordings).not.toHaveBeenCalled();
  });

  it('passes an in-flight abort signal through and releases its slot when the API aborts', async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    getChannelRecordings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const firstRequest = getSearchChannelRecordings('first', { signal: controller.signal });
    const rejected = expect(firstRequest).rejects.toMatchObject({ name: 'AbortError' });
    const secondRequest = getSearchChannelRecordings('second');
    const thirdRequest = getSearchChannelRecordings('third');

    expect(getChannelRecordings).toHaveBeenCalledWith('first', { signal: controller.signal });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    first.reject(new DOMException('Aborted', 'AbortError'));
    await rejected;
    expect(getChannelRecordings.mock.calls.map(([channelID]) => channelID)).toEqual(['first', 'second', 'third']);
    second.resolve({ items: [] });
    third.resolve({ items: [] });
    await Promise.all([secondRequest, thirdRequest]);
  });

  it('starts waiting work after a failed request, without caching successes or failures', async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    getChannelRecordings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)
      .mockResolvedValueOnce({ items: ['fresh'] });
    const firstRequest = getSearchChannelRecordings('repeat');
    const rejected = expect(firstRequest).rejects.toThrow('Unavailable');
    const secondRequest = getSearchChannelRecordings('second');
    const thirdRequest = getSearchChannelRecordings('third');

    first.reject(new Error('Unavailable'));
    await rejected;
    expect(getChannelRecordings).toHaveBeenCalledTimes(3);
    second.resolve({ items: [] });
    third.resolve({ items: [] });
    await Promise.all([secondRequest, thirdRequest]);
    await expect(getSearchChannelRecordings('repeat')).resolves.toEqual({ items: ['fresh'] });
    expect(getChannelRecordings).toHaveBeenCalledTimes(4);
  });

  it('also releases a slot when an API call throws synchronously', async () => {
    getChannelRecordings
      .mockImplementationOnce(() => { throw new Error('Request failed'); })
      .mockResolvedValueOnce({ items: [] });
    await expect(getSearchChannelRecordings('failed')).rejects.toThrow('Request failed');
    await expect(getSearchChannelRecordings('next')).resolves.toEqual({ items: [] });
    expect(getChannelRecordings).toHaveBeenCalledTimes(2);
  });
});
