// 界面动效辅助（见 ../design.md「动效」）：减少动画判断与工作台页面切换方向。
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
