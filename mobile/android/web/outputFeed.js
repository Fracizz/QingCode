import { t } from './i18n.js';
import { rpcError } from './nativeRpc.js';

/** 手机没在取帧（切到后台、停在历史快照）时最多缓存几帧，超出就断开，回来后按游标重新接上。 */
export const MAX_QUEUED_FRAMES = 64;

/**
 * 终端输出推送的拉取端：调用方仍按「一次取一帧」的轮询写法调用 next(args)，
 * 只要参数正好接在上一帧之后（同一终端、from 等于上一帧的 next、不要求最新画面），
 * 就直接从已推送的帧里取，不再为每一帧发一次请求；否则断开旧推送，按新参数重新打开。
 *
 * open(args, { onFrame, onEnd }) 打开一条推送并返回取消函数；帧与结束结果同普通请求的 `{ ok, data }`。
 */
export function createOutputFeed(open, { maxQueued = MAX_QUEUED_FRAMES } = {}) {
  let current = null;

  function abortError() {
    return new DOMException(t('请求已取消。'), 'AbortError');
  }

  function close() {
    const stream = current;
    if (!stream) return;
    current = null;
    stream.closed = true;
    stream.cancel?.();
    const waiter = stream.waiter;
    stream.waiter = null;
    waiter?.reject(abortError());
  }

  function deliver(stream, item) {
    if (stream.closed) return;
    const waiter = stream.waiter;
    if (waiter) {
      stream.waiter = null;
      settle(stream, item, waiter);
      return;
    }
    stream.queue.push(item);
    // 没人取帧时不无限缓存：断开后下次 next 从已取到的游标重新打开，电脑端补发或改发最新画面。
    if (stream.queue.length > maxQueued && current === stream) close();
  }

  function settle(stream, item, { resolve, reject }) {
    if (item.frame) {
      const result = item.frame;
      if (!result.ok) {
        if (current === stream) close();
        reject(rpcError(result));
        return;
      }
      stream.received = true;
      const next = result.data?.next;
      if (Number.isFinite(next)) stream.cursor = next;
      resolve(result.data);
      return;
    }
    // 推送结束：出错照常抛给调用方；正常结束（电脑端已发完被断开等答复）则下次重新打开。
    if (current === stream) close();
    const result = item.end;
    if (!result.ok) reject(rpcError(result));
    else if (!stream.received) reject(rpcError({ error: t('电脑端输出推送意外结束。') }));
    // 收到过帧后正常结束：从游标处重新打开，调用方无感。
    else next({ ...stream.args, from: stream.cursor ?? stream.args.from, latest: false }).then(resolve, reject);
  }

  function start(args) {
    const stream = { args, key: keyOf(args), cursor: null, queue: [], waiter: null, closed: false, received: false, cancel: null };
    current = stream;
    stream.cancel = open(args, {
      onFrame: frame => deliver(stream, { frame }),
      onEnd: end => deliver(stream, { end }),
    });
    return stream;
  }

  /** 取下一帧；args 与普通 poll 请求的参数相同。 */
  function next(args) {
    let stream = current;
    if (!stream || stream.key !== keyOf(args) || args.latest || args.from !== stream.cursor) {
      close();
      stream = start(args);
    }
    return new Promise((resolve, reject) => {
      if (stream.queue.length) settle(stream, stream.queue.shift(), { resolve, reject });
      else stream.waiter = { resolve, reject };
    });
  }

  return { next, close, isOpen: () => current !== null };
}

/** 同一终端、同一模式的推送才能续接；lease 电脑端已不再使用，不参与判断。 */
function keyOf({ id, tail, shared, profile }) {
  return JSON.stringify([id, !!tail, !!shared, profile ?? null]);
}
