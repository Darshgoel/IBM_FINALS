/**
 * FoodBridge — shared portal UI behaviour
 *
 * Shared shell affordances only: icon sprite, mobile navigation, account menu,
 * accessible confirmation dialog and a consistent toast helper. Portal
 * business logic remains in each portal's dashboard.js.
 */
(function () {
  'use strict';

  const SPRITE = `
  <svg class="fb-sprite" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
    <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/></symbol>
    <symbol id="i-home" viewBox="0 0 24 24"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></symbol>
    <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
    <symbol id="i-package" viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.4 7.7 7.6 4.4 7.6-4.4M12 12.1V21"/><path d="m8 5.2 8 4.6"/></symbol>
    <symbol id="i-box" viewBox="0 0 24 24"><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z"/><path d="M4.5 7.8 12 12l7.5-4.2M12 12v9"/></symbol>
    <symbol id="i-leaf" viewBox="0 0 24 24"><path d="M20 4C12 4 5.5 7.5 5.5 14.5c0 2.8 1.7 4.7 4.4 4.7C16.5 19.2 20 12 20 4Z"/><path d="M4 21c1.3-4.2 3.8-7.3 7.5-9.5"/></symbol>
    <symbol id="i-sparkles" viewBox="0 0 24 24"><path d="m12 3 1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8L12 3Z"/><path d="m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14ZM5 15l.6 1.6L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.4L5 15Z"/></symbol>
    <symbol id="i-building" viewBox="0 0 24 24"><path d="M4 21V5.8A1.8 1.8 0 0 1 5.8 4h8.4A1.8 1.8 0 0 1 16 5.8V21"/><path d="M16 9h2.2A1.8 1.8 0 0 1 20 10.8V21"/><path d="M8 8h4M8 12h4M8 16h4M2 21h20"/></symbol>
    <symbol id="i-logout" viewBox="0 0 24 24"><path d="M10 5H5.8A1.8 1.8 0 0 0 4 6.8v10.4A1.8 1.8 0 0 0 5.8 19H10"/><path d="M14 8l4 4-4 4M8 12h10"/></symbol>
    <symbol id="i-bell" viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4"/></symbol>
    <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
    <symbol id="i-chevron" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></symbol>
    <symbol id="i-chevron-right" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
    <symbol id="i-arrow-right" viewBox="0 0 24 24"><path d="M4 12h16M14 6l6 6-6 6"/></symbol>
    <symbol id="i-arrow-up-right" viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></symbol>
    <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 7v5h-5"/><path d="M19.2 12a7.4 7.4 0 1 0-1.9 6.4"/></symbol>
    <symbol id="i-search" viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 4 4"/></symbol>
    <symbol id="i-filter" viewBox="0 0 24 24"><path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"/></symbol>
    <symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></symbol>
    <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.5 2"/></symbol>
    <symbol id="i-pin" viewBox="0 0 24 24"><path d="M20 10c0 5.2-8 11-8 11S4 15.2 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></symbol>
    <symbol id="i-truck" viewBox="0 0 24 24"><path d="M3 6h10v10H3z"/><path d="M13 9h4l3 3v4h-7z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/></symbol>
    <symbol id="i-check" viewBox="0 0 24 24"><path d="m4.5 12.5 5 5 10-11"/></symbol>
    <symbol id="i-check-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12.2 2.7 2.7 5.5-6"/></symbol>
    <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></symbol>
    <symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4.5M12 17h.01"/></symbol>
    <symbol id="i-alert-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.5h.01"/></symbol>
    <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/></symbol>
    <symbol id="i-users" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.4a3 3 0 0 1 0 5.2"/><path d="M18 14.4a5 5 0 0 1 2.5 4.3"/></symbol>
    <symbol id="i-target" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.5"/></symbol>
    <symbol id="i-trending-up" viewBox="0 0 24 24"><path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/></symbol>
    <symbol id="i-chart" viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></symbol>
    <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3 5 6v5.2c0 4.5 2.9 8.1 7 9.8 4.1-1.7 7-5.3 7-9.8V6l-7-3Z"/><path d="m9.2 12 1.9 1.9 3.8-4.1"/></symbol>
    <symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></symbol>
    <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></symbol>
    <symbol id="i-settings" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></symbol>
    <symbol id="i-wallet" viewBox="0 0 24 24"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H20v16H6.5A2.5 2.5 0 0 1 4 17.5v-11Z"/><path d="M4 7h16M15 12h5"/></symbol>
    <symbol id="i-recycle" viewBox="0 0 24 24"><path d="m7.5 7 2-3.5a2 2 0 0 1 3.4 0l1.6 2.8"/><path d="m17 8 2.5 4.3a2 2 0 0 1-1.7 3H14"/><path d="m9 21-3.5-.1a2 2 0 0 1-1.7-3L5.7 14"/><path d="m10.2 9.2-2.4 1.4M13.8 15.4l2.4 1.4M8 18.2l2.2-1.3"/></symbol>
    <symbol id="i-network" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="18" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M10.6 6.9 6.4 16M13.4 6.9l4.2 9.1M7.2 18h9.6"/></symbol>
    <symbol id="i-utensils" viewBox="0 0 24 24"><path d="M6 2v8M3 2v5a3 3 0 0 0 6 0V2M6 10v12M15 2v20M15 2c3 1.3 4 4.1 4 7h-4"/></symbol>
    <symbol id="i-heart" viewBox="0 0 24 24"><path d="M20.8 5.8a5 5 0 0 0-7.1 0L12 7.5l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21l8.8-8.1a5 5 0 0 0 0-7.1Z"/></symbol>
    <symbol id="i-mail" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></symbol>
    <symbol id="i-phone" viewBox="0 0 24 24"><path d="M21 16.9v2.6a1.8 1.8 0 0 1-2 1.8 18.5 18.5 0 0 1-8.1-2.9 18.2 18.2 0 0 1-5.6-5.6A18.5 18.5 0 0 1 2.4 4.7a1.8 1.8 0 0 1 1.8-2h2.6a1.8 1.8 0 0 1 1.8 1.6c.1 1 .4 2 .7 2.9a1.8 1.8 0 0 1-.4 1.9L7.7 10.3a14.8 14.8 0 0 0 6 6l1.2-1.2a1.8 1.8 0 0 1 1.9-.4c.9.3 1.9.6 2.9.7a1.8 1.8 0 0 1 1.3 1.5Z"/></symbol>
    <symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.5 3.6 5.6 3.6 9S14.4 18.5 12 21c-2.4-2.5-3.6-5.6-3.6-9S9.6 5.5 12 3Z"/></symbol>
    <symbol id="i-lock" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></symbol>
    <symbol id="i-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></symbol>
    <symbol id="i-lightbulb" viewBox="0 0 24 24"><path d="M9 18h6M10 21h4"/><path d="M8.2 14.4A6 6 0 1 1 15.8 14.4C14.7 15.3 14 16.1 14 18h-4c0-1.9-.7-2.7-1.8-3.6Z"/></symbol>
    <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 3v11M8 10l4 4 4-4M4 20h16"/></symbol>
    <symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 16V3M8 7l4-4 4 4M4 20h16"/></symbol>
    <symbol id="i-file" viewBox="0 0 24 24"><path d="M14 3H6.8A1.8 1.8 0 0 0 5 4.8v14.4A1.8 1.8 0 0 0 6.8 21h10.4a1.8 1.8 0 0 0 1.8-1.8V8l-5-5Z"/><path d="M14 3v5h5M8.5 13h7M8.5 17h5"/></symbol>
    <symbol id="i-activity" viewBox="0 0 24 24"><path d="M3 12h4l2.2-6 4.1 12L15.4 12H21"/></symbol>
    <symbol id="i-scale" viewBox="0 0 24 24"><path d="M12 3v18M5 7h14M6.5 7 3 15h7L6.5 7ZM17.5 7 14 15h7l-3.5-8Z"/><path d="M8 21h8"/></symbol>
    <symbol id="i-route" viewBox="0 0 24 24"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h3a4 4 0 0 0 4-4V9a4 4 0 0 1 4-4"/></symbol>
    <symbol id="i-inbox" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/><path d="M4 14h4l2 3h4l2-3h4"/></symbol>
    <symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></symbol>
    <symbol id="i-map" viewBox="0 0 24 24"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></symbol>
    <symbol id="i-clock-fast" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></symbol>
  </svg>`;

  function injectSprite() {
    if (document.querySelector('.fb-sprite')) return;
    const host = document.createElement('div');
    host.innerHTML = SPRITE;
    document.body.insertBefore(host.firstElementChild, document.body.firstChild);
  }

  function setupMobileNav() {
    const sidebar = document.getElementById('sidebar');
    const toggle = document.querySelector('.nav-toggle, .fb-mobile-nav-toggle');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!sidebar || !toggle || !backdrop) return;

    let lastFocus = null;

    function setOpen(open) {
      sidebar.classList.toggle('open', open);
      document.body.classList.toggle('nav-open', open);
      backdrop.classList.toggle('show', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
      if (open) {
        lastFocus = document.activeElement;
        const first = sidebar.querySelector('.nav-item');
        if (first && window.innerWidth <= 1024) setTimeout(() => first.focus(), 40);
      } else if (lastFocus && typeof lastFocus.focus === 'function') {
        lastFocus.focus();
        lastFocus = null;
      }
    }

    toggle.addEventListener('click', () => setOpen(!sidebar.classList.contains('open')));
    backdrop.addEventListener('click', () => setOpen(false));
    sidebar.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        if (window.innerWidth <= 1024) setOpen(false);
      });
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && sidebar.classList.contains('open')) setOpen(false);
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 1024 && sidebar.classList.contains('open')) setOpen(false);
    });
  }

  function setupAccountMenu() {
    const trigger = document.querySelector('[data-account-toggle]');
    const menu = document.querySelector('[data-account-menu]');
    if (!trigger || !menu) return;

    function close() {
      menu.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.addEventListener('click', event => {
      event.stopPropagation();
      const open = !menu.classList.contains('open');
      menu.classList.toggle('open', open);
      trigger.setAttribute('aria-expanded', String(open));
      const first = menu.querySelector('button, a');
      if (open && first) setTimeout(() => first.focus(), 30);
    });

    document.addEventListener('click', event => {
      if (!menu.contains(event.target) && !trigger.contains(event.target)) close();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
    });
    menu.querySelectorAll('.account-menu-item').forEach(item => item.addEventListener('click', close));
  }

  let dialogResolve = null;
  let dialogLastFocus = null;

  function ensureDialog() {
    let dialog = document.getElementById('fb-confirm-dialog');
    if (dialog) return dialog;

    dialog = document.createElement('div');
    dialog.className = 'fb-dialog';
    dialog.id = 'fb-confirm-dialog';
    dialog.setAttribute('aria-hidden', 'true');
    dialog.innerHTML = `
      <div class="fb-dialog-backdrop" data-dialog-cancel></div>
      <div class="fb-dialog-card" role="dialog" aria-modal="true" aria-labelledby="fb-confirm-title" aria-describedby="fb-confirm-message">
        <div class="fb-dialog-icon" id="fb-confirm-icon"><svg class="icon" aria-hidden="true"><use href="#i-alert"></use></svg></div>
        <h3 id="fb-confirm-title">Confirm action</h3>
        <p id="fb-confirm-message"></p>
        <div class="fb-dialog-details" id="fb-confirm-details" hidden></div>
        <div class="fb-dialog-actions">
          <button type="button" class="btn" id="fb-confirm-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="fb-confirm-ok">Confirm</button>
        </div>
      </div>`;
    document.body.appendChild(dialog);

    dialog.querySelector('[data-dialog-cancel]').addEventListener('click', () => finish(false));
    dialog.querySelector('#fb-confirm-cancel').addEventListener('click', () => finish(false));
    dialog.querySelector('#fb-confirm-ok').addEventListener('click', () => finish(true));

    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    return dialog;
  }

  function finish(value) {
    const dialog = document.getElementById('fb-confirm-dialog');
    if (!dialog) return;
    dialog.classList.remove('open');
    dialog.setAttribute('aria-hidden', 'true');
    if (dialogLastFocus && typeof dialogLastFocus.focus === 'function') dialogLastFocus.focus();
    dialogLastFocus = null;
    if (dialogResolve) {
      const resolve = dialogResolve;
      dialogResolve = null;
      resolve(Boolean(value));
    }
  }

  window.fbConfirm = function (options = {}) {
    const dialog = ensureDialog();
    const title = options.title || 'Confirm action';
    const message = options.message || 'Are you sure you want to continue?';
    const confirmLabel = options.confirmLabel || 'Confirm';
    const cancelLabel = options.cancelLabel || 'Cancel';
    const tone = options.tone || 'default';

    const icon = dialog.querySelector('#fb-confirm-icon');
    icon.className = 'fb-dialog-icon' + (tone === 'danger' ? ' danger' : tone === 'warning' ? ' warning' : '');
    icon.querySelector('use').setAttribute('href', tone === 'danger' || tone === 'warning' ? '#i-alert' : '#i-info');
    dialog.querySelector('#fb-confirm-title').textContent = title;
    dialog.querySelector('#fb-confirm-message').textContent = message;
    const details = dialog.querySelector('#fb-confirm-details');
    if (options.details) {
      details.innerHTML = options.details;
      details.hidden = false;
    } else {
      details.textContent = '';
      details.hidden = true;
    }
    const ok = dialog.querySelector('#fb-confirm-ok');
    ok.textContent = confirmLabel;
    ok.className = 'btn ' + (tone === 'danger' ? 'btn-danger' : 'btn-primary');
    dialog.querySelector('#fb-confirm-cancel').textContent = cancelLabel;

    dialogLastFocus = document.activeElement;
    dialog.classList.add('open');
    dialog.setAttribute('aria-hidden', 'false');
    setTimeout(() => ok.focus(), 30);

    return new Promise(resolve => { dialogResolve = resolve; });
  };

  window.fbIcon = function (name, className = 'icon') {
    return `<svg class="${className}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
  };

  window.fbToast = function (message, type = 'info', timeout = 4200) {
    let host = document.getElementById('toast-container');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-container';
      host.className = 'toast-container';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const icons = { success: 'check-circle', error: 'alert-circle', warn: 'alert', info: 'info' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = window.fbIcon(icons[type] || 'info', 'icon');
    const copy = document.createElement('span');
    copy.textContent = String(message == null ? '' : message);
    toast.append(icon, copy);
    host.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(4px)';
      setTimeout(() => toast.remove(), 160);
    }, timeout);
  };

  window.closeSidebar = function () {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!sidebar) return;
    sidebar.classList.remove('open');
    document.body.classList.remove('nav-open');
    if (backdrop) backdrop.classList.remove('show');
  };

  document.addEventListener('DOMContentLoaded', () => {
    injectSprite();
    setupMobileNav();
    setupAccountMenu();
  });
})();
