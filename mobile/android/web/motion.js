// 界面动效辅助（见 ../design.md「动效」）：减少动画判断、工作台页面切换方向与整屏切换的退出快照。
// 动效本身都在 app.css；这里只放需要 JS 判断的部分。

/** 底部导航顺序，决定页面从哪一侧滑入。 */
export const PAGE_ORDER = ['home', 'project', 'connection'];

/** 系统「移除动画」或应用内「界面动效 → 减少动效」任一开启即减少。 */
export const reducedMotion = () => document.documentElement.dataset.motion === 'reduce'
  || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * 工作台页面切换方向：按导航顺序向右为 forward、向左为 back；首次进入、从终端返回或同一页为 none（原地淡入）。
 * @param {string | null} from 切换前正在显示的页面，工作台被隐藏时传 null
 * @param {string} to 目标页面
 */
export function pageDirection(from, to) {
  const a = PAGE_ORDER.indexOf(from);
  const b = PAGE_ORDER.indexOf(to);
  if (a < 0 || b < 0 || a === b) return 'none';
  return b > a ? 'forward' : 'back';
}

/**
 * 整屏切换（工作台页面、工作台⇄终端）：支持视图过渡时先给旧画面拍快照，快照按 direction 反方向轻移淡出（app.css ::view-transition-old），
 * 新画面照常播放自己的入场；不支持、减少动效或页面在后台时直接同步切换。
 * update 只负责按最新意图摆放画面，晚到的回调重复执行也无副作用。
 * @param {() => void} update 摆放新画面
 * @param {'forward' | 'back' | 'none'} direction 新画面相对旧画面的层级方向
 * @returns {Promise<void>} 新画面已摆好（DOM 已切换）
 */
export function swapScreen(update, direction = 'none') {
  const root = document.documentElement;
  if (typeof document.startViewTransition !== 'function' || reducedMotion() || document.visibilityState === 'hidden') {
    update();
    return Promise.resolve();
  }
  rescueTaps();
  root.dataset.screenExit = direction;
  return new Promise(resolve => {
    let placed = false;
    let guard = 0;
    const place = () => {
      if (placed) return;
      placed = true;
      clearTimeout(guard);
      try { update(); } finally { resolve(); }
    };
    const transition = document.startViewTransition(place);
    current = transition;
    transition.finished.catch(() => {}).finally(() => { if (current === transition) { delete root.dataset.screenExit; current = null; } });
    // 快照要等下一次渲染；WebView 卡帧或被节流时不能让切换跟着卡住：超时直接摆放并跳过这次过渡。
    guard = setTimeout(() => { place(); transition.skipTransition(); }, SWAP_GUARD_MS);
  });
}
const SWAP_GUARD_MS = 120;
let current = null;
let rescuing = false;

/**
 * 视图过渡进行中浏览器把点按都交给 html（快照层设 pointer-events: none 也一样），快速连点会丢一下。
 * 按下时若正在过渡且落在 html 上，立即结束过渡；松手后的 click 改投到手指下的真实元素（新画面早已摆好）。
 */
function rescueTaps() {
  if (rescuing) return;
  rescuing = true;
  const root = document.documentElement;
  let pending = false;
  document.addEventListener('pointerdown', event => {
    pending = !!current && event.target === root;
    if (pending) current.skipTransition();
  }, true);
  document.addEventListener('click', event => {
    if (!pending) return;
    pending = false;
    if (event.target !== root) return;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    if (!hit || hit === root) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = hit.closest('button, a, label, summary, input, select, textarea, [role="button"]') ?? hit;
    if (typeof target.focus === 'function' && target.matches('input, select, textarea')) target.focus();
    target.click();
  }, true);
}
