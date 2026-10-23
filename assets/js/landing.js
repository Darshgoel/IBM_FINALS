/* ────────────────────────────────────────────────────────────────────────
   FoodBridge — public landing page behaviour
   Auth reuses the existing /api/auth endpoints and fb_token / fb_user keys.
   ──────────────────────────────────────────────────────────────────────── */

const API = '/api';

const ROLE_ROUTES = {
  donor: '/donor/dashboard.html',
  demand_org: '/demand-org/dashboard.html',
  recipient: '/recipient/index.html',
  network_admin: '/network-intelligence/dashboard.html',
  network_intelligence: '/network-intelligence/dashboard.html',
  admin: '/admin/dashboard.html'
};

const CATEGORY_IMAGES = {
  cooked: 'assets/images/food-biryani.jpg',
  fruits: 'assets/images/food-fruits.jpg',
  vegetables: 'assets/images/food-vegetables.jpg',
  bakery: 'assets/images/food-bread.jpg',
  packaged: 'assets/images/food-dairy.jpg',
  other: 'assets/images/food-meals.jpg'
};

const CATEGORY_LABELS = {
  cooked: 'Cooked food',
  fruits: 'Fruits',
  vegetables: 'Vegetables',
  bakery: 'Bakery',
  packaged: 'Packaged food',
  other: 'Other food'
};

const state = {
  listings: [],
  points: [],
  map: null,
  markerLayer: null,
  search: '',
  category: '',
  mapReady: false,
  tileErrors: 0,
  toastTimer: null
};

/* ── Small helpers ─────────────────────────────────────────────────────── */
function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-IN') : '—';
}

function debounce(fn, delay) {
  let timer = null;
  return function () {
    const args = arguments;
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(null, args), delay);
  };
}

function showToast(message) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function syncBodyLock() {
  const open = document.querySelector('.modal.open');
  document.body.classList.toggle('modal-open', Boolean(open));
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

function saveSession(data) {
  localStorage.setItem('fb_token', data.token);
  localStorage.setItem('fb_user', JSON.stringify(data.user));
}

function routeForRole(role) {
  return ROLE_ROUTES[role] || '/';
}

/* ── Mobile navigation ─────────────────────────────────────────────────── */
function toggleMobileMenu() {
  const menu = $('mobileMenu');
  const toggle = $('menuToggle');
  if (!menu || !toggle) return;
  const isOpen = menu.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(isOpen));
  toggle.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
  toggle.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#${isOpen ? 'i-x' : 'i-menu'}"></use></svg>`;
}

function closeMobileMenu() {
  const menu = $('mobileMenu');
  const toggle = $('menuToggle');
  if (!menu || !toggle) return;
  menu.classList.remove('open');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Open menu');
  toggle.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-menu"></use></svg>';
}

/* ── Session-aware header buttons ──────────────────────────────────────── */
function updateSessionUI() {
  const session = getSession();
  const loginBtn = $('navLoginBtn');
  const signupBtn = $('navSignupBtn');
  const mobileAuth = $('mobileAuth');
  if (!loginBtn || !signupBtn) return;

  if (session) {
    loginBtn.textContent = 'Dashboard';
    loginBtn.className = 'btn-signup';
    loginBtn.onclick = () => { window.location.href = routeForRole(session.user.role); };

    signupBtn.textContent = 'Log out';
    signupBtn.className = 'btn-login';
    signupBtn.onclick = logout;
  } else {
    loginBtn.textContent = 'Login';
    loginBtn.className = 'btn-login';
    loginBtn.onclick = () => openAuth('signin');

    signupBtn.textContent = 'Sign Up';
    signupBtn.className = 'btn-signup';
    signupBtn.onclick = () => openAuth('signup');
  }

  if (mobileAuth) {
    mobileAuth.innerHTML = session
      ? `<button class="btn-signup" type="button" onclick="window.location.href='${routeForRole(session.user.role)}'">Dashboard</button>
         <button class="btn-login" type="button" onclick="logout()">Log out</button>`
      : `<button class="btn-login" type="button" onclick="openAuth('signin')">Login</button>
         <button class="btn-signup" type="button" onclick="openAuth('signup')">Sign Up</button>`;
  }
}

function logout() {
  localStorage.removeItem('fb_token');
  localStorage.removeItem('fb_user');
  updateSessionUI();
  closeMobileMenu();
  showToast('You have been signed out.');
}

/* ── Auth modal ────────────────────────────────────────────────────────── */
function openAuth(mode) {
  const modal = $('authModal');
  if (!modal) return;
  closeMobileMenu();
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  switchTab(mode === 'signup' ? 'signup' : 'signin');
  syncBodyLock();
  setTimeout(() => {
    const target = mode === 'signup' ? $('su-name') : $('si-email');
    if (target) target.focus();
  }, 60);
}

