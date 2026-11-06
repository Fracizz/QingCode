// 终端 WebGL 渲染：不可用或丢失上下文时退回 xterm 默认的 DOM 渲染，不影响终端内容。

/** 同一终端最多重建这么多次；再丢失就一直用 DOM，避免在有问题的 GPU 上反复闪烁。 */
const MAX_CONTEXT_LOSSES = 3;

/**
 * 必须在 term.open() 之后调用。enabled() 读取用户设置；Addon 不存在时（资产缺失）等同关闭。
 * wake() 在回到前台时调用：手机挂起后常丢失上下文，也可能留下未刷新的画面。
 */
export function attachTerminalRenderer(term, { Addon, enabled }) {
  let addon;
  let losses = 0;
  let disposed = false;

  function repaint() {
    try { term.refresh(0, term.rows - 1); } catch { /* 终端已释放 */ }
  }

  function unload() {
    const current = addon;
    addon = undefined;
    try { current?.dispose(); } catch { /* 已经丢失上下文时释放可能抛错 */ }
  }

  function load() {
    if (disposed || addon || !Addon || !enabled() || losses >= MAX_CONTEXT_LOSSES) return;
    try {
      const next = new Addon();
      next.onContextLoss(() => {
        losses += 1;
        if (addon === next) unload();
        repaint();
      });
      term.loadAddon(next);
      addon = next;
    } catch {
      // 不支持 WebGL2 时 loadAddon 会抛错，继续使用 DOM 渲染；不再重试。
      losses = MAX_CONTEXT_LOSSES;
    }
  }

  load();

  return {
    active: () => !!addon,
    wake() {
      if (disposed) return;
      if (!addon) load();
      repaint();
    },
    /** 设置变化后立即切换，不重建终端。 */
    sync() {
      if (disposed) return;
      if (enabled()) {
        losses = 0;
        load();
      } else {
        unload();
      }
      repaint();
    },
    dispose() {
      disposed = true;
      unload();
    },
  };
}
