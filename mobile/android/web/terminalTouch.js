/** Bridge single-finger drags to xterm's wheel handling (scrollback, TUI and mouse reporting). */
export function attachTerminalTouchScroll(element) {
  const screen = element.querySelector('.xterm-screen');
  if (!screen) return () => {};
  const view = element.ownerDocument.defaultView;
  let gesture = null;

  function start(event) {
    gesture = null;
    if (event.touches.length !== 1 || !screen.contains(event.target)) return;
    const touch = event.touches[0];
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, previousY: touch.clientY, axis: null };
  }

  function move(event) {
    if (!gesture) return;
    if (event.touches.length !== 1) { gesture = null; return; }
    const touch = event.touches[0];
    if (touch.identifier !== gesture.id) { gesture = null; return; }
    if (!gesture.axis) {
      const x = Math.abs(touch.clientX - gesture.x);
      const y = Math.abs(touch.clientY - gesture.y);
      // Ignore tap jitter; lock direction so horizontal gestures never send terminal input.
      if (Math.max(x, y) < 8) return;
      gesture.axis = y > x ? 'vertical' : 'horizontal';
    }
    if (gesture.axis !== 'vertical') return;
    if (event.cancelable) event.preventDefault();
    const deltaY = gesture.previousY - touch.clientY;
    gesture.previousY = touch.clientY;
    if (!deltaY) return;
    // Dispatch inside the scrollable screen, so the same handlers as a physical
    // wheel decide whether to scroll history or report scrolling to the program.
    const wheel = new view.WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaMode: 0, deltaY,
      clientX: touch.clientX, clientY: touch.clientY,
    });
    // Chromium populates legacy wheelDelta fields differently on constructed
    // events. Let xterm read the standard pixel deltas so direction stays correct.
    Object.defineProperties(wheel, {
      wheelDeltaY: { value: undefined },
      wheelDeltaX: { value: undefined },
    });
    screen.dispatchEvent(wheel);
  }

  function end() { gesture = null; }

  element.addEventListener('touchstart', start, { passive: true });
  element.addEventListener('touchmove', move, { passive: false });
  element.addEventListener('touchend', end);
  element.addEventListener('touchcancel', end);
  return () => {
    end();
    element.removeEventListener('touchstart', start);
    element.removeEventListener('touchmove', move);
    element.removeEventListener('touchend', end);
    element.removeEventListener('touchcancel', end);
  };
}
