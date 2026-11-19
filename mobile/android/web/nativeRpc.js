import { t } from './i18n.js';

export function isRemoteSshDisconnect(error) {
  return error.message === 'SSH 连接失败：Disconnected' || error.message?.startsWith('SSH 握手期间连接已断开（');
}

export function terminalErrorMessage(error) {
  return isRemoteSshDisconnect(error)
    ? t('电脑到远端的 SSH 连接在握手时断开，请在电脑端检查 SSH 连接后重试。')
    : t(error.message);
}

/** Show the actual failure while reconnecting; a changed identity needs user action. */
export function connectionFailure(error) {
  const identity = error.code === 'identity' || error.message === 'Windows 身份校验失败，请重新核对证书指纹。';
  return {
    retry: !identity,
    message: identity ? t('电脑身份校验失败，请重新扫码或粘贴配对链接。')
      : [t(error.message || '连接失败。'), t('正在自动重连…')].join(' '),
  };
}

/** 原生失败结果转成 Error，保留吊销、不支持与错误码标记。 */
export function rpcError(result) {
  const error = new Error(result.error || t('连接失败。'));
  error.revoked = result.revoked === true;
  error.unsupported = result.unsupported === true;
  error.code = result.code;
  return error;
}

/** One native request, one result. Expired writes are never retried. */
export function createNativeRpc(native, { timers = globalThis } = {}) {
  const requests = new Map();
  let sequence = 0;
  function receive(id, result) {
    const request = requests.get(id);
    if (!request) return;
    requests.delete(id);
    timers.clearTimeout(request.timer);
    request.cleanup();
    if (result.ok) request.resolve(result.data);
    else request.reject(rpcError(result));
  }
  const streams = new Map();
  /**
   * 原生输出推送：一个请求持续收到多帧，每帧与普通请求的结果同形（`{ ok, data }` / `{ ok: false, error }`）。
   * onEnd(result) 只回调一次；返回的函数用于取消（取消后不再回调）。
   */
  function stream(op, args, { onFrame, onEnd }) {
    const id = ++sequence;
    streams.set(id, { onFrame, onEnd });
    try { native.stream(id, JSON.stringify({ op, ...args })); }
    catch (error) {
      streams.delete(id);
      timers.setTimeout(() => onEnd({ ok: false, error: error?.message || t('连接失败。') }), 0);
    }
    return () => {
      if (!streams.delete(id)) return;
      try { native.cancel?.(id); } catch { /* cancellation remains best effort */ }
    };
  }
  function receiveStream(id, frame) { streams.get(id)?.onFrame(frame); }
  function endStream(id, result) {
    const entry = streams.get(id);
    if (!entry) return;
    streams.delete(id);
    entry.onEnd(result);
  }
  function request(op, args = {}, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException(t('请求已取消。'), 'AbortError')); return; }
      const id = ++sequence;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const abort = () => {
        const pending = requests.get(id);
        if (!pending) return;
        requests.delete(id);
        timers.clearTimeout(pending.timer);
        cleanup();
        try { native.cancel?.(id); } catch { /* cancellation remains best effort */ }
        reject(new DOMException(t('请求已取消。'), 'AbortError'));
      };
      // Permissions and the system picker wait for the user. Network and decode
      // deadlines are slightly longer than the native queue's whole-job deadline.
      const timeout = ['pick_image', 'camera'].includes(op) ? 0
        : ['create', 'image', 'read_image', 'agent_create', 'agent_send', 'agent_image'].includes(op) ? 120_000
          : ['file_list', 'file_search', 'file_stat'].includes(op) ? 120_000
          : op === 'agent_usage' ? 75_000 : op === 'latency' ? 8_000 : 45_000;
      const timer = timeout ? timers.setTimeout(() => {
        const pending = requests.get(id);
        if (!pending) return;
        requests.delete(id);
        cleanup();
        try { native.cancel?.(id); } catch { /* old bridges may not expose cancellation */ }
        const read = ['profiles', 'probe', 'projects', 'capabilities', 'sessions', 'poll', 'history', 'attention', 'terminal_profiles', 'shortcut_keys', 'file_list', 'file_search', 'file_stat', 'latency'].includes(op);
        const error = new Error(read ? t('读取超时，请检查网络或电脑端连接。') : t('请求超时，操作结果未知，请核对电脑端；不会自动重发。'));
        error.code = 'timeout';
        reject(error);
      }, timeout) : null;
      requests.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try { native.request(id, JSON.stringify({ op, ...args })); }
      catch (error) { requests.delete(id); timers.clearTimeout(timer); cleanup(); reject(error); }
    });
  }
  return { request, receive, stream, receiveStream, endStream, canStream: typeof native.stream === 'function' };
}
