// 状态行里的输入短状态图标：图片进度 > 提交状态（发送中 / 已接收 / 结果未知）。
// 「电脑已接收」只对本次界面上看着发出的提交短暂显示约 4 秒，随后图标消失，不常驻勾号；
// 重新进入终端时不再回放以前已接收的回执。
// 发送中、结果未知、手机保存失败会一直显示，便于核对。提交原文仍可在「… → 最近提交与项目草稿」查看。
import { get } from './dom.js';
import { t } from './i18n.js';

export const RECEIPT_VISIBLE_MS = 4000;

/**
 * receipts()：当前会话最近的提交回执（新到旧）；persistenceFailed()：手机存储是否失败。
 */
export function createComposeStatus({ receipts, persistenceFailed }) {
  let imageNote = null;
  let imageNoteTimer = null;
  // 本次界面中出现过「发送中」的回执；只有它们在被接收时短暂提示。
  const watched = new Set();
  // 已显示过并到期的接收回执 id，到期后不再占用输入框。
  let shownReceipt = null;
  let expiredReceipt = null;
  let receiptTimer = null;

  function renderSubmission() {
    const latest = receipts()[0] ?? null;
    const failed = persistenceFailed();
    const chip = get('review-submission');
    const received = !failed && latest?.state === 'received';
    if (latest?.state === 'sending') watched.add(latest.id);
    // 以前已接收的回执（重新进入终端、切换会话）直接视为到期，不再提示。
    if (received && !watched.has(latest.id)) expiredReceipt = latest.id;
    else if (received && shownReceipt !== latest.id) {
      clearTimeout(receiptTimer);
      shownReceipt = latest.id;
      receiptTimer = setTimeout(() => {
        if (shownReceipt === latest.id) expiredReceipt = latest.id;
        renderSubmission();
      }, RECEIPT_VISIBLE_MS);
    }
    const visible = failed || (!!latest && !(received && expiredReceipt === latest.id));
    get('submission-state').dataset.visible = String(visible);
    chip.dataset.state = failed ? 'error' : latest?.state ?? '';
    // 状态图标由 .compose-note::before 按 data-state 绘制，文案不再带符号。
    get('submission-status').textContent = failed ? t('手机保存失败')
      : latest?.state === 'sending' ? t('正在发送…')
        : received ? t('电脑已接收 · 查看') : t('结果未知 · 查看');
    chip.setAttribute('aria-label', failed ? t('手机保存失败，请保留原文')
      : latest?.state === 'sending' ? t('正在发送') : received ? t('电脑已接收，查看提交原文') : t('提交结果未知，原文已保留，点按查看'));
    renderNotes();
  }

  function setImageNote(text, { state = 'busy', ttl = 0 } = {}) {
    clearTimeout(imageNoteTimer);
    imageNote = text ? { text, state } : null;
    if (text && ttl) imageNoteTimer = setTimeout(() => { imageNote = null; renderNotes(); }, ttl);
    renderNotes();
  }

  /** 同一时间只显示一项状态；无状态时整行不占高度。 */
  function renderNotes() {
    const submission = get('submission-state').dataset.visible === 'true';
    const image = get('image-state');
    image.textContent = imageNote?.text ?? '';
    image.dataset.state = imageNote?.state ?? '';
    image.hidden = !imageNote;
    // 补全提示不再占用状态行，只保留图片与提交两类图标。
    get('completion-help').hidden = true;
    get('submission-state').hidden = !submission || !!imageNote;
  }

  function reset() {
    setImageNote('');
    get('submission-state').dataset.visible = 'false';
    get('submission-state').hidden = true;
  }

  return { renderSubmission, renderNotes, setImageNote, reset, imageNote: () => imageNote };
}
