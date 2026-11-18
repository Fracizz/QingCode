// 界面动效辅助（见 ../design.md「动效」）：列表行涟漪、工作台页面切换方向、进入终端时标题从点按处飞到顶栏。
// 只动画 transform / opacity 与背景层；系统开启「减少动画」时全部跳过，CSS 侧同样关闭。

/** 底部导航顺序，决定页面从哪一侧滑入。 */
export const PAGE_ORDER = ['home', 'project', 'connection'];

/** 整行可点的列表项：按下时从触点扩散涟漪。小按钮仍用缩放回弹，不在这里。 */
export const RIPPLE_TARGETS = '.row, .resume-card, .session-group-open, .project-open, .connection-main, .setting-row[data-tappable], .select-option, .session-shortcuts > button';

/** 标题飞入的取样时限：点按后这段时间内进入终端才算「从这一行打开」。 */
const FLY_MAX_AGE = 800;

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

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

/** 涟漪需要覆盖整块元素：取触点到四个角的最远距离。 */
export function rippleRadius(x, y, width, height) {
  return Math.ceil(Math.hypot(Math.max(x, width - x), Math.max(y, height - y)));
}

let lastPress = null;

/** 在文档上监听按下：给整行列表项播放涟漪，并记住最近一次点按位置供标题飞入取样。 */
export function attachRipples(root = document) {
  root.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const element = event.target instanceof Element ? event.target : null;
    // 按下时就记下标题位置：项目列表可能在松手前整表重建，事后再找节点会落空。
    lastPress = element ? { title: titleOf(element), time: performance.now() } : null;
    const target = element?.closest(RIPPLE_TARGETS);
    if (!target || target.disabled || reducedMotion()) return;
    const rect = target.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    target.style.setProperty('--ripple-x', `${Math.round(x)}px`);
    target.style.setProperty('--ripple-y', `${Math.round(y)}px`);
    target.style.setProperty('--ripple-size', `${rippleRadius(x, y, rect.width, rect.height)}px`);
    target.classList.remove('rippling');
    void target.offsetWidth;
    target.classList.add('rippling');
  }, { capture: true, passive: true });
  // 子元素的动画结束事件也会冒泡上来，只认自己的涟漪。
  root.addEventListener('animationend', event => {
    if (event.animationName === 'ripple' && event.target instanceof Element) event.target.classList.remove('rippling');
  }, true);
}

/** 点按处所在行的标题位置；不在可打开的行上时为 null。 */
function titleOf(element) {
  const host = element.closest('.session-option, .project-row, .resume-card, .session-group, .row');
  const title = host?.querySelector('.session-label, .project-heading strong, .row-text strong, .session-group-head strong');
  if (!title) return null;
  const rect = title.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { rect, fontSize: parseFloat(getComputedStyle(title).fontSize) || 0 };
}

/**
 * 刚才点按的那一行的标题位置，供进入终端时的标题飞入使用；点按太久之前或不在列表行上时返回 null。
 * @returns {{ rect: DOMRect, fontSize: number } | null}
 */
export function pressedTitle() {
  if (!lastPress || performance.now() - lastPress.time > FLY_MAX_AGE) return null;
  const { title } = lastPress;
  lastPress = null;
  return title;
}

/**
 * 让顶栏标题从列表中的位置平移、缩放到自身位置（FLIP）。只改 transform，不影响终端行列测量；
 * 飞行途中临时抬高层级，避免被下方的终端输出区盖住。
 */
export function flyFrom(origin, element) {
  if (!origin || !element || reducedMotion() || typeof element.animate !== 'function') return;
  const target = element.getBoundingClientRect();
  const size = parseFloat(getComputedStyle(element).fontSize);
  if (!target.width || !size) return;
  const scale = origin.fontSize ? origin.fontSize / size : 1;
  const dx = origin.rect.left - target.left;
  const dy = origin.rect.top - target.top;
  element.style.position = 'relative';
  element.style.zIndex = '10';
  element.style.transformOrigin = 'left top';
  const animation = element.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: .4 },
    { transform: 'none', opacity: 1 },
  ], { duration: 320, easing: 'cubic-bezier(.05, .7, .1, 1)' });
  animation.onfinish = animation.oncancel = () => {
    element.style.removeProperty('position');
    element.style.removeProperty('z-index');
    element.style.removeProperty('transform-origin');
  };
}
