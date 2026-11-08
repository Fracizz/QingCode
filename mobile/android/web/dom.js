// 页面通用 DOM 工具：元素查找、图标与列表行构建、对话框关闭与确认框。
import { avatarFor } from './protocol.js';
import { t } from './i18n.js';

export const get = id => document.getElementById(id);

/** 重播一次由 class 触发的 CSS 动画，结束后摘掉 class，避免状态变化时再次触发。 */
export function replayAnimation(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
  element.addEventListener('animationend', () => element.classList.remove(className), { once: true });
}

/** 收起列表行再移除，下面的行不会突然跳上来；减少动画或不支持时立即移除。 */
export function collapseAndRemove(row, duration = 160) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced || typeof row.animate !== 'function') { row.remove(); return; }
  const style = getComputedStyle(row);
  row.dataset.leaving = 'true';
  row.style.overflow = 'hidden';
  row.style.pointerEvents = 'none';
  const animation = row.animate([
    { height: row.getBoundingClientRect().height + 'px', marginTop: style.marginTop, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, opacity: 1 },
    { height: '0px', marginTop: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 },
  ], { duration, easing: 'cubic-bezier(.2, 0, 0, 1)', fill: 'forwards' });
  animation.onfinish = animation.oncancel = () => row.remove();
}

let toastTimer;

/** 底部短提示；弹层打开时传入该弹层作为 host，否则会被顶层遮住。 */
export function showToast(host, text) {
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

/** 写入提示文字；空字符串时隐藏元素。 */
export function message(id, value) {
  const target = get(id);
  target.textContent = value ? t(value) : value;
  target.hidden = !value;
}

export function icon(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  svg.append(use);
  return svg;
}

export function rowText(title, subtitle) {
  const text = document.createElement('span');
  text.className = 'row-text';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const small = document.createElement('small');
  small.textContent = subtitle;
  text.append(strong, small);
  return text;
}

export function tile(name) {
  const element = document.createElement('span');
  element.className = 'tile';
  element.append(icon(name));
  return element;
}

export function button(className, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.addEventListener('click', action);
  return element;
}

export function avatar(name) {
  const { initials, hue } = avatarFor(name);
  const element = document.createElement('span');
  element.className = 'avatar';
  element.dataset.hue = String(hue);
  element.textContent = initials;
  element.setAttribute('aria-hidden', 'true');
  return element;
}

/**
 * data-close 按钮关闭对应对话框；点遮罩时仅当按下和抬起都在面板外才取消。
 * canDismiss(dialog) 为假时（例如配对请求进行中）不响应遮罩。
 */
export function setupDialogs(canDismiss = () => true) {
  for (const control of document.querySelectorAll('[data-close]')) {
    control.addEventListener('click', () => get(control.dataset.close).close('cancel'));
  }
  for (const dialog of document.querySelectorAll('dialog')) {
    let backdropDown = false;
    const outside = event => {
      const bounds = dialog.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    dialog.addEventListener('pointerdown', event => { backdropDown = outside(event); });
    dialog.addEventListener('pointerup', event => {
      if (backdropDown && outside(event) && canDismiss(dialog)) dialog.close('cancel');
      backdropDown = false;
    });
  }
}

export function ask(dialog) {
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

export function confirmAction(title, description, action) {
  get('confirm-title').textContent = title;
  get('confirm-text').textContent = description;
  get('confirm-action').textContent = action;
  return ask(get('confirm-dialog'));
}
