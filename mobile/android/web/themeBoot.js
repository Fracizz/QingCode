// 在 <head> 同步加载，首帧前恢复主题。设置页与系统外观变化共用同一套解析逻辑。
(function () {
  const key = 'qingcode:mobile:theme';
  const themes = ['dark', 'ink', 'olive', 'auto', 'light'];
  const root = document.documentElement;
  const native = window.QingCodeNative;
  // Android WebView 的媒体查询取 Activity 主题，系统明暗由原生配置提供。
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const normalize = value => value === 'graphite' ? 'ink' : themes.includes(value) ? value : 'dark';
  let preference = 'dark';
  try {
    const stored = localStorage.getItem(key);
    preference = normalize(stored);
    if (stored === 'graphite') localStorage.setItem(key, preference);
  } catch {}

  function refresh() {
    let resolved = preference;
    if (preference === 'auto') {
      const dark = native?.systemPrefersDark?.() ?? system.matches;
      resolved = dark ? 'dark' : 'light';
    }
    if (root.dataset.theme === resolved) return;
    root.dataset.theme = resolved;
    native?.setAppearance?.(resolved);
    document.dispatchEvent(new Event('qingcode:mobile:theme-changed'));
  }

  window.qingTheme = {
    get preference() { return preference; },
    save(value) {
      preference = normalize(value);
      try { localStorage.setItem(key, preference); } catch {}
      refresh();
    },
    refresh,
  };
  if (system.addEventListener) system.addEventListener('change', refresh);
  else system.addListener(refresh);
  refresh();
})();
