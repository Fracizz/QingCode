import { t } from './i18n.js';
/** One native request, one result. Expired writes are never retried. */
export function createNativeRpc(native, { timers = globalThis } = {}) {
  const requests = new Map();
  let sequence = 0;
  function receive(id, result) {
    const request = requests.get(id);
    if (!request) return;
    requests.delete(id);
    timers.clearTimeout(request.timer);
    if (result.ok) request.resolve(result.data);
    else {
      const error = new Error(result.error || t('连接失败。'));
      error.revoked = result.revoked === true;
      error.unsupported = result.unsupported === true;
      request.reject(error);
    }
  }
  function request(op, args = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      // Permissions and the system picker wait for the user. Network and decode
      // deadlines are slightly longer than the native queue's whole-job deadline.
      const timeout = ['pick_image', 'camera'].includes(op) ? 0
        : ['create', 'image', 'read_image', 'agent_create', 'agent_send', 'agent_image'].includes(op) ? 120_000
          : op === 'agent_usage' ? 75_000 : op === 'latency' ? 8_000 : 45_000;
      const timer = timeout ? timers.setTimeout(() => {
        const pending = requests.get(id);
        if (!pending) return;
        requests.delete(id);
        try { native.cancel?.(id); } catch { /* old bridges may not expose cancellation */ }
        reject(new Error(t('请求超时，操作结果未知，请核对电脑端；不会自动重发。')));
      }, timeout) : null;
      requests.set(id, { resolve, reject, timer });
      try { native.request(id, JSON.stringify({ op, ...args })); }
      catch (error) { requests.delete(id); timers.clearTimeout(timer); reject(error); }
    });
  }
  return { request, receive };
}
