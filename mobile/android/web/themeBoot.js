// 首帧前套用手机端主题，避免先闪一下默认深色。CSP 不允许内联脚本，因此单独成文件并在 <head> 同步加载。
// 取值与 protocol.js 的 APP_THEMES / parseAppTheme 保持一致；深色为默认，不写 data-theme。
(function () {
  try {
    if (localStorage.getItem('qingcode:mobile:theme') === 'graphite') {
      document.documentElement.dataset.theme = 'graphite';
    }
  } catch {
    // 隐私模式等无法读取 localStorage 时保持默认深色。
  }
})();
