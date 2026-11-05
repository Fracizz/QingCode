// 配对与连接管理弹窗：扫码 / 粘贴配对链接、首次配对与指纹核对、连接详情（改名、改端口、重新配对、移除）。
import { DEFAULT_PORT, parsePairingLink, validIpv4, validPort } from './protocol.js';
import { decodeScannerFrame, focusScannerCamera, requestScannerCamera } from './scanner.js';
import { get, message, confirmAction } from './dom.js';

/**
 * profiles()：已保存的连接；onPaired(paired) 保存并切换到新连接；
 * moveProfile(from, to) 迁移端口变化后的本地记录；putProfile(item) 写回连接；
 * afterHostSaved(updated, portChanged) 刷新界面；forgetProfile(item) 清理被移除的连接；
 * renderLatency() 在详情打开时刷新延迟说明。
 */
export function createPairingFlow({ rpc, profiles, onPaired, moveProfile, putProfile, afterHostSaved, forgetProfile, renderLatency }) {
  // Fingerprint from a scanned or pasted pairing link; skips manual comparison when it matches.
  let expectedFingerprint = null;
  let editing = null;
  let scanStream = null;
  let scanTimer = null;
  let scanEpoch = 0;

  function openPair(item, target = null) {
    const dialog = get('pair-dialog');
    get('host-dialog').close();
    expectedFingerprint = target?.fingerprint ?? null;
    get('pair-title').textContent = item ? '重新配对' : '添加连接';
    get('pair-name').value = item?.name ?? target?.name ?? '';
    get('pair-host').value = item?.host ?? target?.host ?? '';
    get('pair-port').value = item?.port ?? target?.port ?? String(DEFAULT_PORT);
    get('pair-code').value = '';
    get('pair-host').readOnly = !!item;
    get('pair-port').readOnly = !!item;
    get('pair-link-state').hidden = !expectedFingerprint;
    get('pair-link-tools').hidden = !!item;
    message('pair-error', '');
    if (!dialog.open) dialog.showModal();
    if (target) get('pair-code').focus();
  }

  function openPairTarget(target) {
    const saved = profiles().find(item => item.id === target.host + ':' + target.port);
    openPair(saved && saved.fingerprint === target.fingerprint ? saved : null, target);
  }

  function openHost(item) {
    editing = item;
    get('host-address').textContent = item.id;
    get('host-fingerprint').textContent = item.fingerprint;
    get('host-name').value = item.name;
    get('host-port').value = item.port;
    message('host-error', '');
    renderLatency();
    get('host-dialog').showModal();
  }

  function stopScan() {
    scanEpoch += 1;
    clearTimeout(scanTimer);
    scanTimer = null;
    for (const track of scanStream?.getTracks() ?? []) track.stop();
    scanStream = null;
    get('scan-video').srcObject = null;
  }

  get('pair-paste').addEventListener('click', async () => {
    message('pair-error', '');
    try {
      openPairTarget(parsePairingLink(await rpc('clipboard')));
    } catch (error) {
      message('pair-error', error.message === '这不是 QingCode 配对链接。' ? '剪贴板中没有 QingCode 配对链接。' : error.message);
    }
  });

  get('scan-dialog').addEventListener('close', stopScan);

  get('pair-scan').addEventListener('click', async () => {
    stopScan();
    const epoch = scanEpoch;
    const dialog = get('scan-dialog');
    const video = get('scan-video');
    message('pair-error', '');
    message('scan-error', '');
    dialog.showModal();
    try {
      if (!await rpc('camera')) throw new Error('需要相机权限才能扫码。也可以粘贴电脑端复制的配对链接。');
      if (epoch !== scanEpoch || !dialog.open) return;
      const stream = await requestScannerCamera(navigator.mediaDevices);
      if (epoch !== scanEpoch || !dialog.open) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      scanStream = stream;
      void focusScannerCamera(stream);
      video.srcObject = stream;
      await video.play();
    } catch (error) {
      if (epoch !== scanEpoch) return;
      stopScan();
      message('scan-error', error.name === 'NotAllowedError' ? '需要相机权限才能扫码。也可以取消后粘贴配对链接。' : error.message || '无法打开相机。');
      return;
    }
    if (epoch !== scanEpoch || !dialog.open) return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || typeof window.jsQR !== 'function') {
      stopScan();
      message('scan-error', '无法加载扫码组件，请取消后重试，或粘贴电脑端复制的配对链接。');
      return;
    }
    const tick = () => {
      if (!scanStream || epoch !== scanEpoch || !dialog.open) return;
      try {
        if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          const text = decodeScannerFrame(video, canvas, context, window.jsQR);
          if (text) {
            const target = parsePairingLink(text);
            dialog.close();
            stopScan();
            openPairTarget(target);
            return;
          }
        }
      } catch (error) {
        message('scan-error', error.message || '暂时无法识别，请调整距离和光线后重试。');
      }
      scanTimer = setTimeout(tick, 180);
    };
    tick();
  });

  get('pair-dialog').addEventListener('cancel', event => {
    if (get('pair-submit').disabled) event.preventDefault();
  });

  get('pair-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = get('pair-submit');
    if (submit.disabled) return;
    const cancel = get('pair-form').querySelector('[data-close]');
    const field = get('pair-code');
    const name = get('pair-name').value.trim();
    const host = get('pair-host').value.trim();
    const port = Number(get('pair-port').value);
    const code = field.value;
    submit.disabled = cancel.disabled = true;
    message('pair-error', '');
    try {
      if (!name) throw new Error('请输入连接名称。');
      if (!validIpv4(host) || !validPort(port)) throw new Error('请输入有效的电脑 IPv4 地址和端口。');
      if (!/^[!-~]{6,20}$/.test(code)) {
        throw new Error('密码须为 6–20 位，可使用数字、英文字母或符号，无需组合。');
      }
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const fingerprint = await rpc('probe', { host, port });
      const saved = profiles().find(item => item.id === host + ':' + port);
      if (expectedFingerprint) {
        // The link came from the desktop screen, so a mismatch means a different or intercepted host.
        if (expectedFingerprint !== fingerprint) {
          throw new Error('电脑证书与二维码中的指纹不一致，已停止配对。请确认地址，或在电脑端重新生成二维码。');
        }
      } else if (saved && saved.fingerprint !== fingerprint) {
        throw new Error('电脑证书已变化，已停止配对。请重新扫描电脑端二维码或粘贴配对链接。');
      }
      const paired = await rpc('pair', { name, host, port, code, fingerprint });
      field.value = '';
      get('pair-dialog').close();
      await onPaired(paired);
    } catch (error) {
      message('pair-error', error.message);
    } finally {
      submit.disabled = cancel.disabled = false;
    }
  });

  get('host-form').addEventListener('submit', async event => {
    event.preventDefault();
    const item = editing;
    const submit = event.submitter ?? get('host-form').querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const name = get('host-name').value.trim();
      const port = Number(get('host-port').value);
      if (!validPort(port)) throw new Error('端口须为 1–65535 之间的整数。');
      let updated = item;
      if (port !== item.port) {
        // The desktop keeps pairings across port switches; only the address changes here.
        updated = await rpc('readdress', { profile: item.id, port });
        moveProfile(item, updated);
      }
      if (name !== updated.name) updated = await rpc('rename', { profile: updated.id, name });
      putProfile(updated);
      editing = updated;
      afterHostSaved(updated, port !== item.port);
      get('host-dialog').close();
    } catch (error) {
      message('host-error', error.message);
    } finally {
      submit.disabled = false;
    }
  });

  get('repair-host').addEventListener('click', () => openPair(editing));
  get('remove-host').addEventListener('click', async () => {
    const item = editing;
    if (!await confirmAction('移除 ' + item.name + '？', '此操作会删除手机上保存的配对。要撤销电脑端授权，请在电脑端停止移动连接。', '移除')) return;
    try {
      await rpc('forget', { profile: item.id });
      forgetProfile(item);
      get('host-dialog').close();
    } catch (error) {
      message('host-error', error.message);
    }
  });

  return { openPair, openPairTarget, openHost, editingProfile: () => editing };
}
