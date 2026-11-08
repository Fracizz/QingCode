// 会话列表的显示偏好（只保存在这台手机上）：运行中优先排序、工作台首页显示全部会话。
// 首页纵览、抽屉「本项目」与「全部」共用同一份偏好，改动后通知各处重绘。
import { t } from './i18n.js';

const PREFIX = 'qingcode:mobile:';
const RUNNING_FIRST = PREFIX + 'sessions-running-first';
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

let runningFirstValue = read(RUNNING_FIRST, false);
let homeSessionsValue = read(HOME_SESSIONS, true);

function notify() {
  for (const box of toggles) box.checked = runningFirstValue;
  for (const listener of listeners) listener();
}

/** 运行中（程序在工作）的会话是否排在前面；默认关闭，保持电脑端顺序。 */
export function runningFirst() { return runningFirstValue; }

export function setRunningFirst(on) {
  if (runningFirstValue === !!on) return;
  runningFirstValue = !!on;
  write(RUNNING_FIRST, runningFirstValue, false);
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

export function onSessionPrefsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 「运行中优先」勾选框：各处实例保持同步；文案在 relabel() 时按当前语言刷新。 */
export function runningFirstToggle(className = '') {
  const label = document.createElement('label');
  label.className = ['running-first', className].filter(Boolean).join(' ');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = runningFirstValue;
  box.addEventListener('change', () => setRunningFirst(box.checked));
  const text = document.createElement('span');
  label.append(box, text);
  toggles.add(box);
  const relabel = () => { text.textContent = t('运行中优先'); };
  relabel();
  return { element: label, relabel };
}
