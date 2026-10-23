/* ────────────────────────────────────────────────────────────────────────
   FoodBridge — shared public-page behaviour.
   Session-aware navigation, contact submission and live impact data.
   ──────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  const ROLE_ROUTES = {
    donor: '/donor/',
    demand_org: '/demand-org/',
    recipient: '/recipient/',
    network_admin: '/network-intelligence/',
    network_intelligence: '/network-intelligence/',
    admin: '/admin/'
  };

  function $(id) { return document.getElementById(id); }

  function formatNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-IN') : '—';
  }

  function getSession() {
    try {
      const token = localStorage.getItem('fb_token');
      const user = JSON.parse(localStorage.getItem('fb_user') || 'null');
      return token && user ? { token, user } : null;
    } catch (err) {
      return null;
    }
  }

  function routeForRole(role) {
    return ROLE_ROUTES[role] || '/';
  }

  /* ── Mobile navigation ───────────────────────────────────────────────── */
  function setupMobileMenu() {
    const toggle = $('publicMenuToggle');
    const menu = $('publicMobileMenu');
    if (!toggle || !menu) return;

    function close() {
      menu.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open menu');
      toggle.textContent = '☰';
    }

    toggle.addEventListener('click', () => {
      const isOpen = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
      toggle.textContent = isOpen ? '✕' : '☰';
    });

    menu.querySelectorAll('a').forEach(link => link.addEventListener('click', close));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
    });
  }

  /* ── Session-aware header ────────────────────────────────────────────── */
  function setupSessionNav() {
    const session = getSession();
    const login = $('publicLogin');
    const signup = $('publicSignup');
    const mobileAuth = $('publicMobileAuth');

    function render(host) {
      if (!host) return;
      if (!session) return;
      host.innerHTML = `<a class="btn-signup" href="${routeForRole(session.user.role)}">Dashboard</a>
         <button class="btn-login" type="button" data-public-logout>Log out</button>`;
    }

    if (session) {
      if (login) {
        login.textContent = 'Dashboard';
        login.className = 'btn-signup';
        login.setAttribute('href', routeForRole(session.user.role));
      }
      if (signup) {
        // A real button, not an href="#" anchor: signing out changes local state
        // and should be announced as an action rather than a navigation link.
        signup.outerHTML = '<button class="btn-login" id="publicSignup" type="button" data-public-logout>Log out</button>';
      }
      if (mobileAuth) render(mobileAuth);
    }

    document.querySelectorAll('[data-public-logout]').forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        localStorage.removeItem('fb_token');
        localStorage.removeItem('fb_user');
        window.location.reload();
      });
    });
  }

  /* ── Live access-point data ─────────────────────────────────────────── */
  async function loadImpact() {
    const targets = document.querySelectorAll('[data-stat]');
    if (!targets.length) return;

    try {
      const response = await fetch('/api/recipient/search', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Access-point directory unavailable');
      const data = await response.json();
      const points = Array.isArray(data.accessPoints) ? data.accessPoints : [];
      const values = {
        points: formatNumber(points.length),
        partners: formatNumber(points.length),
        incoming: formatNumber(points.reduce((sum, p) => sum + (Number(p.activeIncoming) || 0), 0)),
        areas: formatNumber(new Set(points.map(p => (p.location_address || '').split(',').pop().trim()).filter(Boolean)).size),
        servings: formatNumber(points.reduce((sum, p) => sum + (Number(p.serving_capacity) || 0), 0)),
        meals: formatNumber(points.reduce((sum, p) => sum + (Number(p.serving_capacity) || 0), 0)),
        people: formatNumber(points.reduce((sum, p) => sum + (Number(p.serving_capacity) || 0), 0)),
        co2: '—',
        handovers: '—'
      };
      targets.forEach(node => {
        const key = node.getAttribute('data-stat');
        if (Object.prototype.hasOwnProperty.call(values, key)) {
          node.textContent = values[key];
        }
      });
      const basis = $('impactBasis');
      if (basis) basis.textContent = 'Verified access-point directory. No completed-handover totals are displayed without the public impact endpoint.';
      const updated = $('impactUpdated');
      if (updated) {
        updated.textContent = `Checked ${new Date().toLocaleTimeString('en-IN', {
          hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata'
        })} IST`;
      }
      loadImpactActivity(points);
    } catch (err) {
      const note = $('impactError');
      if (note) {
        note.hidden = false;
        note.textContent = 'The live access-point directory could not be loaded. Figures remain unavailable rather than estimated.';
      }
      targets.forEach(node => { if (node.textContent.trim() === '—') node.textContent = '—'; });
      loadImpactActivity([]);
    }
  }

  function loadImpactActivity(points) {
    const host = $('impactActivity');
    if (!host) return;

    if (!points || !points.length) {
      host.innerHTML = '<div class="ledger-row"><span>No verified access points are published yet.</span><span>—</span><span>—</span></div>';
      return;
    }

    host.innerHTML = `
      <div class="ledger-row head"><span>Verified access point</span><span>Capacity</span><span>Incoming</span></div>
      ${points.slice(0, 6).map(point => `
        <div class="ledger-row">
          <span><strong>${escapeHtml(point.name || 'Community food point')}</strong><br>${escapeHtml(point.location_address || 'Address not published')}</span>
          <span>${point.serving_capacity ? `${formatNumber(point.serving_capacity)} meals/day` : '—'}</span>
          <span class="ledger-status">${formatNumber(point.activeIncoming || 0)} active</span>
        </div>
      `).join('')}
    `;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── Contact form ────────────────────────────────────────────────────── */
  function setupContactForm() {
    const form = $('contactForm');
    if (!form) return;

    const status = $('contactStatus');
    const submit = $('contactSubmit');
    const fields = {
      name: $('contactName'),
      email: $('contactEmail'),
      organisation: $('contactOrg'),
      topic: $('contactTopic'),
      message: $('contactMessage')
    };

    function show(message, type) {
      if (!status) return;
      status.textContent = message;
      status.className = `form-status ${type} show`;
      status.setAttribute('role', type === 'error' ? 'alert' : 'status');
    }

    function clear() {
      if (status) status.className = 'form-status';
    }

    form.addEventListener('submit', async event => {
      event.preventDefault();
      clear();

      const name = fields.name ? fields.name.value.trim() : '';
      const email = fields.email ? fields.email.value.trim() : '';
      const organisation = fields.organisation ? fields.organisation.value.trim() : '';
      const topic = fields.topic ? fields.topic.value : 'general';
      const message = fields.message ? fields.message.value.trim() : '';

      if (!name || !email || !message) {
        show('Please add your name, email and a message.', 'error');
        (!name ? fields.name : !email ? fields.email : fields.message).focus();
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        show('Please enter a valid email address.', 'error');
        fields.email.focus();
        return;
      }
      if (message.length < 20) {
        show('Please add a little more detail — at least 20 characters.', 'error');
        fields.message.focus();
        return;
      }

      if (submit) {
        submit.disabled = true;
        submit.dataset.label = submit.textContent;
        submit.textContent = 'Sending…';
      }

      try {
        const topicLabels = {
          general: 'General enquiry', donation: 'Surplus food donation',
          ngo_partnership: 'NGO or community partnership',
          access: 'Food access', media: 'Media', safety: 'Food safety concern'
        };
        const subject = `[FoodBridge] ${topicLabels[topic] || 'Website enquiry'}`;
        const body = [
          `Name: ${name}`,
          `Email: ${email}`,
          organisation ? `Organisation: ${organisation}` : '',
          `Topic: ${topicLabels[topic] || topic}`,
          '',
          message
        ].filter(Boolean).join('\n');

        window.location.href = `mailto:hello@foodbridge.org?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        show('Your email app is opening with this message. Send it to reach the FoodBridge team.', 'success');
        status.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (err) {
        show('Your message could not be prepared. Please email hello@foodbridge.org directly.', 'error');
      } finally {
        if (submit) {
          submit.disabled = false;
          submit.textContent = submit.dataset.label || 'Send message';
        }
      }
    });
  }

  function setupYear() {
    document.querySelectorAll('[data-year]').forEach(node => {
      node.textContent = String(new Date().getFullYear());
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupYear();
    setupMobileMenu();
    setupSessionNav();
    setupContactForm();
    loadImpact();
    loadImpactActivity();
  });
})();
