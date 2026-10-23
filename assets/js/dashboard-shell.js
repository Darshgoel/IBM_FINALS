/* ────────────────────────────────────────────────────────────────────────
   FoodBridge — shared dashboard shell behaviour.
   Adds the consistent brand mark, accessible mobile navigation and
   honest disabled semantics without touching portal business logic.
   ──────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  const BRAND_SVG = `
    <svg class="brand-mark" viewBox="0 0 44 44" aria-hidden="true" focusable="false">
      <path d="M22 40C10.4 40 4.5 31.7 4.5 19.5 4.5 8.8 11 3.5 22 3.5s17.5 5.3 17.5 16C39.5 31.7 33.6 40 22 40Z" fill="#13833B"/>
      <path d="M22 39V18.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M22 27.5c-7.2 0-11.3-4.1-11.3-10.3 7.2 0 11.3 4.1 11.3 10.3Z" fill="#FF781F"/>
      <path d="M22 23c6 0 9.5-3.6 9.5-9.1-6 0-9.5 3.6-9.5 9.1Z" fill="#9AF2A8"/>
    </svg>`;

  function replaceBrandMarks() {
    document.querySelectorAll('.sidebar-brand .mark, .brand-icon').forEach(node => {
      if (node.querySelector('svg.brand-mark')) return;
      node.innerHTML = BRAND_SVG;
      node.setAttribute('aria-hidden', 'true');
    });
  }

  function setupMobileNav() {
    const sidebar = document.getElementById('sidebar') || document.querySelector('.sidebar');
    if (!sidebar) return;

    let toggle = document.querySelector('.nav-toggle, .menu-toggle, .fb-mobile-nav-toggle');
    let backdrop = document.getElementById('sidebar-backdrop') || document.querySelector('.sidebar-backdrop');

    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'fb-mobile-nav-toggle';
      toggle.setAttribute('aria-label', 'Open navigation menu');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', sidebar.id || 'sidebar');
      toggle.innerHTML = '☰';
      const host = document.querySelector('.topbar-left') || document.querySelector('.topbar') || document.querySelector('.main, .main-wrapper');
      if (host) host.insertBefore(toggle, host.firstChild);
    }

    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'sidebar-backdrop';
      backdrop.id = 'sidebar-backdrop';
      backdrop.setAttribute('aria-hidden', 'true');
      document.body.insertBefore(backdrop, document.querySelector('.main, .main-wrapper'));
    }

    const isNativeToggle = toggle.classList.contains('nav-toggle') || toggle.classList.contains('menu-toggle');
    let lastFocused = null;

    function setOpen(open) {
      sidebar.classList.toggle('open', open);
      document.body.classList.toggle('nav-open', open);
      backdrop.classList.toggle('show', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');

      if (toggle.classList.contains('fb-mobile-nav-toggle')) {
        toggle.innerHTML = open ? '✕' : '☰';
      }

      if (open) {
        lastFocused = document.activeElement;
        const first = sidebar.querySelector('.nav-item, .sidebar-nav a, .sidebar-nav button');
        if (first && window.innerWidth <= 1000) setTimeout(() => first.focus(), 60);
      } else if (lastFocused && typeof lastFocused.focus === 'function') {
        lastFocused.focus();
        lastFocused = null;
      }
    }

    function isOpen() {
      return sidebar.classList.contains('open') || document.body.classList.contains('nav-open');
    }

    // Portal-native toggles often have their own inline handlers. Only add
    // shared behaviour where the portal did not already provide it.
    if (!isNativeToggle) {
      toggle.addEventListener('click', () => setOpen(!isOpen()));
      backdrop.addEventListener('click', () => setOpen(false));
    }

    sidebar.querySelectorAll('.nav-item, .sidebar-nav a').forEach(item => {
      item.addEventListener('click', () => {
        if (window.innerWidth <= 1000) setOpen(false);
      });
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isOpen()) setOpen(false);
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 1000 && isOpen()) setOpen(false);
    });
  }

  function markUnavailableControls() {
    document.querySelectorAll('.nav-item.locked, .nav-item[data-coming-soon], .nav-item .coming-soon').forEach(item => {
      const button = item.closest('.nav-item') || item;
      if (button.tagName === 'BUTTON') {
        button.setAttribute('aria-disabled', 'true');
        if (!button.title) button.title = 'This capability is not available yet';
      }
    });

    document.querySelectorAll('.coming-soon-panel').forEach(panel => {
      panel.setAttribute('role', 'status');
      panel.setAttribute('aria-live', 'polite');
    });
  }

  function makeTablesScrollable() {
    document.querySelectorAll('table').forEach(table => {
      if (!table.parentElement.classList.contains('table-wrap')) {
        table.parentElement.classList.add('table-scroll');
      }
    });
  }

  function init() {
    replaceBrandMarks();
    setupMobileNav();
    markUnavailableControls();
    makeTablesScrollable();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
