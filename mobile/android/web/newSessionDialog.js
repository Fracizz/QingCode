// 新建会话弹层：创建反馈跟随点选的配置，超时后由用户从实际列表选择会话。
import { get, icon, message } from './dom.js';
import { t } from './i18n.js';
import { sessionName } from './protocol.js';

export function createNewSessionDialog(onSelect) {
  const list = get('terminal-profiles');
  const result = get('terminal-create-result');
  const help = get('terminal-profiles-help');
  const cancel = get('new-session-dialog').querySelector('[data-close]');
  const progress = get('terminal-profiles-progress');
  const recovered = get('terminal-create-sessions');

  function clearResult() {
    list.after(result);
    message('terminal-profiles-error', '');
    recovered.replaceChildren();
  }

  function render(choices, state = '') {
    clearResult();
    list.replaceChildren(...choices.map(choice => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'secondary';
      if (choice.id) option.dataset.profile = choice.id;
      const name = document.createElement('span');
      name.textContent = t(choice.name);
      option.append(name);
      const detail = document.createElement('small');
      if (!choice.trusted) detail.textContent = t('需先在电脑上信任');
      option.append(detail);
      option.addEventListener('click', () => {
        clearResult();
        option.after(result);
        if (choice.trusted) onSelect(choice.id, option, option.dataset.retry === 'check');
        else message('terminal-profiles-error', t('请先在电脑上新建一次「{name}」终端并选择「信任此配置」。', { name: choice.name }));
      });
      return option;
    }));
    list.setAttribute('aria-busy', String(state === 'loading'));
    if (state === 'error') message('terminal-profiles-error', t('无法读取电脑端终端配置，已仅显示普通终端。'));
  }

  function pending(option, host, checking) {
    const buttons = list.querySelectorAll(':scope > button');
    for (const button of buttons) {
      button.disabled = true;
      if (button.dataset.retry) {
        delete button.dataset.retry;
        button.lastElementChild.textContent = '';
      }
    }
    list.setAttribute('aria-busy', 'true');
    cancel.disabled = true;
    option.dataset.pending = 'true';
    const detail = option.lastElementChild;
    const showStatus = text => detail.replaceChildren(icon('loader-circle', 'session-spinner'), text);
    const spinner = setTimeout(() => {
      showStatus(t('正在创建…'));
      progress.classList.add('sr-only');
      message('terminal-profiles-progress', t('正在创建「{name}」…', { name: option.firstElementChild.textContent }));
    }, 200);
    const slow = setTimeout(() => {
      progress.classList.remove('sr-only');
      help.hidden = true;
      message('terminal-profiles-progress', t('正在等待 {host} 响应…', { host }));
    }, 3000);
    function verify() {
      clearTimeout(spinner);
      clearTimeout(slow);
      progress.classList.remove('sr-only');
      help.hidden = true;
      showStatus(t('正在核对会话…'));
      message('terminal-profiles-progress', t('创建结果待确认，正在刷新会话列表…'));
    }
    if (checking) verify();
    return {
      verify,
      finish({ error = '', uncertain = false } = {}) {
        clearTimeout(spinner);
        clearTimeout(slow);
        progress.hidden = true;
        progress.classList.remove('sr-only');
        help.hidden = false;
        delete option.dataset.pending;
        list.setAttribute('aria-busy', 'false');
        detail.replaceChildren();
        for (const button of buttons) button.disabled = uncertain && button !== option;
        cancel.disabled = false;
        if (error) {
          message('terminal-profiles-error', error);
          option.dataset.retry = uncertain ? 'check' : 'create';
          detail.textContent = uncertain ? t('刷新会话') : t('重试');
          option.focus({ preventScroll: true });
        }
      },
    };
  }

  function showSessions(sessions, open) {
    recovered.replaceChildren(...sessions.map(session => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = t('打开「{name}」', { name: sessionName(session) });
      button.addEventListener('click', () => open(session));
      return button;
    }));
  }

  return { render, pending, showSessions };
}
