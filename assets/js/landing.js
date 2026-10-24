/* ────────────────────────────────────────────────────────────────────────
   FoodBridge — public landing page behaviour
   Auth reuses the existing /api/auth endpoints and fb_token / fb_user keys.
   ──────────────────────────────────────────────────────────────────────── */

const API = '/api';

const ROLE_ROUTES = {
  donor: '/donor/dashboard.html',
  demand_org: '/demand-org/dashboard.html',
  food_bank: '/food-bank/dashboard.html',
  biogas_operator: '/biogas/dashboard.html',
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
/*
 * New step order (role-first):
 *   Step 1 — Role picker  (all account types)
 *   Step 2 — Credentials  (name / email / password)  — org roles only
 *             Recipients skip this; pressing Continue on step 1 jumps to step 3.
 *   Step 3 — Details      (org info or city for recipient)
 *
 * The "Back" button on step 3 goes to step 2 for org roles and back to step 1
 * for recipients (since they skipped step 2).
 */
const signupData = {
  role: null,
  documentName: '',
  documentData: ''
};

function goStep(step) {
  clearErrors();
  const target = Number(step);

  // ── Validation when leaving step 1 ──────────────────────────────────────
  if (target === 2) {
    if (!signupData.role) {
      showMsg('signup-error', 'Choose how you will use FoodBridge to continue.');
      return;
    }
  }

  // ── Validation when leaving step 2 ──────────────────────────────────────
  if (target === 3) {
    // Called from step 2's Continue button — validate credentials
    if (_isOnStep(2)) {
      const name     = ($('su-name').value || '').trim();
      const email    = ($('su-email').value || '').trim();
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
    updateStep3();
  }

  _showStep(target);
}

// Back button on step 3
function backFromStep3() {
  _showStep(2);
}

function _isOnStep(n) {
  const pane = $(`step-${n}`);
  return pane && pane.classList.contains('active');
}

function _showStep(n) {
  document.querySelectorAll('#pane-signup .step-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `step-${n}`);
  });
  updateStepper(n);
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

  // Update sub-heading text
  const sub = $('signup-sub');
  if (sub) {
    sub.textContent = step === 1
      ? 'Pick your role to get started.'
      : step === 2
        ? 'Create your account credentials.'
        : 'Almost done — just a few more details.';
  }
}

function selectRole(role) {
  // Recipients don't need an account — send them straight to the food finder.
  if (role === 'recipient') {
    window.location.href = '/recipient/index.html';
    return;
  }

  signupData.role = role;
  ['donor', 'demand_org', 'food_bank', 'biogas_operator'].forEach(name => {
    const el = $(`role-${name}`);
    if (el) el.classList.toggle('selected', name === role);
  });
  const next = $('role-next-btn');
  if (next) {
    next.disabled = false;
    next.textContent = 'Continue';
  }
  const hint = $('role-hint');
  if (hint) {
    const hints = {
      donor: 'You will be able to post surplus food once your organisation is verified.',
      demand_org: 'You will be able to request matched food once your organisation is verified.',
      food_bank: 'You will manage incoming food reserves and storage once verified.',
      biogas_operator: 'You will receive waste-food routes and manage facility capacity.'
    };
    hint.textContent = hints[role] || 'Choose the option that fits you best.';
  }
}

function updateStep3() {
  const role = signupData.role;
  const allFields = ['fields-donor', 'fields-demand_org', 'fields-food_bank', 'fields-biogas_operator', 'fields-recipient'];
  allFields.forEach(id => {
    const el = $(id);
    if (el) el.hidden = true;
  });
  const target = $(`fields-${role}`);
  if (target) target.hidden = false;

  // Back button on step 3: recipients go to step 1, others go to step 2
  const backBtn = $('back-to-step2-btn');
  if (backBtn) backBtn.onclick = backFromStep3;

  const title = $('step3-title');
  const sub   = $('step3-sub');
  const titles = {
    donor:           'Tell us about your kitchen',
    demand_org:      'Tell us about your organisation',
    food_bank:       'Tell us about your food bank',
    biogas_operator: 'Tell us about your biogas facility',
    recipient:       'Where can we help you find food?'
  };
  const subs = {
    donor:           'This helps community partners find and collect your surplus safely.',
    demand_org:      'We use these details to verify your organisation and match nearby food.',
    food_bank:       'We use these details to verify your food bank and connect it to the network.',
    biogas_operator: 'We use these details to register your facility and start routing waste food to you.',
    recipient:       'We only use this to show food points near you. Your details stay private.'
  };
  if (title) title.textContent = titles[role] || 'Your details';
  if (sub)   sub.textContent   = subs[role]   || '';
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
  const button = $('register-btn');
  const role = signupData.role;

  if (!role) {
    showMsg('signup-error', 'Please choose an account type.');
    _showStep(1);
    return;
  }

  const name     = ($('su-name').value   || '').trim();
  const email    = ($('su-email').value  || '').trim();
  const password = ($('su-password').value || '');

  if (!name || !email || !password) {
    showMsg('signup-error', 'Please complete your name, email and password.');
    _showStep(2);
    return;
  }

  const payload = { name, email, password, role };

  // Helper: read pinned coordinates for a signup role prefix
  function _pinCoords(prefix) {
    const lat = parseFloat($(prefix + '-lat')?.value);
    const lng = parseFloat($(prefix + '-lng')?.value);
    return (!isNaN(lat) && !isNaN(lng) && lat !== 0) ? { lat, lng } : null;
  }

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

    const coords = _pinCoords(prefix);
    if (coords) { payload.locationLat = coords.lat; payload.locationLng = coords.lng; }

    if (role === 'demand_org') {
      const capacity = ($('n-capacity').value || '').trim();
      if (capacity) payload.description += ` Daily meal capacity: ${capacity}.`;
    }

    const docInput = $(`${prefix}-doc`);
    const file = docInput && docInput.files && docInput.files[0];
    if (role === 'donor' && !file) {
      showMsg('signup-error', 'Please upload your FSSAI licence to register as a food donor.');
      docInput?.focus();
      return;
    }
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
  } else if (role === 'food_bank') {
    const orgName = ($('fb-org-name').value || '').trim();
    const address = ($('fb-address').value || '').trim();
    if (!orgName || !address) {
      showMsg('signup-error', 'Please add your food bank name and address.');
      $('fb-org-name').focus();
      return;
    }
    const capacity = ($('fb-capacity').value || '').trim();
    payload.orgName = orgName;
    payload.orgType = 'food_bank';
    payload.locationAddress = address;
    payload.contactPhone = ($('fb-phone').value || '').trim();
    payload.operatingHours = ($('fb-hours').value || '').trim();
    payload.description = 'Food bank registered through the FoodBridge public site.' + (capacity ? ` Storage capacity: ${capacity} kg.` : '');
    const fbCoords = _pinCoords('fb');
    if (fbCoords) { payload.locationLat = fbCoords.lat; payload.locationLng = fbCoords.lng; }
    const docInput = $('fb-doc');
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
  } else if (role === 'biogas_operator') {
    const orgName = ($('bg-org-name').value || '').trim();
    const address = ($('bg-address').value || '').trim();
    if (!orgName || !address) {
      showMsg('signup-error', 'Please add your facility name and address.');
      $('bg-org-name').focus();
      return;
    }
    const checkedTypes = Array.from(
      document.querySelectorAll('#bg-waste-types input[type="checkbox"]:checked')
    ).map(cb => cb.value);
    payload.orgName = orgName;
    payload.locationAddress = address;
    payload.contactPhone = ($('bg-phone').value || '').trim();
    payload.operatingHours = ($('bg-hours').value || '').trim();
    payload.maxDailyIntakeKg = Number($('bg-capacity').value || 0);
    payload.acceptedWasteTypes = checkedTypes.length ? checkedTypes : ['all_food_waste'];
    payload.description = 'Biogas facility registered through the FoodBridge public site.';
    const bgCoords = _pinCoords('bg');
    if (bgCoords) { payload.locationLat = bgCoords.lat; payload.locationLng = bgCoords.lng; }
  } else {
    // recipient
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
    if (notice && !data.autoApproved) {
      notice.hidden = false;
      const orgLabel = {
        food_bank: 'Food bank',
        biogas_operator: 'Biogas facility',
        donor: 'Organisation',
        demand_org: 'Organisation'
      }[role] || 'Organisation';
      notice.innerHTML = `Account created. <strong>${escapeHtml(payload.orgName)}</strong> is pending verification. ${orgLabel} features will unlock once a coordinator approves it. You can sign in and explore your dashboard in the meantime.`;
    }
    showMsg('signup-success', data.autoApproved
      ? 'Your account is ready and your organisation has been automatically approved.'
      : 'Your account is ready. You can sign in while verification is pending.', 'success');
    // Show sign-in button for orgs that need admin approval
    const signinNotice = $('pending-notice-signin');
    if (signinNotice) signinNotice.hidden = !!data.autoApproved;
    setLoading(button, false, 'Create Account');
  } catch (err) {
    showMsg('signup-error', err.message || 'Unable to create your account right now.');
    setLoading(button, false, 'Create Account');
  }
}

