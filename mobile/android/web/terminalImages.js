/** Upload sequentially, hold URI handles only, and never insert into a different session. */
export async function uploadTerminalImages({ rpc, remote, address, id, compression, isCurrent, onProgress, onInsert }) {
  let selection;
  try {
    const picked = await rpc('pick_image', { compression });
    selection = picked?.selection;
    if (!picked || !isCurrent()) return;
    const count = selection ? picked.count : 1;
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('图片选择已失效，请重新选择。');
    for (let index = 0; index < count; index++) {
      if (!isCurrent()) return;
      onProgress(index + 1, count);
      const image = selection ? await rpc('read_image', { selection, index }) : picked;
      if (!isCurrent()) return;
      const result = await remote('image', { id, data: image.data }, address);
      if (!isCurrent()) return;
      onInsert(result.path);
    }
  } finally {
    if (selection) await rpc('release_images', { selection }).catch(() => {});
  }
}
