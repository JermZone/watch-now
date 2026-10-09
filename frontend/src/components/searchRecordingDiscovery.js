import { getChannelRecordings } from '../api';

const maxConcurrent = 2;
const queue = [];
let activeRequests = 0;

function aborted() {
  return new DOMException('Recording discovery was cancelled.', 'AbortError');
}

function drainQueue() {
  while (activeRequests < maxConcurrent && queue.length) {
    const task = queue.shift();
    task.signal?.removeEventListener('abort', task.cancel);
    if (task.signal?.aborted) {
      task.reject(aborted());
      continue;
    }

    activeRequests++;
    let response;
    try {
      response = getChannelRecordings(task.channelID, { signal: task.signal });
    } catch (failure) {
      activeRequests--;
      task.reject(failure);
      continue;
    }

    Promise.resolve(response).then(
      value => {
        activeRequests--;
        task.resolve(value);
        drainQueue();
      },
      failure => {
        activeRequests--;
        task.reject(failure);
        drainQueue();
      },
    );
  }
}

// Search cards share a small request budget without retaining recording results.
export function getSearchChannelRecordings(channelID, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(aborted());

  return new Promise((resolve, reject) => {
    const task = { channelID, signal, resolve, reject };
    task.cancel = () => {
      const index = queue.indexOf(task);
      if (index === -1) return;
      queue.splice(index, 1);
      signal.removeEventListener('abort', task.cancel);
      reject(aborted());
    };
    queue.push(task);
    signal?.addEventListener('abort', task.cancel, { once: true });
    drainQueue();
  });
}
