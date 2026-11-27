async function toPng(image: HTMLImageElement): Promise<Blob> {
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法绘制图片')
  context.drawImage(image, 0, 0)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('无法生成 PNG'))
    }, 'image/png')
  })
}

export async function copyImage(image: HTMLImageElement): Promise<boolean> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false

  const png = toPng(image)
  // 剪贴板可能在读取图片数据前就拒绝写入。
  void png.catch(() => undefined)
  try {
    // 在点击产生的用户激活期间发起写入，PNG 编码由剪贴板等待完成。
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    return true
  } catch {
    return false
  }
}
