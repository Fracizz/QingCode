/*
 * 终端中文字体：终端每个汉字占两个英文字格（系统等宽字体约 0.6em × 2 = 1.2em），而系统中文字形只有 1em 宽，
 * 字与字之间会空出一截，看起来像加了字距。这里引用系统自带的思源黑体 / Noto Sans CJK，用 sizeAdjust 略微放大，
 * 让汉字基本填满两格；只覆盖中日韩字符和全角标点，不改变英文字格度量。找不到这些系统字体时不生效。
 * 只在 Android WebView 中用 FontFace 动态注册：静态 CSS 里的 local() 会让桌面 Chromium 枚举系统字体，
 * 拖慢渲染（web 测试页截图会超时），桌面浏览器也不需要它。
 */
export const CJK_FONT_FAMILY = 'QingCode CJK';
export const CJK_FONT_SOURCES = [
  'Noto Sans CJK SC', 'Noto Sans CJK SC Regular', 'NotoSansCJKsc-Regular',
  'Source Han Sans SC', 'Source Han Sans SC Regular', 'SourceHanSansSC-Regular',
  'Noto Sans SC', 'NotoSansSC-Regular',
].map(name => `local('${name}')`).join(', ');
export const CJK_UNICODE_RANGE = 'U+1100-11FF, U+2E80-2FDF, U+3000-303F, U+3040-30FF, U+3100-312F, U+3130-318F, U+31F0-31FF, '
  + 'U+3200-33FF, U+3400-4DBF, U+4E00-9FFF, U+AC00-D7AF, U+F900-FAFF, U+FE30-FE4F, U+FF01-FF60, U+FFE0-FFE6';
export const CJK_SIZE_ADJUST = '112%';

/** 创建终端中文字体；FontFace 不可用或不支持这些描述符时返回 null，终端回落到系统字体。 */
export function createCjkFontFace(FontFaceType) {
  if (typeof FontFaceType !== 'function') return null;
  try {
    return new FontFaceType(CJK_FONT_FAMILY, CJK_FONT_SOURCES, { unicodeRange: CJK_UNICODE_RANGE, sizeAdjust: CJK_SIZE_ADJUST, display: 'swap' });
  } catch {
    return null;
  }
}

/** cjkFace()：返回要注册的中文字体（只在 Android 上提供），省略时只加载符号字体。 */
export function createTerminalFontLoader(fonts, timeout = 2500, { cjkFace = null } = {}) {
  let pending;
  return () => {
    if (pending) return pending;
    if (!fonts?.load) return pending = Promise.resolve();
    pending = new Promise(resolve => {
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, timeout);
      // WebGL 渲染会缓存首次绘制的字形，建终端前先加载符号与中文字体（符号字体见 app.css @font-face）。
      Promise.resolve().then(() => {
        const loads = [fonts.load('16px "QingCode Symbols"', '⏴⏵⏶⏷')];
        const face = cjkFace?.();
        if (face && fonts.add) {
          fonts.add(face);
          loads.push(face.load());
        }
        return Promise.all(loads);
      }).then(finish, finish);
    });
    return pending;
  };
}
