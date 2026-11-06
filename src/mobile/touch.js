'use strict';

/**
 * iPad 触控适配层。
 *
 * 桌面端是按鼠标事件写的：mousedown / mousemove / mouseup / wheel / contextmenu / dblclick。
 * WKWebView 在触摸屏上不会为拖拽生成这些事件，所以这里在画布区域做一层手势翻译，
 * 其余区域保留原生点击与滚动，另外补上长按菜单和双击。
 */

const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

function isEditable(target) {
  return !!(target && target.closest && target.closest(EDITABLE));
}

function inCanvas(target) {
  return !!(target && target.closest && target.closest('#canvas-viewport, #canvas-palette'));
}

function mouse(type, touch, buttons) {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    buttons: buttons == null ? 1 : buttons,
    clientX: touch.clientX,
    clientY: touch.clientY,
    screenX: touch.screenX,
    screenY: touch.screenY,
  });
}

function fire(target, type, touch, buttons) {
  const ev = mouse(type, touch, buttons);
  (target || document).dispatchEvent(ev);
  return ev;
}

function install() {
  if (typeof navigator === 'undefined' || !('ontouchstart' in window || navigator.maxTouchPoints > 0)) return;

  let longPressTimer = null;
  let suppressClick = false;
  let startPoint = null;
  let startTarget = null;
  let moved = false;
  let dragging = false;
  let lastTap = null;
  let pinch = null;

  const clearLongPress = () => {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  };

  const openContextMenu = (target, touch) => {
    suppressClick = true;
    const ev = mouse('contextmenu', touch, 0);
    (target || document).dispatchEvent(ev);
  };

  const onTouchStart = (e) => {
    if (isEditable(e.target)) return;

    // 双指：捏合缩放画布
    if (e.touches.length >= 2 && inCanvas(e.target)) {
      e.preventDefault();
      clearLongPress();
      if (dragging) {
        fire(document, 'mouseup', startPoint || e.touches[0], 0);
        dragging = false;
      }
      const [a, b] = [e.touches[0], e.touches[1]];
      pinch = {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
      };
      return;
    }

    if (!inCanvas(e.target)) {
      // 非画布区域：只做长按菜单 + 双击，点击与滚动交给系统
      const touch = e.touches[0];
      startPoint = { clientX: touch.clientX, clientY: touch.clientY, screenX: touch.screenX, screenY: touch.screenY };
      startTarget = e.target;
      moved = false;
      clearLongPress();
      longPressTimer = setTimeout(() => {
        if (!moved && startTarget) openContextMenu(startTarget, startPoint);
      }, 560);
      return;
    }

    // 画布区域：阻止系统手势，自己翻译成鼠标事件
    e.preventDefault();
    const touch = e.touches[0];
    startPoint = { clientX: touch.clientX, clientY: touch.clientY, screenX: touch.screenX, screenY: touch.screenY };
    startTarget = e.target;
    moved = false;
    dragging = true;
    fire(e.target, 'mousedown', touch, 1);

    clearLongPress();
    longPressTimer = setTimeout(() => {
      if (!moved && startTarget) {
        openContextMenu(startTarget, startPoint);
        fire(document, 'mouseup', startPoint, 0);
        dragging = false;
      }
    }, 560);
  };

  const onTouchMove = (e) => {
    if (isEditable(e.target) && !inCanvas(e.target)) return;
    if (pinch && e.touches.length >= 2) {
      e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const x = (a.clientX + b.clientX) / 2;
      const y = (a.clientY + b.clientY) / 2;
      if (pinch.dist > 0) {
        const ratio = dist / pinch.dist;
        if (Math.abs(Math.log(ratio)) > 0.04) {
          const steps = Math.max(1, Math.round(Math.log(ratio) / Math.log(1.12)));
          const viewport = document.getElementById('canvas-viewport');
          if (viewport) {
            for (let i = 0; i < Math.abs(steps); i += 1) {
              const ev = new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
                deltaY: steps > 0 ? -1 : 1,
              });
              viewport.dispatchEvent(ev);
            }
          }
          pinch.dist = dist;
        }
      }
      pinch.x = x;
      pinch.y = y;
      return;
    }

    if (!startPoint) return;
    const touch = e.touches[0];
    if (!touch) return;
    if (Math.hypot(touch.clientX - startPoint.clientX, touch.clientY - startPoint.clientY) > 8) {
      moved = true;
      clearLongPress();
    }
    if (dragging || inCanvas(e.target)) {
      e.preventDefault();
      fire(document, 'mousemove', touch, 1);
    }
  };

  const onTouchEnd = (e) => {
    clearLongPress();
    const touch = e.changedTouches && e.changedTouches[0];

    if (pinch) {
      if (e.touches.length < 2) pinch = null;
      return;
    }

    if (!startPoint || !touch) {
      startPoint = null;
      return;
    }

    if (dragging) {
      fire(document, 'mouseup', touch, 0);
      dragging = false;
    }

    const dx = touch.clientX - startPoint.clientX;
    const dy = touch.clientY - startPoint.clientY;
    const isTap = !moved && Math.hypot(dx, dy) <= 12;

    if (isTap && startTarget) {
      const now = Date.now();
      if (lastTap && now - lastTap.at < 320 && Math.hypot(touch.clientX - lastTap.x, touch.clientY - lastTap.y) < 32) {
        fire(startTarget, 'dblclick', touch, 0);
        lastTap = null;
      } else {
        lastTap = { at: now, x: touch.clientX, y: touch.clientY, target: startTarget };
      }
    } else {
      lastTap = null;
    }

    startPoint = null;
    startTarget = null;
    moved = false;
  };

  document.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
  document.addEventListener('touchend', onTouchEnd, { passive: false, capture: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: false, capture: true });

  // 长按弹出的菜单不要被那次抬手顺带关掉
  document.addEventListener(
    'click',
    (e) => {
      if (suppressClick) {
        suppressClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );

  // iOS 偶发把双击识别成页面缩放，这里兜底禁掉
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  // 软键盘弹出时保持编辑区可见
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onResize = () => {
      document.documentElement.style.setProperty('--mushu-vvh', vv.height + 'px');
      if (document.activeElement && isEditable(document.activeElement)) {
        document.activeElement.scrollIntoView({ block: 'nearest' });
      }
    };
    vv.addEventListener('resize', onResize);
    onResize();
  }
}

/** 窄屏（iPad 竖屏）默认收起右侧栏，给正文留出宽度 */
function adaptLayout() {
  const apply = () => {
    const narrow = window.innerWidth < 920;
    document.body.classList.toggle('mushu-narrow', narrow);
    if (narrow) {
      const close = document.getElementById('rail-right-close');
      const panel = document.getElementById('panel');
      if (close && panel && !panel.classList.contains('collapsed')) close.click();
    }
  };
  apply();
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
  window.addEventListener('resize', apply);
}

module.exports = { install, adaptLayout };
