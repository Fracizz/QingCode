// 会话列表的显示状态：「运行中优先」临时排序（点一下排出运行中的会话，再点恢复默认顺序，不保存），
// 以及工作台首页是否显示全部会话（保存在这台手机上）。首页纵览、抽屉「本项目」与「全部」共用，改动后通知各处重绘。
import { t } from './i18n.js';
import { icon } from './dom.js';

const PREFIX = 'qingcode:mobile:';
const HOME_SESSIONS = PREFIX + 'home-sessions';
const listeners = new Set();
const toggles = new Set();

/** fallback：未保存过时的默认值；只在与默认不同时写入。 */
function read(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === 'on' ? true : value === 'off' ? false : fallback;
  } catch { return fallback; }
}

function write(key, on, fallback) {
  try {
    if (on === fallback) localStorage.removeItem(key);
    else localStorage.setItem(key, on ? 'on' : 'off');
  } catch { /* 偏好只影响显示，保存失败时本次仍然生效。 */ }
}

// 临时排序只在本次运行中生效，重开 App 回到电脑端默认顺序。
let runningFirstValue = false;
let homeSessionsValue = read(HOME_SESSIONS, true);

function notify() {
  for (const item of toggles) {
    item.setAttribute('aria-pressed', String(runningFirstValue));
    item.setAttribute('aria-label', runningFirstValue ? t('运行中优先 · 再点恢复默认顺序') : t('运行中优先'));
  }
  for (const listener of listeners) listener();
}

/** 运行中（程序在工作）的会话是否临时排在前面；默认为电脑端顺序。 */
export function runningFirst() { return runningFirstValue; }

export function setRunningFirst(on) {
  if (runningFirstValue === !!on) return;
  runningFirstValue = !!on;
  notify();
}

/** 工作台首页是否显示「全部会话」纵览；默认显示，可在设置中关闭。 */
export function homeSessionsEnabled() { return homeSessionsValue; }

export function setHomeSessionsEnabled(on) {
  if (homeSessionsValue === !!on) return;
  homeSessionsValue = !!on;
  write(HOME_SESSIONS, homeSessionsValue, true);
  notify();
}

let toastTimer = null;

function showSortToast(host, text) {
  let toast = document.getElementById('sort-toast');
  if (!toast) {
    toast = document.createElement('p');
    toast.id = 'sort-toast';
    toast.className = 'sort-toast';
    toast.setAttribute('role', 'status');
  }
  if (toast.parentNode !== host) host.append(toast);
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 1600);
}

export function onSessionPrefsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 「运行中优先」会话气泡图标按钮（「…」表示会话正在进行；与行内运行中的转圈指示区分开）：点一下排出运行中的会话，再点恢复默认顺序；各处实例同步按下状态。 */
export function runningFirstToggle(className = '') {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = ['icon-button', 'running-first', className].filter(Boolean).join(' ');
  item.append(icon('message-more'));
  item.setAttribute('aria-pressed', String(runningFirstValue));
  item.addEventListener('click', () => {
    setRunningFirst(!runningFirstValue);
    // 图标没有文字，点按后用短提示说明当前排序；弹层（会话栏）内显示在弹层里，避免被顶层遮住。
    showSortToast(item.closest('dialog[open]') ?? document.body,
      runningFirstValue ? t('已按运行中优先排序') : t('已恢复默认顺序'));
  });
  toggles.add(item);
  const relabel = () => {
    item.setAttribute('aria-label', runningFirstValue ? t('运行中优先 · 再点恢复默认顺序') : t('运行中优先'));
  };
  relabel();
  return { element: item, relabel };
}
