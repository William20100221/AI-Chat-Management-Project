'use strict';

// Thin scrollbars that only show while you scroll, like on phones and in modern apps: a short
// line at the right edge whose length shows how much there is to read (the longer the content,
// the shorter the line). It fades out a moment after you stop, and can be dragged while shown.
//
// Any element with data-thin-scroll gets one. The line sits in the element's parent, next to it,
// so it never scrolls along with the content.
(() => {
  const HIDE_AFTER_MS = 900;
  const MIN_THUMB = 24;

  function attach(scroller) {
    if (scroller.dataset.thinScrollReady) return;
    scroller.dataset.thinScrollReady = '1';
    const parent = scroller.parentElement;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

    const bar = document.createElement('div');
    bar.className = 'thin-scrollbar';
    bar.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('div');
    thumb.className = 'thin-thumb';
    bar.append(thumb);
    parent.append(bar);

    let hideTimer = null;
    let dragging = null; // { startY, startScroll, ratio }

    // Places the line over the scroller's right edge and sizes the thumb to the content.
    function layout() {
      const { scrollHeight, clientHeight, scrollTop } = scroller;
      if (scrollHeight <= clientHeight + 1) return false; // nothing to scroll
      const box = scroller.getBoundingClientRect();
      const home = parent.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(scroller).borderTopRightRadius) || 0;
      const inset = Math.max(4, radius * 0.6); // stay clear of rounded corners
      const track = box.height - inset * 2;
      const size = Math.max(MIN_THUMB, (track * clientHeight) / scrollHeight);
      const travel = track - size;
      const top = travel * (scrollTop / (scrollHeight - clientHeight));
      bar.style.top = `${box.top - home.top + parent.scrollTop - parent.clientTop + inset}px`;
      bar.style.left = `${box.right - home.left + parent.scrollLeft - parent.clientLeft - 12}px`;
      bar.style.height = `${track}px`;
      thumb.style.height = `${size}px`;
      thumb.style.transform = `translateY(${top}px)`;
      return { travel, room: scrollHeight - clientHeight };
    }

    function show() {
      if (!layout()) return;
      bar.classList.add('visible');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!dragging) bar.classList.remove('visible');
      }, HIDE_AFTER_MS);
    }

    scroller.addEventListener('scroll', show, { passive: true });

    thumb.addEventListener('pointerdown', (event) => {
      const geometry = layout();
      if (!geometry || !geometry.travel) return;
      event.preventDefault();
      thumb.setPointerCapture(event.pointerId);
      dragging = { startY: event.clientY, startScroll: scroller.scrollTop, ratio: geometry.room / geometry.travel };
      bar.classList.add('dragging', 'visible');
    });
    thumb.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      scroller.scrollTop = dragging.startScroll + (event.clientY - dragging.startY) * dragging.ratio;
    });
    const stop = () => {
      if (!dragging) return;
      dragging = null;
      bar.classList.remove('dragging');
      show(); // fade out a moment after letting go
    };
    thumb.addEventListener('pointerup', stop);
    thumb.addEventListener('pointercancel', stop);
  }

  function attachAll(root = document) {
    for (const scroller of root.querySelectorAll('[data-thin-scroll]')) attach(scroller);
  }

  window.thinScrollbars = { attach, attachAll };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => attachAll());
  else attachAll();
})();
