import { splitInput } from './protocol.js';

// Keep a short burst of complete xterm reports while the previous write is in flight.
const MAX_PENDING_WHEEL_TICKS = 6;
const MAX_QUEUED_INPUT = 32_768;

function sameTarget(a, b) {
  return a.id === b.id && a.address === b.address && a.epoch === b.epoch && a.lease === b.lease;
}

/** Serialize each input group, including its delayed Enter, with bounded buffering. */
export function createTerminalInput({ write, isCurrent, onSuccess, onError, timers = globalThis }) {
  let buffered = '';
  let callbacks = [];
  let target = null;
  let timer = null;
  let queued = 0;
  let pendingWheel = null;
  let chain = Promise.resolve();

  function flush(enter = '') {
    pendingWheel = null;
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
  function schedule(parts, destination, completions, { enter = '', gap = 0, wheel = false } = {}) {
    const size = () => parts.reduce((sum, part) => sum + part.length, enter.length);
    queued += size();
    chain = chain.then(async () => {
      if (pendingWheel?.reports === parts) pendingWheel = null;
      const length = size();
      const chunks = wheel ? [parts.join('')] : parts;
      const finish = state => completions.forEach(done => done(state));
      try {
        for (const [index, part] of chunks.entries()) {
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
    if (queued + buffered.length + value.length + enter.length > MAX_QUEUED_INPUT) return false;
    pendingWheel = null;
    if (buffered && (enter || !sameTarget(target, destination))) flush();
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
    if (!length || queued + buffered.length + length > MAX_QUEUED_INPUT) return false;
    flush();
    schedule(parts, destination, onComplete ? [onComplete] : [], { gap });
    return true;
  }
  // Only consecutive scroll reports may share a write. Text, clicks and explicit
  // key sequences seal the preceding batch in its original place in the chain.
  function enqueueWheel(report, direction, destination) {
    if (!pendingWheel || !sameTarget(pendingWheel.destination, destination)) {
      flush();
      if (queued + report.length > MAX_QUEUED_INPUT) return false;
      const reports = [report];
      pendingWheel = { reports, direction, destination };
      schedule(reports, destination, [], { wheel: true });
      return true;
    }
    const { reports } = pendingWheel;
    let discard = Math.max(0, reports.length + 1 - MAX_PENDING_WHEEL_TICKS);
    if (direction !== pendingWheel.direction) discard = reports.length;
    const removed = reports.slice(0, discard).reduce((sum, part) => sum + part.length, 0);
    if (queued - removed + report.length > MAX_QUEUED_INPUT) return false;
    reports.splice(0, discard);
    queued -= removed;
    pendingWheel.direction = direction;
    reports.push(report);
    queued += report.length;
    return true;
  }
  return { enqueue, enqueueKeys, enqueueWheel, flush };
}