/* Deep links from public partner cards can preselect a signup role. */
document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('auth');
  const role = params.get('role');
  if (mode === 'signin' || mode === 'signup') {
    setTimeout(() => {
      openAuth(mode);
      if (mode === 'signup' && ['donor', 'demand_org', 'food_bank', 'biogas_operator'].includes(role)) {
        setTimeout(() => selectRole(role), 80);
      }
    }, 80);
  }
});

/* ── Signup map picker ─────────────────────────────────────────────────── */
/*
 * One shared Leaflet map instance, shown in a full-screen modal overlay that
 * sits above the auth dialog. Each role form has its own hidden lat/lng inputs
 * (d-lat/d-lng, n-lat/n-lng, fb-lat/fb-lng, bg-lat/bg-lng).
 *
 * Flow:
 *   openSignupMap(rolePrefix) → shows modal, inits Leaflet (once), pans to
 *     any existing pin or Bengaluru default.
 *   User clicks / drags marker → Nominatim reverse-geocode → shows address.
 *   confirmSignupPin() → writes lat/lng to hidden inputs, closes modal, shows
 *     "pinned" chip next to the address field.
 */
const _smap = {
  map: null,
  marker: null,
  lat: null,
  lng: null,
  addrText: null,
  activePrefix: null,
  geocodeTimer: null
};

