export function createTerminalFontLoader(fonts, timeout = 2500) {
  let pending;
  return () => {
    if (pending) return pending;
    if (!fonts?.load) return pending = Promise.resolve();
    pending = new Promise(resolve => {
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, timeout);
      Promise.resolve().then(() => fonts.load('16px "QingCode Symbols"', '⏴⏵⏶⏷')).then(finish, finish);
    });
    return pending;
  };
}
