// 用项目样式替代系统下拉：<select> 只保留值和 change 事件，外观和选择都由自绘控件负责。
// data-control="switch" 的 on / off 选项渲染为开关；其余渲染为触发按钮和共用选择面板，data-control="value" 时触发按钮只显示选项主文案。
import { get, icon, rowText } from './dom.js';

const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

function titleOf(select) {
  return select.labels?.[0]?.textContent.trim() || select.getAttribute('aria-label') || '';
}

/** 把 select 收进自绘控件：程序赋值、语言切换和 disabled 变化都通过 sync 刷新外观。 */
function mount(select, control, sync) {
  const field = document.createElement('div');
  field.className = 'select-field';
  // 文字跟随当前选项，翻译只作用在 <option> 上，避免重复翻译。
  control.dataset.i18nSkip = '';
  if (select.hasAttribute('aria-describedby')) control.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
  select.replaceWith(field);
  field.append(select, control);
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  // 程序直接赋值不会触发 change，这里同步显示。
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return nativeValue.get.call(this); },
    set(next) { nativeValue.set.call(this, next); sync(); },
  });
  select.addEventListener('change', sync);
  // 点 <label> 只会聚焦隐藏的 select，转交给可见控件。
  select.addEventListener('focus', () => control.focus({ preventScroll: true }));
  new MutationObserver(sync).observe(select, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
  // 设置行整行可点；<label> 激活时派发给 select 的合成点击不再触发一次。
  field.closest('[data-tappable]')?.addEventListener('click', event => {
    if (!control.contains(event.target) && event.target !== select) control.click();
  });
  sync();
}

function mountSwitch(select) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'switch';
  toggle.setAttribute('role', 'switch');
  toggle.addEventListener('click', () => {
    select.value = select.value === 'on' ? 'off' : 'on';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  mount(select, toggle, () => {
    toggle.setAttribute('aria-checked', String(select.value === 'on'));
    toggle.setAttribute('aria-label', titleOf(select));
    toggle.disabled = select.disabled;
  });
}

export function setupSelectMenus() {
  const dialog = get('select-dialog');
  const list = get('select-options');
  let openTrigger = null;

  function open(select, trigger) {
    get('select-dialog-title').textContent = titleOf(select);
    list.setAttribute('aria-label', titleOf(select));
    list.replaceChildren(...Array.from(select.options, option => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'select-option';
      row.disabled = option.disabled;
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', String(option.selected));
      // 「原图 · 不压缩」这类文案拆成主次两行，便于快速扫读。
      const [main, ...detail] = option.textContent.trim().split(' · ');
      row.append(rowText(main, detail.join(' · ')), icon('check'));
      row.addEventListener('click', () => {
        dialog.close('confirm');
        if (select.value === option.value) return;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return row;
    }));
    openTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    dialog.showModal();
    list.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  }

  dialog.addEventListener('close', () => {
    openTrigger?.setAttribute('aria-expanded', 'false');
    openTrigger = null;
  });
  list.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const rows = [...list.querySelectorAll('button:not(:disabled)')];
    const step = event.key === 'ArrowDown' ? 1 : -1;
    rows[(rows.indexOf(document.activeElement) + step + rows.length) % rows.length]?.focus();
  });

  for (const select of document.querySelectorAll('select')) {
    if (select.dataset.control === 'switch') {
      mountSwitch(select);
      continue;
    }
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    const value = document.createElement('span');
    value.className = 'select-value';
    trigger.append(value, icon('chevron'));
    trigger.addEventListener('click', () => open(select, trigger));
    mount(select, trigger, () => {
      const text = select.selectedOptions[0]?.textContent.trim() ?? '';
      value.textContent = select.dataset.control === 'value' ? text.split(' · ')[0] : text;
      trigger.disabled = select.disabled;
      trigger.setAttribute('aria-label', `${titleOf(select)}: ${text}`);
    });
  }
}