// Called when the user types in an address field — clears any existing pin
// (coordinates might no longer match the typed address).
window.onAddressInput = function (prefix) {
  // Only clear if user is actually changing the address after pinning
  const latEl = $(prefix === 'donor' ? 'd-lat' : prefix === 'ngo' ? 'n-lat' : prefix + '-lat');
  if (latEl && latEl.value) {
    latEl.value = '';
    const lngId = prefix === 'donor' ? 'd-lng' : prefix === 'ngo' ? 'n-lng' : prefix + '-lng';
    const lngEl = $(lngId); if (lngEl) lngEl.value = '';
    const sel = $(`map-pin-selected-${prefix}`); if (sel) sel.hidden = true;
    const tog = $(`map-pin-${prefix}`)?.querySelector('.map-pin-toggle');
    if (tog) tog.hidden = false;
  }
};

window.openSignupMap = function (prefix) {
  _smap.activePrefix = prefix;
  const modal = $('signup-map-modal');
  if (!modal) return;
  modal.removeAttribute('aria-hidden');
  modal.classList.add('open');
  document.body.classList.add('modal-open');

  // Determine initial coordinates: existing pin > Bengaluru default
  const latId = prefix === 'donor' ? 'd-lat' : prefix === 'ngo' ? 'n-lat' : prefix + '-lat';
  const lngId = prefix === 'donor' ? 'd-lng' : prefix === 'ngo' ? 'n-lng' : prefix + '-lng';
  const existLat = parseFloat($(latId)?.value);
  const existLng = parseFloat($(lngId)?.value);
  const startLat = (!isNaN(existLat) && existLat !== 0) ? existLat : 12.9716;
  const startLng = (!isNaN(existLng) && existLng !== 0) ? existLng : 77.5946;

  _smap.lat = null; _smap.lng = null; _smap.addrText = null;

  // Disable confirm until pin placed
  const confirmBtn = $('signup-map-confirm');
  if (confirmBtn) confirmBtn.disabled = true;
  const addrSpan = $('signup-map-addr-text');
  if (addrSpan) addrSpan.textContent = 'Click the map to place a pin';

  if (!_smap.map) {
    // First open — initialise Leaflet
    _smap.map = L.map('signup-map-leaflet').setView([startLat, startLng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(_smap.map);

    _smap.map.on('click', e => _placeSignupPin(e.latlng.lat, e.latlng.lng));
  } else {
    _smap.map.setView([startLat, startLng], 14);
    // Invalidate size in case the container was hidden on first render
    setTimeout(() => _smap.map.invalidateSize(), 60);
  }

  // If there is already a saved pin, show it
  if (!isNaN(existLat) && existLat !== 0) {
    _placeSignupPin(existLat, existLng, /*skipGeocode=*/true);
  } else {
    setTimeout(() => _smap.map.invalidateSize(), 60);
  }
};

function _placeSignupPin(lat, lng, skipGeocode) {
  _smap.lat = lat; _smap.lng = lng;
  if (_smap.marker) {
    _smap.marker.setLatLng([lat, lng]);
  } else {
    _smap.marker = L.marker([lat, lng], { draggable: true }).addTo(_smap.map);
    _smap.marker.on('dragend', e => {
      const ll = e.target.getLatLng();
      _placeSignupPin(ll.lat, ll.lng);
    });
  }
  _smap.map.panTo([lat, lng]);

  const confirmBtn = $('signup-map-confirm');
  if (confirmBtn) confirmBtn.disabled = false;

  const addrSpan = $('signup-map-addr-text');
  if (addrSpan) addrSpan.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)} — fetching address…`;

  if (skipGeocode) {
    if (addrSpan) addrSpan.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    return;
  }
  // Nominatim reverse-geocode (rate-limited with 800 ms debounce)
  clearTimeout(_smap.geocodeTimer);
  _smap.geocodeTimer = setTimeout(async () => {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const data = await res.json();
      const display = data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      _smap.addrText = display;
      if (addrSpan) addrSpan.textContent = display;
    } catch (_) {
      if (addrSpan) addrSpan.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }
  }, 800);
}

window.confirmSignupPin = function () {
  if (_smap.lat == null) return;
  const prefix = _smap.activePrefix;
  const latId = prefix === 'donor' ? 'd-lat' : prefix === 'ngo' ? 'n-lat' : prefix + '-lat';
  const lngId = prefix === 'donor' ? 'd-lng' : prefix === 'ngo' ? 'n-lng' : prefix + '-lng';
  const latEl = $(latId); const lngEl = $(lngId);
  if (latEl) latEl.value = _smap.lat.toFixed(6);
  if (lngEl) lngEl.value = _smap.lng.toFixed(6);

  // Show the "pinned" chip
  const addrLabel = $(`map-pin-addr-${prefix}`);
  if (addrLabel) addrLabel.textContent = _smap.addrText || `${_smap.lat.toFixed(5)}, ${_smap.lng.toFixed(5)}`;
  const sel = $(`map-pin-selected-${prefix}`); if (sel) sel.hidden = false;
  const tog = $(`map-pin-${prefix}`)?.querySelector('.map-pin-toggle');
  if (tog) tog.style.display = 'none';

  closeSignupMap();
};

window.clearSignupPin = function (prefix) {
  const latId = prefix === 'donor' ? 'd-lat' : prefix === 'ngo' ? 'n-lat' : prefix + '-lat';
  const lngId = prefix === 'donor' ? 'd-lng' : prefix === 'ngo' ? 'n-lng' : prefix + '-lng';
  const latEl = $(latId); if (latEl) latEl.value = '';
  const lngEl = $(lngId); if (lngEl) lngEl.value = '';
  const sel = $(`map-pin-selected-${prefix}`); if (sel) sel.hidden = true;
  const tog = $(`map-pin-${prefix}`)?.querySelector('.map-pin-toggle');
  if (tog) tog.style.display = '';
};

window.closeSignupMap = function () {
  const modal = $('signup-map-modal');
  if (!modal) return;
  modal.setAttribute('aria-hidden', 'true');
  modal.classList.remove('open');
  document.body.classList.remove('modal-open');
};
