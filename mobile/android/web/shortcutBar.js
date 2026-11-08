// 快捷键栏的自定义：按保存的布局排列常用键，隐藏的键移到「更多」弹层顶部；
// 「终端设置 → 快捷键栏」打开编辑弹层，用开关、长按拖动或上移 / 下移按钮调整，立即生效并保存在手机上。
import {
  defaultKeyLayout,
  isDefaultKeyLayout,
  keyInfo,
  dragTargetIndex,
  moveKey,
  moveKeyTo,
  parseKeyLayout,
  serializeKeyLayout,
  toggleKeyHidden,
  visibleKeys,
} from './keyLayout.js';
import { get, button } from './dom.js';
import { attachDragSort } from './gestures.js';
import { t } from './i18n.js';

export function createShortcutBar({ prefix, onChange }) {
  const storageKey = prefix + 'key-layout';
  const bar = get('special-keys');
  const more = get('more-keys');
  // 按钮节点在栏与「更多」之间移动，事件监听随节点保留。
  const buttons = new Map([...bar.querySelectorAll('[data-key]')].map(item => [item.dataset.key, item]));
  let layout = parseKeyLayout(localStorage.getItem(storageKey));

  function apply() {
    const { bar: shown, overflow } = visibleKeys(layout);
    for (const key of shown) bar.insertBefore(buttons.get(key), more);
    get('overflow-keys').replaceChildren(...overflow.map(key => buttons.get(key)));
    get('overflow-keys-section').hidden = !overflow.length;
    onChange?.();
  }

  function save(next) {
    layout = next;
    try {
      if (isDefaultKeyLayout(layout)) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, serializeKeyLayout(layout));
    } catch { /* 布局只是显示偏好，保存失败时本次仍然生效。 */ }
    apply();
    renderEditor();
  }

  function renderEditor() {
    const list = get('key-layout-list');
    const focused = document.activeElement?.closest?.('[data-layout-key]');
    const focusKey = focused?.dataset.layoutKey;
    const focusRole = document.activeElement?.dataset?.role;
    list.replaceChildren(...layout.order.map((key, index) => {
      const info = keyInfo(key);
      const hidden = layout.hidden.includes(key);
      const row = document.createElement('div');
      row.className = 'key-layout-row';
      row.dataset.layoutKey = key;
      row.dataset.hidden = String(hidden);
      const toggle = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !hidden;
      box.dataset.role = 'toggle';
      box.setAttribute('aria-label', t('在快捷键栏显示 {name}', { name: t(info.name) }));
      box.addEventListener('change', () => save(toggleKeyHidden(layout, key)));
      const cap = document.createElement('span');
      cap.className = 'key-cap';
      cap.textContent = t(info.label);
      const name = document.createElement('span');
      name.className = 'key-name';
      name.textContent = hidden ? t('{name} · 在「更多」中', { name: t(info.name) }) : t(info.name);
      toggle.append(box, cap, name);
      const up = button('icon-button key-move', () => save(moveKey(layout, key, -1)));
      up.textContent = '↑';
      up.dataset.role = 'up';
      up.disabled = index === 0;
      up.setAttribute('aria-label', t('上移 {name}', { name: t(info.name) }));
      const down = button('icon-button key-move', () => save(moveKey(layout, key, 1)));
      down.textContent = '↓';
      down.dataset.role = 'down';
      down.disabled = index === layout.order.length - 1;
      down.setAttribute('aria-label', t('下移 {name}', { name: t(info.name) }));
      row.append(toggle, up, down);
      return row;
    }));
    // 重新渲染后把焦点还给同一个键的同一个控件，便于连续上移 / 下移。
    if (focusKey && focusRole) {
      const target = list.querySelector(`[data-layout-key="${focusKey}"] [data-role="${focusRole}"]`);
      if (target && !target.disabled) target.focus({ preventScroll: true });
      else list.querySelector(`[data-layout-key="${focusKey}"] [data-role="toggle"]`)?.focus({ preventScroll: true });
      list.querySelector(`[data-layout-key="${focusKey}"]`)?.scrollIntoView({ block: 'nearest' });
    }
    get('key-layout-reset').disabled = isDefaultKeyLayout(layout);
  }

  get('open-key-layout').addEventListener('click', () => {
    renderEditor();
    get('key-layout-dialog').showModal();
  });
  get('key-layout-reset').addEventListener('click', () => save(defaultKeyLayout()));
  // 长按行拖动排序；上移 / 下移按钮保留给无障碍与精确微调。
  attachDragSort(get('key-layout-list'), {
    rowSelector: '.key-layout-row',
    ignoreSelector: '.key-move',
    targetIndex: dragTargetIndex,
    onDrop: (row, _from, to) => save(moveKeyTo(layout, row.dataset.layoutKey, to)),
  });

  apply();
  return { layout: () => layout };
}
