// 全屏程序（Codex、opencode 等）开启鼠标上报时的回弹变速滑块。
// 程序内部的滚动位置手机端无从得知，所以滑块不表示位置，只表示速度：
// 按住往上 / 往下拖，离中心越远滚得越快；松手弹回中间并停止。上下箭头各翻一页。
import { t } from './i18n.js';

/** 中心附近不滚动的比例，避免按下时手抖就开始滚。 */
export const JOG_DEADZONE = .1;
/** 最慢 / 最快每秒格数；最快受限，避免电脑端输入和重绘堆积。 */
export const JOG_MIN_RATE = 3;
export const JOG_MAX_RATE = 36;
/** 按住时检查速度并发送滚动的间隔。 */
export const JOG_INTERVAL_MS = 30;

/** 偏移比例（-1..1，负为向上）换算成每秒滚动格数（负为向上），平方曲线：小幅度精确、拉满很快。 */
export function jogRate(ratio) {
  const value = Math.max(-1, Math.min(1, Number(ratio) || 0));
  const magnitude = Math.abs(value);
  if (magnitude < JOG_DEADZONE) return 0;
  const t = (magnitude - JOG_DEADZONE) / (1 - JOG_DEADZONE);
  return Math.sign(value) * (JOG_MIN_RATE + (JOG_MAX_RATE - JOG_MIN_RATE) * t * t);
}

/** 累计 elapsedMs 内应发出的整格数，零头留在 state 里。 */
export function jogTicks(state, ratio, elapsedMs) {
  const rate = jogRate(ratio);
  if (!rate) { state.remainder = 0; return 0; }
  state.remainder += rate * Math.min(100, Math.max(0, elapsedMs)) / 1000;
  const ticks = Math.trunc(state.remainder);
  state.remainder -= ticks;
  return ticks;
}

export function attachTerminalJog(host, { scroll, page, idleMs = 2500 } = {}) {
  const doc = host.ownerDocument;
  const view = doc.defaultView;
  const root = doc.createElement('div');
  root.className = 'terminal-jog';
  root.hidden = true;
  const up = doc.createElement('button');
  up.type = 'button';
  up.className = 'terminal-jog-page';
  up.dataset.direction = 'up';
  up.textContent = '▲';
  up.setAttribute('aria-label', t('向上翻一页'));
  const track = doc.createElement('div');
  track.className = 'terminal-jog-track';
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-label', t('按住上下拖动滚动，松手停止'));
  const knob = doc.createElement('div');
  knob.className = 'terminal-jog-knob';
  track.append(knob);
  const down = up.cloneNode();
  down.dataset.direction = 'down';
  down.textContent = '▼';
  down.setAttribute('aria-label', t('向下翻一页'));
  root.append(up, track, down);
  host.append(root);

  let active = false;
  let drag = null;
  let pump = null;
  let hideTimer = null;
  const state = { remainder: 0 };

  function scheduleHide() {
    view.clearTimeout(hideTimer);
    hideTimer = drag ? null : view.setTimeout(() => { if (!drag) root.hidden = true; }, idleMs);
  }

  /** 显示一段时间后自动隐藏；只有程序开了鼠标上报时才显示。 */
  function reveal() {
    if (!active) return;
    root.hidden = false;
    scheduleHide();
  }

  // 用计时器而不是 requestAnimationFrame：滚动节奏不随画面渲染卡顿而变慢，按实际经过时间换算格数。
  function tick() {
    pump = null;
    if (!drag) return;
    const at = view.performance.now();
    const ticks = jogTicks(state, drag.ratio, at - drag.at);
    drag.at = at;
    if (ticks) scroll?.(ticks);
    pump = view.setTimeout(tick, JOG_INTERVAL_MS);
  }

  function setKnob(offset) {
    knob.style.transform = offset ? `translateY(${offset}px)` : '';
  }

  function grab(event) {
    if (root.hidden || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    // 可拖动距离：轨道半高减去滑块半高。
    const travel = Math.max(1, (track.clientHeight - knob.offsetHeight) / 2);
    drag = { id: event.pointerId, y: event.clientY, travel, ratio: 0, at: view.performance.now() };
    state.remainder = 0;
    root.classList.add('dragging');
    try {
      track.setPointerCapture?.(event.pointerId);
    } catch {
      // 合成事件或指针已抬起时无法捕获，拖动仍按 pointermove 处理。
    }
    view.clearTimeout(hideTimer);
    if (pump === null) pump = view.setTimeout(tick, JOG_INTERVAL_MS);
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    const offset = Math.max(-drag.travel, Math.min(drag.travel, event.clientY - drag.y));
    drag.ratio = offset / drag.travel;
    setKnob(offset);
  }
  function release(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    drag = null;
    view.clearTimeout(pump);
    pump = null;
    state.remainder = 0;
    root.classList.remove('dragging');
    setKnob(0);
    scheduleHide();
  }
  function pageClick(event) {
    event.stopPropagation();
    page?.(event.currentTarget.dataset.direction === 'up' ? -1 : 1);
    reveal();
  }
  // 不让滑块上的触摸落到终端手势（滑动、长按选字、双指缩放）。
  const stop = event => event.stopPropagation();

  track.addEventListener('pointerdown', grab);
  track.addEventListener('pointermove', move);
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);
  up.addEventListener('click', pageClick);
  down.addEventListener('click', pageClick);
  for (const type of ['touchstart', 'touchmove', 'touchend']) root.addEventListener(type, stop, { passive: true });
  for (const type of ['mousedown', 'mouseup', 'click']) root.addEventListener(type, stop);

  return {
    /** 程序是否开着鼠标上报；从关到开时短暂显示，提示可用。 */
    setActive(value) {
      const next = !!value;
      if (next === active) return;
      active = next;
      if (active) reveal();
      else { release(); view.clearTimeout(hideTimer); root.hidden = true; }
    },
    reveal,
    dragging: () => !!drag,
    dispose() {
      release();
      view.clearTimeout(hideTimer);
      root.remove();
    },
  };
}
