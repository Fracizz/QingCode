// 在线更新界面：「设置」页的版本与检查按钮、首页新版本提示卡片和更新弹层。
// 原生层负责下载、校验与调用系统安装器，进度经 window.qingUpdate 回传；挑选逻辑在 appUpdate.js。
import { pickApkUpdate, parseUpdatePrefs, progressText, formatBytes, shouldAutoCheck, UPDATE_PREFS_KEY } from './appUpdate.js';
import { get, message, ask } from './dom.js';
import { t } from './i18n.js';

export function createUpdateView({ rpc, storage = localStorage, now = () => Date.now() }) {
  let prefs = parseUpdatePrefs(storage.getItem(UPDATE_PREFS_KEY));
  let current = null;
  let found = null;
  // idle / checking / available / downloading / ready / installing / error
  let phase = 'idle';
  let checking = null;
  const dialog = get('update-dialog');

  function savePrefs() {
    try { storage.setItem(UPDATE_PREFS_KEY, JSON.stringify(prefs)); } catch { /* 偏好保存失败时本次仍然生效。 */ }
  }

  // 状态行记住原文 key 与参数，切换语言后 render 时按新语言重写。
  let statusMessage = null;
  function status(key, vars) {
    statusMessage = key ? { key, vars } : null;
    paintStatus();
  }
  function paintStatus() {
    get('update-status').textContent = statusMessage ? t(statusMessage.key, statusMessage.vars) : '';
  }
  function dialogStatus(text) { get('update-dialog-status').textContent = text; }

  function renderCard() {
    const visible = !!found && prefs.skipped !== found.version;
    get('update-card').hidden = !visible;
    if (found) get('update-card-version').textContent = found.version;
  }

  function renderDialog() {
    if (!found) return;
    const size = found.size ? ' · ' + formatBytes(found.size) : '';
    const channel = found.prerelease ? t(' · 测试版') : '';
    get('update-dialog-version').textContent = t('新版本 {version}，当前 {current}', { version: found.version, current: current?.name ?? '' }) + size + channel;
    get('update-notes').textContent = found.notes || t('此版本没有更新说明。');
    const busy = phase === 'downloading' || phase === 'installing';
    get('update-progress').hidden = phase !== 'downloading';
    get('update-skip').hidden = busy || phase === 'ready';
    get('update-page').hidden = !found.page;
    get('update-action').disabled = phase === 'installing';
    get('update-action').textContent = phase === 'downloading' ? t('取消下载')
      : phase === 'ready' || phase === 'installing' ? t('安装') : t('下载并安装');
  }

  function render() {
    get('update-version').textContent = current ? t('当前版本 {version}', { version: current.name }) : '';
    get('update-check').disabled = !current || phase === 'checking';
    get('update-auto').checked = prefs.auto;
    paintStatus();
    renderCard();
    renderDialog();
  }

  async function check({ manual = false } = {}) {
    if (!current) return null;
    if (checking) return checking;
    if (phase !== 'downloading' && phase !== 'ready' && phase !== 'installing') phase = 'checking';
    status('正在检查更新…');
    render();
    checking = (async () => {
      try {
        const list = await rpc('update_releases');
        prefs.lastCheck = now();
        savePrefs();
        const next = pickApkUpdate(list, current);
        // 已在下载或已下载好的版本保持不变，避免中途换包。
        if (!(found && ['downloading', 'ready', 'installing'].includes(phase))) found = next;
        if (phase === 'checking') phase = found ? 'available' : 'idle';
        status(found ? '发现新版本 {version}' : '已是最新版本。', found ? { version: found.version } : undefined);
        render();
        if (manual && found) openDialog();
        return found;
      } catch (error) {
        if (phase === 'checking') phase = 'idle';
        status(manual ? error.message : '');
        render();
        return null;
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  function openDialog() {
    if (!found) return;
    message('update-dialog-error', '');
    if (phase === 'available' || phase === 'idle') dialogStatus('');
    renderDialog();
    if (!dialog.open) void ask(dialog);
  }

  async function download() {
    message('update-dialog-error', '');
    phase = 'downloading';
    get('update-progress').removeAttribute('value');
    dialogStatus(t('正在准备下载…'));
    render();
    try {
      await rpc('update_download', { url: found.url, size: found.size ?? -1 });
    } catch (error) {
      phase = 'error';
      dialogStatus('');
      message('update-dialog-error', t(error.message));
      render();
    }
  }

  async function install() {
    message('update-dialog-error', '');
    phase = 'installing';
    dialogStatus(t('正在打开系统安装…'));
    render();
    try {
      const result = await rpc('update_install');
      if (result?.permission) {
        phase = 'ready';
        dialogStatus(t('请在系统设置中允许 QingCode 安装应用，返回后点「安装」。'));
      }
    } catch (error) {
      phase = 'ready';
      dialogStatus('');
      message('update-dialog-error', t(error.message));
    }
    render();
  }

  /** 原生层回传的下载与安装状态。 */
  function receive(event) {
    if (!event || typeof event.state !== 'string') return;
    message('update-dialog-error', '');
    if (event.state === 'progress') {
      phase = 'downloading';
      const progress = get('update-progress');
      if (event.total > 0) progress.value = Math.min(100, Math.floor(event.received / event.total * 100));
      else progress.removeAttribute('value');
      dialogStatus(progressText(event.received, event.total));
    } else if (event.state === 'ready') {
      phase = 'ready';
      dialogStatus(event.message ? t(event.message) : t('下载完成，安装包已通过校验。'));
      if (found && !dialog.open) openDialog();
    } else if (event.state === 'cancelled') {
      phase = 'available';
      dialogStatus(t('已取消下载。'));
    } else if (event.state === 'confirm') {
      phase = 'ready';
      dialogStatus(t('请在系统界面确认安装。'));
    } else if (event.state === 'installed') {
      phase = 'idle';
      dialogStatus(t('安装完成，请重新打开 QingCode。'));
    } else if (event.state === 'error') {
      phase = phase === 'installing' || phase === 'ready' ? 'ready' : 'error';
      dialogStatus('');
      message('update-dialog-error', t(event.message || '下载失败，请检查网络后重试。') + (event.detail ? ' ' + event.detail : ''));
    }
    render();
  }

  get('update-check').addEventListener('click', () => { void check({ manual: true }); });
  get('update-card').addEventListener('click', openDialog);
  get('update-auto').addEventListener('change', () => {
    prefs.auto = get('update-auto').checked;
    savePrefs();
  });
  get('update-action').addEventListener('click', () => {
    if (phase === 'downloading') void rpc('update_cancel').catch(() => {});
    else if (phase === 'ready') void install();
    else void download();
  });
  get('update-skip').addEventListener('click', () => {
    if (!found) return;
    prefs.skipped = found.version;
    savePrefs();
    dialog.close('cancel');
    status('已跳过 {version}，可随时手动检查更新。', { version: found.version });
    render();
  });
  get('update-page').addEventListener('click', () => {
    if (found?.page) void rpc('open_link', { url: found.page }).catch(error => message('update-dialog-error', t(error.message)));
  });

  return {
    receive,
    check,
    /** 按当前语言重绘版本、状态行与更新弹层（切换语言时调用）。 */
    render,
    /** 读取当前版本；自动检查开启且距上次超过 24 小时时在后台检查。 */
    async start() {
      try {
        current = await rpc('app_version');
      } catch {
        get('update-section').hidden = true;
        return;
      }
      render();
      if (shouldAutoCheck(prefs, now())) await check();
    },
    phase: () => phase,
    found: () => found,
  };
}
