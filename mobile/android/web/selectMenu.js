// 用项目样式替代系统下拉：<select> 只保留值和 change 事件，外观和选择都由触发按钮与共用弹层负责。
import { get, icon, rowText } from './dom.js';

const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

function titleOf(select) {
  return select.labels?.[0]?.textContent.trim() || select.getAttribute('aria-label') || '';
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
    const field = document.createElement('div');
    field.className = 'select-field';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    // 文字跟随当前选项，翻译只作用在 <option> 上，避免重复翻译。
    trigger.dataset.i18nSkip = '';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    if (select.hasAttribute('aria-describedby')) trigger.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
    const value = document.createElement('span');
    value.className = 'select-value';
    trigger.append(value, icon('chevron'));
    select.replaceWith(field);
    field.append(select, trigger);
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const sync = () => {
      const text = select.selectedOptions[0]?.textContent.trim() ?? '';
      value.textContent = text;
      trigger.disabled = select.disabled;
      trigger.setAttribute('aria-label', `${titleOf(select)}: ${text}`);
    };
    // 程序直接赋值不会触发 change，这里同步显示；语言切换和 disabled 变化由监听器处理。
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return nativeValue.get.call(this); },
      set(next) { nativeValue.set.call(this, next); sync(); },
    });
    select.addEventListener('change', sync);
    // 点 <label> 只会聚焦隐藏的 select，转交给可见按钮。
    select.addEventListener('focus', () => trigger.focus({ preventScroll: true }));
    new MutationObserver(sync).observe(select, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
    trigger.addEventListener('click', () => open(select, trigger));
    sync();
  }
}
