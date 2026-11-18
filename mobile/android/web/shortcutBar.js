// 快捷键栏的自定义：按保存的布局排列常用键，隐藏的键移到「更多」弹层顶部；
// 「终端设置 → 快捷键栏」打开编辑弹层，用开关、长按拖动或上移 / 下移按钮调整，立即生效并保存在手机上。
// 自定义键（键名 + 发送的文本）在同一列表中排序和隐藏，按钮为 data-key="custom"，按下由 app.js 委托处理。
import {
  CUSTOM_KEY_LIMIT,
  customKeyDetail,
  customKeyLabel,
  defaultKeyLayout,
  findCustomKey,
  isCustomKey,
  isDefaultKeyLayout,
  keyInfo,
  dragTargetIndex,
  moveKey,
  moveKeyTo,
  newCustomKeyId,
  normalizeCustomKey,
  parseKeyLayout,
  removeCustomKey,
  saveCustomKey,
  serializeKeyLayout,
  toggleKeyHidden,
  visibleKeys,
} from './keyLayout.js';
import { get, button, icon, confirmAction } from './dom.js';
import { attachDragSort } from './gestures.js';
import { t } from './i18n.js';

export function createShortcutBar({ prefix, onChange }) {
  const storageKey = prefix + 'key-layout';
  const bar = get('special-keys');
  const more = get('more-keys');
  // 按钮节点在栏与「更多」之间移动，事件监听随节点保留。
  const buttons = new Map([...bar.querySelectorAll('[data-key]')].map(item => [item.dataset.key, item]));
  let layout = parseKeyLayout(localStorage.getItem(storageKey));
  let editing = null;

  /** 自定义键的按钮：每次按布局重建，按下由 app.js 在栏和「更多」上委托处理。 */
  function customButton(key) {
    const def = findCustomKey(layout, key);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'custom-key';
    item.dataset.key = 'custom';
    item.dataset.customId = def.id;
    // 名称来自用户输入，不参与页面翻译。
    item.dataset.i18nSkip = '';
    item.textContent = customKeyLabel(def);
    item.setAttribute('aria-label', t('发送 {name}', { name: customKeyDetail(def) }));
    return item;
  }

  function keyButton(key) {
    return isCustomKey(key) ? customButton(key) : buttons.get(key);
  }

  function apply() {
    for (const stale of document.querySelectorAll('#special-keys [data-key="custom"], #overflow-keys [data-key="custom"]')) stale.remove();
    const { bar: shown, overflow } = visibleKeys(layout);
    // 收起按钮排在常用键之后（展开时才在栏内，见 renderShortcutVisibility）。
    const end = bar.querySelector('#toggle-keys') ?? more;
    for (const key of shown) bar.insertBefore(keyButton(key), end);
    get('overflow-keys').replaceChildren(...overflow.map(keyButton));
    get('overflow-keys-section').hidden = !overflow.length;
    onChange?.();
  }

  function save(next) {
    layout = next;
    try {
      if (!layout.custom.length && isDefaultKeyLayout(layout)) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, serializeKeyLayout(layout));
    } catch { /* 布局只是显示偏好，保存失败时本次仍然生效。 */ }
    apply();
    renderEditor();
  }

  function keyCap(key) {
    const cap = document.createElement('span');
    cap.className = 'key-cap';
    const def = findCustomKey(layout, key);
    if (def) {
      cap.dataset.i18nSkip = '';
      cap.textContent = customKeyLabel(def);
      return cap;
    }
    const info = keyInfo(key);
    if (info.icon) cap.append(icon(info.icon), info.iconText ?? '');
    else cap.textContent = t(info.label);
    return cap;
  }

  function keyName(key) {
    const def = findCustomKey(layout, key);
    return def ? (def.name || customKeyDetail(def)) : t(keyInfo(key).name);
  }

  function renderEditor() {
    const list = get('key-layout-list');
    const focused = document.activeElement?.closest?.('[data-layout-key]');
    const focusKey = focused?.dataset.layoutKey;
    const focusRole = document.activeElement?.dataset?.role;
    list.replaceChildren(...layout.order.map((key, index) => {
      const def = findCustomKey(layout, key);
      const label = keyName(key);
      const hidden = layout.hidden.includes(key);
      const row = document.createElement('div');
      row.className = 'key-layout-row';
      row.dataset.layoutKey = key;
      row.dataset.hidden = String(hidden);
      if (def) row.dataset.custom = '';
      const toggle = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !hidden;
      box.dataset.role = 'toggle';
      box.setAttribute('aria-label', t('在快捷键栏显示 {name}', { name: label }));
      box.addEventListener('change', () => save(toggleKeyHidden(layout, key)));
      const name = document.createElement('span');
      name.className = 'key-name';
      if (def) name.dataset.i18nSkip = '';
      name.textContent = hidden ? t('{name} · 在「更多」中', { name: label }) : label;
      // 有名称的自定义键另起一行显示实际发送的内容。
      if (def?.name) {
        const detail = document.createElement('span');
        detail.className = 'key-detail';
        detail.textContent = customKeyDetail(def);
        name.append(detail);
      }
      toggle.append(box, keyCap(key), name);
      const up = button('icon-button key-move', () => save(moveKey(layout, key, -1)));
      up.append(icon('arrow-up'));
      up.dataset.role = 'up';
      up.disabled = index === 0;
      up.setAttribute('aria-label', t('上移 {name}', { name: label }));
      const down = button('icon-button key-move', () => save(moveKey(layout, key, 1)));
      down.append(icon('arrow-down'));
      down.dataset.role = 'down';
      down.disabled = index === layout.order.length - 1;
      down.setAttribute('aria-label', t('下移 {name}', { name: label }));
      row.append(toggle);
      if (def) {
        const edit = button('icon-button key-move', () => openCustomKey(def));
        edit.append(icon('edit'));
        edit.dataset.role = 'edit';
        edit.setAttribute('aria-label', t('编辑 {name}', { name: label }));
        row.append(edit);
      }
      row.append(up, down);
      return row;
    }));
    // 重新渲染后把焦点还给同一个键的同一个控件，便于连续上移 / 下移。
    if (focusKey && focusRole) {
      const target = list.querySelector(`[data-layout-key="${CSS.escape(focusKey)}"] [data-role="${focusRole}"]`);
      if (target && !target.disabled) target.focus({ preventScroll: true });
      else list.querySelector(`[data-layout-key="${CSS.escape(focusKey)}"] [data-role="toggle"]`)?.focus({ preventScroll: true });
      list.querySelector(`[data-layout-key="${CSS.escape(focusKey)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
    get('key-layout-reset').disabled = isDefaultKeyLayout(layout);
    get('key-layout-add').disabled = layout.custom.length >= CUSTOM_KEY_LIMIT;
  }

  // ---- 自定义键编辑弹层 ----
  function openCustomKey(def) {
    editing = def;
    get('custom-key-title').textContent = def ? t('编辑自定义键') : t('添加自定义键');
    get('custom-key-text').value = def?.text ?? '';
    get('custom-key-enter').checked = def?.enter ?? true;
    get('custom-key-name').value = def?.name ?? '';
    get('custom-key-error').hidden = true;
    get('custom-key-delete').hidden = !def;
    get('custom-key-dialog').showModal();
  }

  get('custom-key-form').addEventListener('submit', event => {
    event.preventDefault();
    const def = normalizeCustomKey({
      id: editing?.id ?? newCustomKeyId(layout),
      name: get('custom-key-name').value,
      text: get('custom-key-text').value,
      enter: get('custom-key-enter').checked,
    });
    const error = get('custom-key-error');
    if (!def) {
      error.textContent = t('请输入要发送的文本，不能包含换行。');
      error.hidden = false;
      return;
    }
    if (!editing && layout.custom.length >= CUSTOM_KEY_LIMIT) {
      error.textContent = t('自定义键最多 {n} 个。', { n: CUSTOM_KEY_LIMIT });
      error.hidden = false;
      return;
    }
    get('custom-key-dialog').close();
    save(saveCustomKey(layout, def));
  });

  get('custom-key-delete').addEventListener('click', async () => {
    const def = editing;
    if (!def) return;
    get('custom-key-dialog').close();
    if (!await confirmAction(t('删除自定义键「{name}」？', { name: customKeyLabel(def) }), t('删除后可以再次添加。'), t('删除'))) return;
    save(removeCustomKey(layout, def.id));
  });

  get('open-key-layout').addEventListener('click', () => {
    renderEditor();
    get('key-layout-dialog').showModal();
  });
  get('key-layout-add').addEventListener('click', () => openCustomKey(null));
  get('key-layout-reset').addEventListener('click', () => save(defaultKeyLayout(layout.custom)));
  // 长按行拖动排序；上移 / 下移按钮保留给无障碍与精确微调。
  attachDragSort(get('key-layout-list'), {
    rowSelector: '.key-layout-row',
    ignoreSelector: '.key-move',
    targetIndex: dragTargetIndex,
    onDrop: (row, _from, to) => save(moveKeyTo(layout, row.dataset.layoutKey, to)),
  });

  apply();
  return {
    layout: () => layout,
    /** 按 id 取当前的自定义键定义（按钮可能早于布局变化被按下）。 */
    customKey: id => findCustomKey(layout, id),
  };
}
