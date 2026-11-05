// 命令输入框内的单行短状态：图片进度 > 待处理的提交状态 > 补全提示 > 已接收。
// 「电脑已接收」只对本次界面上看着发出的提交短暂显示约 4 秒，随后整行消失，输入框不再常驻勾号；
// 重新进入终端时不再回放以前已接收的回执。
// 发送中、结果未知、手机保存失败会一直显示，便于核对。提交原文仍可在「… → 最近提交与项目草稿」查看。
import { get } from './dom.js';
import { isSlashDraft } from './composer.js';

export const RECEIPT_VISIBLE_MS = 4000;

/**
 * receipts()：当前会话最近的提交回执（新到旧）；persistenceFailed()：手机存储是否失败；
 * rawInput()：是否处于终端实时输入；draft()：当前命令栏文字。
 */
export function createComposeStatus({ receipts, persistenceFailed, rawInput, draft }) {
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
    get('submission-status').textContent = failed ? '⚠ 手机保存失败'
      : latest?.state === 'sending' ? '正在发送…'
        : received ? '✓ 电脑已接收 · 查看' : '⚠ 结果未知 · 查看';
    chip.setAttribute('aria-label', failed ? '手机保存失败，请保留原文'
      : latest?.state === 'sending' ? '正在发送' : received ? '电脑已接收，查看提交原文' : '提交结果未知，原文已保留，点按查看');
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
    const raw = rawInput();
    const chip = get('review-submission');
    const submission = get('submission-state').dataset.visible === 'true';
    const settled = submission && chip.dataset.state === 'received';
    const image = get('image-state');
    image.textContent = imageNote?.text ?? '';
    image.dataset.state = imageNote?.state ?? '';
    image.hidden = !imageNote;
    const urgentSubmission = submission && !settled && !imageNote;
    const help = get('completion-help');
    help.hidden = !!imageNote || urgentSubmission || !(raw || isSlashDraft(draft()));
    get('submission-state').hidden = !submission || !!imageNote || (settled && !help.hidden);
  }

  function reset() {
    setImageNote('');
    get('submission-state').dataset.visible = 'false';
    get('submission-state').hidden = true;
  }

  return { renderSubmission, renderNotes, setImageNote, reset, imageNote: () => imageNote };
}
