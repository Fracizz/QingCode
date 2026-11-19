import { splitInput } from './protocol.js';

/** Serialize each input group, including its delayed Enter, with bounded buffering. */
export function createTerminalInput({ write, isCurrent, onSuccess, onError, timers = globalThis }) {
  let buffered = '';
  let callbacks = [];
  let target = null;
  let timer = null;
  let queued = 0;
  let chain = Promise.resolve();

  function flush(enter = '') {
    timers.clearTimeout(timer);
    timer = null;
    const data = buffered;
    const destination = target;
    const completions = callbacks;
    buffered = ''; callbacks = []; target = null;
    if (!data || !destination) { completions.forEach(done => done('unknown')); return; }
    schedule(splitInput(data), destination, completions, { enter });
  }

  /** 串行写入各片段；gap > 0 时片段之间留间隔，避免被对端合并成一次读取。 */
  function schedule(parts, destination, completions, { enter = '', gap = 0 } = {}) {
    const length = parts.reduce((sum, part) => sum + part.length, 0) + enter.length;
    queued += length;
    chain = chain.then(async () => {
      const finish = state => completions.forEach(done => done(state));
      try {
        for (const [index, part] of parts.entries()) {
          if (index > 0 && gap > 0) await new Promise(resolve => timers.setTimeout(resolve, gap));
          if (!isCurrent(destination)) { finish('unknown'); return; }
          await write(destination, part);
        }
        if (enter) {
          await new Promise(resolve => timers.setTimeout(resolve, 250));
          if (!isCurrent(destination)) { finish('unknown'); return; }
          await write(destination, enter);
        }
        finish('received');
        if (isCurrent(destination)) onSuccess();
      } catch (error) {
        finish('unknown');
        if (isCurrent(destination)) onError(error);
      } finally { queued -= length; }
    });
  }

  function enqueue(value, destination, { enter = '', onComplete } = {}) {
    if (queued + buffered.length + value.length + enter.length > 32_768) return false;
    if (buffered && (enter || target?.id !== destination.id || target?.epoch !== destination.epoch
      || target?.address !== destination.address)) flush();
    buffered += value;
    target = destination;
    if (onComplete) callbacks.push(onComplete);
    if (enter) flush(enter);
    else if (timer === null) timer = timers.setTimeout(flush, 22);
    return true;
  }
  /**
   * 按键片段逐次单独写入（不与其它输入合并缓冲）：清除输入等长按键序列一次写入时，
   * Windows ConPTY 会合并读取，Claude Code 等 AI CLI 会整体忽略。
   */
  function enqueueKeys(parts, destination, { gap = 5, onComplete } = {}) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    if (!length || queued + buffered.length + length > 32_768) return false;
    flush();
    schedule(parts, destination, onComplete ? [onComplete] : [], { gap });
    return true;
  }
  return { enqueue, enqueueKeys, flush };
}
