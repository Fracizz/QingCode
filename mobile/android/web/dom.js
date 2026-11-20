// 页面通用 DOM 工具：元素查找、图标与列表行构建、对话框关闭与确认框。
import { avatarFor } from './protocol.js';
import { t } from './i18n.js';
import { reducedMotion } from './motion.js';

export const get = id => document.getElementById(id);

/** 重播一次由 class 触发的 CSS 动画，结束后摘掉 class，避免状态变化时再次触发。 */
export function replayAnimation(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
  element.addEventListener('animationend', () => element.classList.remove(className), { once: true });
}

/** 收起列表行再移除，下面的行不会突然跳上来；减少动画或不支持时立即移除。 */
export function collapseAndRemove(row, duration = 220) {
  const reduced = reducedMotion();
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

/** 底部短提示；弹层打开时传入该弹层作为 host，否则会被顶层遮住。duration 为显示毫秒数。 */
export function showToast(host, text, duration = 1600) {
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
  toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

/** 写入提示文字；空字符串时隐藏元素。 */
/** 文字没变就不写：列表定时刷新时整行重写会触发重排和重绘，侧栏滑动途中尤其明显。 */
export function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

export function message(id, value) {
  const target = get(id);
  target.textContent = value ? t(value) : value;
  target.hidden = !value;
}

/**
 * 组头来源：连接名 / WSL / 本机做成按种类分色的小标签（与电脑端终端列表同色），
 * 其后的补充说明（当前项目、电脑端已移除）保持普通辅助文字，与标签之间用间距而非「·」分隔。
 */
export function fillProjectSource(target, project, place, extras = []) {
  target.replaceChildren();
  if (place) {
    const chip = document.createElement('span');
    chip.className = 'project-source-chip';
    chip.dataset.kind = ['ssh', 'wsl'].includes(project?.kind) ? project.kind : 'local';
    chip.textContent = place;
    target.append(chip);
  }
  const rest = extras.filter(Boolean);
  if (!rest.length) return;
  // 说明文字单独一段，窄屏时先省略它，来源标签保持完整。
  // 标签自带边框已能分隔，二者间距由容器 gap 提供；flex 子项开头的空格会被吞掉，「·」会贴住标签。
  const note = document.createElement('span');
  note.className = 'project-source-note';
  note.textContent = rest.join(' · ');
  target.append(note);
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
