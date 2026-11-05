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
    const length = data.length + enter.length;
    queued += length;
    chain = chain.then(async () => {
      const finish = state => completions.forEach(done => done(state));
      try {
        for (const part of splitInput(data)) {
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
  return { enqueue, flush };
}
