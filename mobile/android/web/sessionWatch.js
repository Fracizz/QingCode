// 后台提醒的设置与一次性询问：真正的查询和通知在原生层 SessionWatcher.java。
import { get } from './dom.js';
import { locale, t } from './i18n.js';

/**
 * rpc 调用原生桥；capabilities() 返回当前电脑的能力（旧版电脑为 null）；
 * notice(text) 显示简短提示；tipBlocked() 为真时先不询问（其他首次说明还在显示）。
 */
export function createSessionWatch({ rpc, prefix, capabilities, notice, tipBlocked }) {
  const key = prefix + 'session-watch';
  const select = get('session-watch');
  const tip = get('watch-tip');

  function read() {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function write(value) {
    try { localStorage.setItem(key, value); } catch { /* 本次运行仍然生效 */ }
  }

  function apply() {
    const enabled = read() === 'on';
    select.value = enabled ? 'on' : 'off';
    return rpc('session_watch', { enabled, english: locale() === 'en' }).catch(() => false);
  }

  async function supported() {
    try {
      const value = await capabilities();
      return !!value?.features?.includes('attention');
    } catch {
      return false;
    }
  }

  async function enable() {
    let allowed = false;
    try { allowed = await rpc('notification_permission'); } catch { /* 按未授权处理 */ }
    if (!allowed) {
      write('off');
      await apply();
      notice(t('未获得通知权限，请在系统设置中允许 QingCode 发送通知'));
      return;
    }
    write('on');
    await apply();
    if (!await supported()) notice(t('当前电脑不支持后台提醒，请更新电脑端 QingCode'));
  }

  select.addEventListener('change', () => {
    if (select.value === 'on') void enable();
    else {
      write('off');
      void apply();
    }
  });

  function answer(next) {
    tip.hidden = true;
    if (next === 'on') void enable();
    else {
      write('off');
      void apply();
    }
  }
  get('watch-tip-enable').addEventListener('click', () => answer('on'));
  get('watch-tip-dismiss').addEventListener('click', () => answer('off'));

  let asking = false;
  void apply();

  return {
    /** 第一次看到程序在运行时询问一次；用户在设置里选过或答过就不再问。 */
    async busySeen() {
      if (asking || read() !== null || !tip.hidden || tipBlocked()) return;
      asking = true;
      try {
        if (await supported() && read() === null && !tipBlocked()) tip.hidden = false;
      } finally {
        asking = false;
      }
    },
    hideTip() {
      tip.hidden = true;
    },
    seen(address, id) {
      void rpc('session_watch_seen', { address, id }).catch(() => {});
    },
  };
}
