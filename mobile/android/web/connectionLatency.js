export const TERMINAL_LATENCY_INTERVAL = 10_000;
export const HOME_LATENCY_INTERVAL = 30_000;

export function latencyText(snapshot) {
  const value = snapshot.milliseconds;
  return value === null ? '--' : value < 1 ? '<1 ms' : Math.round(value) + ' ms';
}

/** One probe in flight across all views; no business request or long poll is timed. */
export function createConnectionLatency({ measure, onChange, doc = document, now = () => Date.now() }) {
  let target = null;
  let interval = HOME_LATENCY_INTERVAL;
  let generation = 0;
  let pending = false;
  let disposed = false;
  let foreground = true;
  let timer = null;
  let expiry = null;
  let snapshot = empty();

  function empty() { return { milliseconds: null, checkedAt: null, state: 'idle' }; }
  function identity(item) { return item ? item.id + '/' + item.fingerprint : null; }
  function visible() { return foreground && !doc.hidden; }
  function notify() { onChange({ ...snapshot }); }
  function stopTimers() {
    clearTimeout(timer);
    clearTimeout(expiry);
    timer = expiry = null;
  }
  function expire() {
    expiry = null;
    if (snapshot.milliseconds === null) return;
    snapshot = { ...snapshot, milliseconds: null, state: 'stale' };
    notify();
  }
  function scheduleExpiry() {
    clearTimeout(expiry);
    if (snapshot.milliseconds !== null) {
      const remaining = snapshot.checkedAt + interval * 3 - now();
      if (remaining <= 0) expire();
      else expiry = setTimeout(expire, remaining);
    }
  }
  async function sample() {
    clearTimeout(timer);
    timer = null;
    if (disposed || !target || pending || !visible() || snapshot.state === 'unsupported') return;
    const current = generation;
    const address = target.id;
    pending = true;
    try {
      const result = await measure(address);
      if (current !== generation || disposed || !visible()) return;
      const value = result?.milliseconds;
      snapshot = result?.supported === false
        ? { milliseconds: null, checkedAt: now(), state: 'unsupported' }
        : { milliseconds: Number.isFinite(value) && value >= 0 ? value : null, checkedAt: now(), state: Number.isFinite(value) && value >= 0 ? 'ready' : 'failed' };
    } catch {
      if (current !== generation || disposed || !visible()) return;
      snapshot = { milliseconds: null, checkedAt: now(), state: 'failed' };
    } finally {
      pending = false;
      if (!disposed && target && visible()) {
        if (current !== generation) { void sample(); }
        else {
          scheduleExpiry();
          notify();
          if (snapshot.state !== 'unsupported') timer = setTimeout(sample, interval);
        }
      }
    }
  }
  function visibilityChanged() {
    generation++;
    stopTimers();
    if (visible()) { scheduleExpiry(); void sample(); }
  }
  doc.addEventListener('visibilitychange', visibilityChanged);
  return {
    getSnapshot: () => ({ ...snapshot }),
    setForeground(value) {
      if (disposed || foreground === value) return;
      foreground = value;
      visibilityChanged();
    },
    setTarget(next, nextInterval = HOME_LATENCY_INTERVAL) {
      if (disposed) return;
      const changed = identity(next) !== identity(target);
      const frequencyChanged = nextInterval !== interval;
      target = next;
      interval = nextInterval;
      if (changed) {
        generation++;
        stopTimers();
        snapshot = empty();
        notify();
      }
      if (!next || !visible() || (!changed && !frequencyChanged)) return;
      clearTimeout(timer);
      scheduleExpiry();
      const age = snapshot.checkedAt === null ? Infinity : now() - snapshot.checkedAt;
      if (age >= interval) void sample();
      else if (snapshot.state !== 'unsupported') timer = setTimeout(sample, interval - age);
    },
    invalidate(id) {
      if (target?.id !== id) return;
      generation++;
      stopTimers();
      snapshot = empty();
      notify();
      if (visible()) void sample();
    },
    dispose() {
      disposed = true;
      generation++;
      stopTimers();
      doc.removeEventListener('visibilitychange', visibilityChanged);
    },
  };
}
