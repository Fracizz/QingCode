// 工作台大标题收起：页面滚过大标题后，顶栏淡入同名紧凑标题；点按紧凑标题回到顶部。
// 大标题随内容滚动，不改变布局高度，滚动时不触发重排。

/** 大标题底边减去余量后仍在可视区外即视为收起；纯函数便于测试。 */
export function heroCollapsed(scrollTop, titleBottom, slack = 8) {
  return scrollTop > Math.max(0, titleBottom - slack);
}

/**
 * root：工作台容器（写 data-collapsed）。pages：{ name: 滚动容器 }。active()：当前页名。
 * header：浮动顶栏；title：顶栏紧凑标题按钮；text：其中的文字节点。
 */
export function createHeroHeader({ root, header, pages, active, title, text }) {
  let frame = 0;

  function sync() {
    frame = 0;
    const page = pages[active()];
    const heading = page?.querySelector('.hero-title');
    // 顶栏浮在页面上方：大标题完全滑到顶栏下面才收起。
    const collapsed = !!heading && heroCollapsed(page.scrollTop, heading.offsetTop + heading.offsetHeight, header.offsetHeight);
    root.dataset.collapsed = String(collapsed);
    // 收起前紧凑标题对读屏和焦点都不可见，避免与大标题重复朗读。
    title.setAttribute('aria-hidden', String(!collapsed));
    title.tabIndex = collapsed ? 0 : -1;
    if (heading) text.textContent = heading.textContent;
  }

  const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
  for (const page of Object.values(pages)) page.addEventListener('scroll', schedule, { passive: true });
  title.addEventListener('click', () => pages[active()]?.scrollTo({ top: 0, behavior: 'smooth' }));
  return { sync };
}