function closeAuth() {
  const modal = $('authModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  syncBodyLock();
}

function switchTab(tab) {
  const isSignin = tab !== 'signup';
  const tabSignin = $('tab-signin');
  const tabSignup = $('tab-signup');
  const paneSignin = $('pane-signin');
  const paneSignup = $('pane-signup');
  if (!tabSignin || !tabSignup || !paneSignin || !paneSignup) return;

  tabSignin.classList.toggle('active', isSignin);
  tabSignup.classList.toggle('active', !isSignin);
  tabSignin.setAttribute('aria-selected', String(isSignin));
  tabSignup.setAttribute('aria-selected', String(!isSignin));
  paneSignin.classList.toggle('active', isSignin);
  paneSignup.classList.toggle('active', !isSignin);
}

function clearErrors() {
  ['signin-error', 'signup-error', 'signup-success'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.textContent = '';
    el.className = 'msg' + (id === 'signup-success' ? ' success' : '');
  });
}

function showMsg(id, text, type) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `msg ${type || 'error'} show`;
}

function setLoading(button, loading, label) {
  if (!button) return;
  if (loading) {
    button.dataset.originalLabel = button.textContent;
    button.disabled = true;
    button.innerHTML = `<span class="loading-ring" style="width:14px;height:14px;border-width:2px;border-top-color:#fff"></span>${escapeHtml(label || 'Please wait…')}`;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalLabel || label || 'Continue';
  }
}

function togglePassword(inputId, button) {
  const input = $(inputId);
  if (!input) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  button.textContent = showing ? 'Show' : 'Hide';
}

function handleSignIn(event) {
  if (event && event.preventDefault) event.preventDefault();
  clearErrors();
  const email = ($('si-email').value || '').trim();
  const password = $('si-password').value || '';
  const button = $('signin-btn');

  if (!email || !password) {
    showMsg('signin-error', 'Please enter your email and password.');
    return;
  }

  setLoading(button, true, 'Signing in…');
  fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, scope: 'user' })
  })
    .then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sign in failed. Please try again.');
      return data;
    })
    .then(data => {
      saveSession(data);
      updateSessionUI();
      closeAuth();
      showToast(`Welcome back, ${data.user.name || 'friend'}.`);
      const destination = routeForRole(data.user.role);
      setTimeout(() => { window.location.href = destination; }, 450);
    })
    .catch(err => {
      showMsg('signin-error', err.message || 'Unable to sign in right now.');
    })
    .finally(() => setLoading(button, false, 'Sign In'));
}

/* ── Sign-up wizard ────────────────────────────────────────────────────── */
const signupData = {
  role: null,
  documentName: '',
  documentData: ''
};

function goStep(step) {
  clearErrors();
  const target = Number(step);

  if (target === 2) {
    const name = ($('su-name').value || '').trim();
    const email = ($('su-email').value || '').trim();
    const password = $('su-password').value || '';
    if (!name) {
      showMsg('signup-error', 'Please enter your name.');
      $('su-name').focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showMsg('signup-error', 'Please enter a valid email address.');
      $('su-email').focus();
      return;
    }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      showMsg('signup-error', 'Password must be at least 8 characters and include a letter and a number.');
      $('su-password').focus();
      return;
    }
  }

  if (target === 3) {
    if (!signupData.role) {
      showMsg('signup-error', 'Choose how you will use FoodBridge to continue.');
      return;
    }
    updateStep3();
  }

  document.querySelectorAll('#pane-signup .step-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `step-${target}`);
  });
  updateStepper(target);
}

function updateStepper(step) {
  for (let i = 1; i <= 3; i++) {
    const dot = $(`dot-${i}`);
    if (!dot) continue;
    dot.classList.toggle('active', i === step);
    dot.classList.toggle('done', i < step);
    dot.textContent = i < step ? '✓' : String(i);
  }
  for (let i = 1; i <= 2; i++) {
    const line = $(`line-${i}`);
    if (line) line.classList.toggle('done', step > i);
  }
}

function selectRole(role) {
  signupData.role = role;
  ['donor', 'demand_org', 'recipient'].forEach(name => {
    const el = $(`role-${name}`);
    if (el) el.classList.toggle('selected', name === role);
  });
  const next = $('role-next-btn');
  if (next) next.disabled = false;
  const hint = $('role-hint');
  if (hint) {
    hint.textContent = role === 'donor'
      ? 'You will be able to post surplus food once your organisation is verified.'
      : role === 'demand_org'
        ? 'You will be able to request matched food once your organisation is verified.'
        : 'You can search free food points near you right away.';
  }
}

