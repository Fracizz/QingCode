export function createTerminalFontLoader(fonts, timeout = 2500) {
  let pending;
  return () => {
    if (pending) return pending;
    if (!fonts?.load) return pending = Promise.resolve();
    pending = new Promise(resolve => {
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, timeout);
      // WebGL 渲染会缓存首次绘制的字形，建终端前先加载符号与中文字体（见 app.css @font-face）。
      Promise.resolve().then(() => Promise.all([
        fonts.load('16px "QingCode Symbols"', '⏴⏵⏶⏷'),
        fonts.load('16px "QingCode CJK"', '中文'),
      ])).then(finish, finish);
    });
    return pending;
  };
}
