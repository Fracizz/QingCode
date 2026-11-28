package com.qingcode.next;

/** 屏幕底部圆角与对话输入框的几何关系；单位均为 CSS px（dp）。 */
final class ScreenCorner {
  // 与 styles.css 里输入框的左右边距、圆角一致。
  private static final float SIDE_MARGIN = 12;
  private static final float BOX_RADIUS = 6;
  /** 输入框与圆角屏幕边缘之间保留的余量。 */
  private static final float CLEARANCE = 4;

  private ScreenCorner() {}

  /**
   * 输入框的下圆角完全落在屏幕圆角（向内缩 CLEARANCE）以内所需的离底距离，减去原生层已经让出的底部高度。
   *
   * @param radius 屏幕底部圆角半径
   * @param bottomInset 系统栏、手势区或键盘已让出的底部高度
   * @param sideInset 左右两侧已让出的宽度（取较小值）
   */
  static float extraBottomGap(float radius, float bottomInset, float sideInset) {
    float reach = radius - CLEARANCE - BOX_RADIUS;
    float dx = radius - SIDE_MARGIN - sideInset - BOX_RADIUS;
    if (dx <= 0 || reach <= 0) return 0;
    double gap = radius - BOX_RADIUS - Math.sqrt(reach * reach - dx * dx);
    return (float) Math.max(0, gap - bottomInset);
  }
}