function updateStep3() {
  const role = signupData.role;
  const donor = $('fields-donor');
  const ngo = $('fields-demand_org');
  const recipient = $('fields-recipient');
  if (donor) donor.hidden = role !== 'donor';
  if (ngo) ngo.hidden = role !== 'demand_org';
  if (recipient) recipient.hidden = role !== 'recipient';

  const title = $('step3-title');
  const sub = $('step3-sub');
  if (title) {
    title.textContent = role === 'donor'
      ? 'Tell us about your kitchen'
      : role === 'demand_org'
        ? 'Tell us about your organisation'
        : 'Where can we help you find food?';
  }
  if (sub) {
    sub.textContent = role === 'donor'
      ? 'This helps community partners find and collect your surplus safely.'
      : role === 'demand_org'
        ? 'We use these details to verify your organisation and match nearby food.'
        : 'We only use this to show food points near you. Your details stay private.';
  }
}

function previewDocName(input, labelId) {
  const label = $(labelId);
  if (!label) return;
  const file = input.files && input.files[0];
  label.textContent = file ? file.name : 'No file chosen';
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

async function handleRegister() {
  clearErrors();
  const signupError = $('signup-error');
  const button = $('register-btn');
  const name = ($('su-name').value || '').trim();
  const email = ($('su-email').value || '').trim();
  const password = $('su-password').value || '';
  const role = signupData.role;

  if (!role) {
    showMsg('signup-error', 'Please choose an account type.');
    goStep(2);
    return;
  }
  if (!name || !email || !password) {
    showMsg('signup-error', 'Please complete your name, email and password.');
    goStep(1);
    return;
  }

  const payload = { name, email, password, role };

  if (role === 'donor' || role === 'demand_org') {
    const prefix = role === 'donor' ? 'd' : 'n';
    const orgName = ($(`${prefix}-org-name`).value || '').trim();
    const orgType = $(`${prefix}-org-type`).value;
    const address = ($(`${prefix}-address`).value || '').trim();
    const phone = ($(`${prefix}-phone`).value || '').trim();
    const hours = ($(`${prefix}-hours`).value || '').trim();

    if (!orgName || !address) {
      showMsg('signup-error', 'Please add your organisation name and address.');
      $(`${prefix}-org-name`).focus();
      return;
    }

    payload.orgName = orgName;
    payload.orgType = orgType;
    payload.locationAddress = address;
    payload.contactPhone = phone;
    payload.operatingHours = hours;
    payload.description = role === 'donor'
      ? 'Food donor registered through the FoodBridge public site.'
      : 'Community organisation registered through the FoodBridge public site.';

    if (role === 'demand_org') {
      const capacity = ($('n-capacity').value || '').trim();
      if (capacity) payload.description += ` Daily meal capacity: ${capacity}.`;
    }

    const docInput = $(`${prefix}-doc`);
    const file = docInput && docInput.files && docInput.files[0];
    if (file) {
      if (file.size > 4 * 1024 * 1024) {
        showMsg('signup-error', 'Please choose a document smaller than 4 MB.');
        return;
      }
      try {
        payload.documentName = file.name;
        payload.documentData = await readFileAsDataURL(file);
      } catch (err) {
        showMsg('signup-error', err.message || 'Could not read the selected document.');
        return;
      }
    }
  } else {
    const city = ($('r-city').value || '').trim();
    if (!city) {
      showMsg('signup-error', 'Please add your city or area so we can show nearby food.');
      $('r-city').focus();
      return;
    }
  }

  setLoading(button, true, 'Creating account…');
  try {
    const res = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Registration failed. Please try again.');

    saveSession(data);
    updateSessionUI();

    if (role === 'recipient') {
      showMsg('signup-success', 'Account created. Taking you to the food finder…', 'success');
      setTimeout(() => { window.location.href = '/recipient/'; }, 700);
      return;
    }

    const notice = $('pending-notice');
    if (notice) {
      notice.hidden = false;
      notice.innerHTML = `Account created. <strong>${escapeHtml(payload.orgName)}</strong> is pending verification, so posting and requesting will unlock once a coordinator approves it.`;
    }
    showMsg('signup-success', 'Your account is ready. You can sign in while verification is pending.', 'success');
    setLoading(button, false, 'Create Account');
  } catch (err) {
    showMsg('signup-error', err.message || 'Unable to create your account right now.');
    setLoading(button, false, 'Create Account');
  }
}

/* Deep links from the shared public pages: /?auth=signin or /?auth=signup */
document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('auth');
  if (mode === 'signin' || mode === 'signup') {
    setTimeout(() => openAuth(mode), 80);
  }
});
