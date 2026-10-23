/* ────────────────────────────────────────────────────────────────────────
   FoodBridge — shared portal authentication behaviour.
   Uses the existing /api/auth endpoints and fb_token / fb_user session.
   Configured entirely by data attributes on <body>.
   ──────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  const ROLE_ROUTES = {
    donor: '/donor/dashboard.html',
    demand_org: '/demand-org/dashboard.html',
    recipient: '/recipient/',
    network_intelligence: '/network-intelligence/dashboard.html',
    network_admin: '/network-intelligence/dashboard.html',
    admin: '/admin/dashboard.html'
  };

  const body = document.body;
  const portalName = body.dataset.portal || 'FoodBridge';
  const allowedRoles = String(body.dataset.roles || body.dataset.role || '')
    .split(',').map(role => role.trim()).filter(Boolean);
  const redirectTo = body.dataset.redirect || 'auto';
  const registerRole = body.dataset.registerRole || '';
  const hasRegister = Boolean(registerRole);

  const $ = id => document.getElementById(id);

  function getSession() {
    try {
      const token = localStorage.getItem('fb_token');
      const user = JSON.parse(localStorage.getItem('fb_user') || 'null');
      return token && user ? { token, user } : null;
    } catch (err) {
      return null;
    }
  }

  function routeFor(role) {
    return ROLE_ROUTES[role] || '/';
  }

  function destinationFor(role) {
    return redirectTo === 'auto' ? routeFor(role) : redirectTo;
  }

  function showAlert(id, message, type) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.className = `auth-alert ${type} show`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  }

  function clearAlert(id) {
    const el = $(id);
    if (el) {
      el.textContent = '';
      el.className = 'auth-alert';
    }
  }

  function setLoading(button, loading, label) {
    if (!button) return;
    // Remember the button's real label before replacing it with a loading
    // state, so a failed request restores "Sign in" rather than "Signing in…".
    if (!button.dataset.label) button.dataset.label = button.textContent.trim();
    button.disabled = loading;
    if (loading) {
      button.innerHTML = '<span class="spinner" aria-hidden="true"></span> ' + (label || 'Please wait…');
    } else {
      button.textContent = button.dataset.label || label || 'Continue';
    }
  }

  function togglePassword(button) {
    const input = document.getElementById(button.dataset.target);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? 'Hide' : 'Show';
    button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  }

  function switchTab(name) {
    const isRegister = name === 'register' && hasRegister;
    const signinTab = $('authTabSignin');
    const registerTab = $('authTabRegister');
    const signinPane = $('authPaneSignin');
    const registerPane = $('authPaneRegister');
    if (!signinTab || !registerTab || !signinPane || !registerPane) return;

    signinTab.classList.toggle('active', !isRegister);
    registerTab.classList.toggle('active', isRegister);
    signinTab.setAttribute('aria-selected', String(!isRegister));
    registerTab.setAttribute('aria-selected', String(isRegister));
    signinPane.classList.toggle('active', !isRegister);
    registerPane.classList.toggle('active', isRegister);

    clearAlert('authLoginError');
    clearAlert('authRegisterError');
    const focusTarget = isRegister ? $('regName') : $('loginEmail');
    if (focusTarget) focusTarget.focus();
  }

  function collectRegistrationPayload() {
    const val = id => {
      const el = $(id);
      return el ? String(el.value || '').trim() : '';
    };

    const payload = {
      name: val('regName'),
      email: val('regEmail'),
      password: val('regPassword'),
      role: registerRole,
      orgName: val('regOrgName'),
      orgType: val('regOrgType'),
      locationAddress: val('regAddress'),
      contactPhone: val('regPhone'),
      operatingHours: val('regHours')
    };

    if (registerRole === 'demand_org') {
      const capacity = val('regCapacity');
      payload.description = 'Community organisation registered through the FoodBridge NGO portal.';
      if (capacity) payload.description += ` Daily meal capacity: ${capacity}.`;
    } else {
      payload.description = 'Food donor registered through the FoodBridge donor portal.';
    }

    return payload;
  }

  function validateRegistration(payload) {
    if (!payload.name || !payload.email || !payload.password || !payload.orgName) {
      return 'Name, email, password and organisation name are required.';
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      return 'Please enter a valid email address.';
    }
    if (payload.password.length < 8) {
      return 'Password must be at least 8 characters.';
    }
    if (!/[A-Za-z]/.test(payload.password) || !/[0-9]/.test(payload.password)) {
      return 'Password must include at least one letter and one number.';
    }
    return '';
  }

  async function handleLogin() {
    clearAlert('authLoginError');
    const emailEl = $('loginEmail');
    const passwordEl = $('loginPassword');
    const button = $('loginButton');
    const email = emailEl ? emailEl.value.trim() : '';
    const password = passwordEl ? passwordEl.value : '';

    if (!email || !password) {
      showAlert('authLoginError', 'Please enter your email and password.', 'error');
      (email ? passwordEl : emailEl).focus();
      return;
    }

    setLoading(button, true, 'Signing in…');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Sign in failed. Please try again.');

      if (allowedRoles.length && !allowedRoles.includes(data.user.role)) {
        throw new Error(`This is the ${portalName} portal. Your account does not have access to it.`);
      }

      localStorage.setItem('fb_token', data.token);
      localStorage.setItem('fb_user', JSON.stringify(data.user));

      const pill = $('rolePill');
      if (pill) {
        const label = $('rolePillLabel');
        if (label) label.textContent = `${data.user.name || data.user.email} — redirecting to your dashboard…`;
        pill.classList.add('show');
      }

      const destination = destinationFor(data.user.role);
      setTimeout(() => { window.location.href = destination; }, pill ? 420 : 80);
    } catch (err) {
      showAlert('authLoginError', err.message || 'Sign in failed. Please try again.', 'error');
      setLoading(button, false, 'Sign in');
    }
  }

  async function handleRegister() {
    clearAlert('authRegisterError');
    clearAlert('authRegisterSuccess');
    const payload = collectRegistrationPayload();
    const validation = validateRegistration(payload);
    if (validation) {
      showAlert('authRegisterError', validation, 'error');
      return;
    }

    const button = $('registerButton');
    setLoading(button, true, 'Creating account…');
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Registration failed. Please try again.');

      const form = $('registerForm');
      if (form) form.reset();
      showAlert(
        'authRegisterSuccess',
        `Account created for ${payload.orgName}. Your organisation is pending verification, so posting or matching unlocks after a coordinator approves it. You can sign in while verification is pending.`,
        'success'
      );
      const notice = $('pendingNotice');
      if (notice) notice.hidden = false;
      setLoading(button, false, 'Create account');
      setTimeout(() => switchTab('signin'), 1800);
    } catch (err) {
      showAlert('authRegisterError', err.message || 'Registration failed. Please try again.', 'error');
      setLoading(button, false, 'Create account');
    }
  }

  function init() {
    const session = getSession();
    if (session && (!allowedRoles.length || allowedRoles.includes(session.user.role))) {
      window.location.href = destinationFor(session.user.role);
      return;
    }

    const signinTab = $('authTabSignin');
    const registerTab = $('authTabRegister');
    if (signinTab) signinTab.addEventListener('click', () => switchTab('signin'));
    if (registerTab) registerTab.addEventListener('click', () => switchTab('register'));

    document.querySelectorAll('[data-password-toggle]').forEach(button => {
      button.addEventListener('click', () => togglePassword(button));
    });

    const loginForm = $('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', event => {
        event.preventDefault();
        handleLogin();
      });
    }

    const registerForm = $('registerForm');
    if (registerForm) {
      registerForm.addEventListener('submit', event => {
        event.preventDefault();
        handleRegister();
      });
    }

    document.querySelectorAll('[data-go-signin]').forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        switchTab('signin');
      });
    });

    document.querySelectorAll('[data-go-register]').forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        switchTab('register');
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
