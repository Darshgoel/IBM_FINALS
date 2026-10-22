/**
 * FoodBridge — Demand-Org Dashboard JS
 * Sections: Overview, Register Demand, My Demands, Matches, Capacity, Insights, Alerts, Profile
 */

import api from './api.js';

// ── Auth guard ───────────────────────────────────────────────
const token = localStorage.getItem('fb_token');
const user = JSON.parse(localStorage.getItem('fb_user') || 'null');

if (!token || !user || user.role !== 'demand_org') {
  window.location.href = '/demand-org/index.html';
}

// ── State ────────────────────────────────────────────────────
let allDemands = [];
let demandFilter = 'all';
let selectedUrgency = 'regular';
let profile = {};

// ── Page Router ──────────────────────────────────────────────
const pageMap = {
  'overview': 'page-overview',
  'register-demand': 'page-register-demand',
  'my-demands': 'page-my-demands',
  'matches': 'page-matches',
  'capacity': 'page-capacity',
  'insights': 'page-insights',
  'alerts': 'page-alerts',
  'profile': 'page-profile',
};

const pageTitles = {
  'overview': ['Overview', 'Your organization activity at a glance'],
  'register-demand': ['Register Demand', 'Post a new food requirement'],
  'my-demands': ['My Demands', 'Manage all your registered needs'],
  'matches': ['Matched Supply', 'Supply matched automatically by the network'],
  'capacity': ['Capacity', 'Update what you can receive today'],
  'insights': ['Insights', 'Demand trends and fulfillment analysis'],
  'alerts': ['Alerts', 'Network notifications for your organization'],
  'profile': ['Organization Profile', 'Manage your org info and requirements'],
};

window.showPage = function (page) {
  // Hide all pages
  Object.values(pageMap).forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  // Show target
  document.getElementById(pageMap[page])?.classList.add('active');
  // Update nav active state
  Object.keys(pageMap).forEach(k => {
    document.getElementById(`nav-${k}`)?.classList.remove('active');
  });
  document.getElementById(`nav-${page}`)?.classList.add('active');
  // Update topbar
  const [title, sub] = pageTitles[page] || [page, ''];
  document.getElementById('topbar-title').textContent = title;
  document.getElementById('topbar-sub').textContent = sub;
  // Load data for page
  loadPageData(page);
};

async function loadPageData(page) {
  try {
    switch (page) {
      case 'overview': await loadOverview(); break;
      case 'my-demands': await loadDemands(); break;
      case 'matches': await loadMatches(); break;
      case 'capacity': await loadCapacity(); break;
      case 'insights': await loadInsights(); break;
      case 'alerts': await loadAlerts(); break;
      case 'profile': await loadProfile(); break;
    }
  } catch (err) {
    console.error('loadPageData error:', err);
  }
}

// ── Init ─────────────────────────────────────────────────────
async function init() {
  try {
    const meData = await api.auth.me(token);
    profile = meData.user || meData;

    const orgName = profile.orgName || profile.name || 'Organization';
    const initials = orgName.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();

    document.getElementById('sidebar-avatar').textContent = initials;
    document.getElementById('sidebar-org-name').textContent = orgName;
    document.getElementById('sidebar-org-type').textContent = formatOrgType(profile.orgType || profile.role);
    document.getElementById('topbar-sub').textContent = `Welcome back, ${orgName}`;

    await loadOverview();
    await checkUnreadBadges();
    initLiveNotifications();
  } catch (err) {
    console.error('Init error:', err);
    // Use local data if backend unavailable
    loadDemoData();
  }
}

function initLiveNotifications() {
  if (!token) return;
  if ('Notification' in window && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (e) { }
  }
  try {
    const evtSource = new EventSource(`http://localhost:3000/api/notifications/stream?token=${token}`);
    evtSource.addEventListener('notification', (e) => {
      try {
        const notif = JSON.parse(e.data);
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(notif.title, { body: notif.message });
        }
        toast(`🔔 ${notif.title}: ${notif.message}`, 'info');
        checkUnreadBadges();
        loadOverview();
      } catch (err) { }
    });
  } catch (e) { }
}

function formatOrgType(type) {
  const map = {
    ngo: 'NGO / Charity', food_bank: 'Food Bank',
    community_kitchen: 'Community Kitchen', shelter: 'Shelter',
    demand_org: 'Demand Organization', other_demand: 'Other',
  };
  return map[type] || type || 'Demand Org';
}

// ── OVERVIEW ─────────────────────────────────────────────────
async function loadOverview() {
  try {
    const [demandsData, matchesData, insightsData, alertsData] = await Promise.allSettled([
      api.demandOrg.getDemands(token),
      api.demandOrg.getMatches(token),
      api.demandOrg.getInsights(token),
      api.demandOrg.getAlerts(token),
    ]);

    const demands = demandsData.status === 'fulfilled' ? (demandsData.value.demands || []) : demoDemandsData();
    const matches = matchesData.status === 'fulfilled' ? (matchesData.value.matches || []) : demoMatchesData();
    const insights = insightsData.status === 'fulfilled' ? (insightsData.value || {}) : demoInsightsData();
    const alerts = alertsData.status === 'fulfilled' ? (alertsData.value.alerts || []) : demoAlertsData();

    // Stats
    const active = demands.filter(d => ['active', 'searching'].includes(d.status)).length;
    const fulfilled = demands.filter(d => d.status === 'fulfilled').length;
    const pending = matches.filter(m => m.status === 'pending').length;

    setText('stat-active', active);
    setText('stat-fulfilled', fulfilled);
    setText('stat-pending', pending);
    setText('stat-people', insights.peopleServedMonth ?? '—');

    // Recent demands (last 3)
    allDemands = demands;
    renderDemandList('overview-demands', demands.slice(0, 3));

    // Recent matches (last 3)
    renderMatchList('overview-matches', matches.slice(0, 3));

    // Alerts
    renderAlertList('overview-alerts', alerts.slice(0, 3));

  } catch (err) {
    console.error('loadOverview', err);
    loadDemoOverview();
  }
}

function loadDemoOverview() {
  setText('stat-active', 3);
  setText('stat-fulfilled', 18);
  setText('stat-pending', 2);
  setText('stat-people', '1,240');
  renderDemandList('overview-demands', demoDemandsData().slice(0, 3));
  renderMatchList('overview-matches', demoMatchesData().slice(0, 2));
  renderAlertList('overview-alerts', demoAlertsData().slice(0, 3));
}

// ── DEMANDS ──────────────────────────────────────────────────
async function loadDemands() {
  try {
    const data = await api.demandOrg.getDemands(token);
    allDemands = data.demands || [];
  } catch {
    allDemands = demoDemandsData();
  }
  renderDemandList('demands-list', filterDemandsArr(allDemands, demandFilter));
}

window.filterDemands = function (status) {
  demandFilter = status;
  document.querySelectorAll('[id^="filter-"]').forEach(b => b.style.color = '');
  document.getElementById(`filter-${status}`).style.color = 'var(--primary)';
  renderDemandList('demands-list', filterDemandsArr(allDemands, status));
};

function filterDemandsArr(arr, status) {
  if (status === 'all') return arr;
  return arr.filter(d => d.status === status);
}

function renderDemandList(containerId, demands) {
  const el = document.getElementById(containerId);
  if (!demands || demands.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📋</div>
      <p>No demands found.</p>
      <button class="cta" onclick="showPage('register-demand')">Register a demand</button>
    </div>`;
    return;
  }
  el.innerHTML = demands.map(d => `
    <div class="demand-item">
      <div class="demand-urgency urgency-${d.urgency || 'regular'}"></div>
      <div class="demand-info">
        <div class="demand-food">${d.foodType || d.food_type || 'Food'}</div>
        <div class="demand-meta">
          <span>📅 ${d.neededBy ? new Date(d.neededBy).toLocaleString() : 'ASAP'}</span>
          <span>⚡ ${d.urgency || 'regular'}</span>
          ${d.dietary ? `<span>🥗 ${d.dietary}</span>` : ''}
          ${d.recurring ? '<span>🔄 Recurring</span>' : ''}
        </div>
      </div>
      <div class="demand-right">
        <div class="demand-qty">${d.quantity || '—'}</div>
        <div class="demand-qty-label">${d.unit || 'servings'}</div>
        <div class="demand-status-badge status-${d.status || 'active'}">${d.status || 'active'}</div>
        ${d.status === 'active' || d.status === 'searching' ? `<br><button style="margin-top:6px; font-size:0.72rem; padding:4px 10px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); color:var(--red); border-radius:6px; cursor:pointer;" onclick="cancelDemand('${d.id}')">Cancel</button>` : ''}
      </div>
    </div>
  `).join('');
}

window.cancelDemand = async function (id) {
  if (!confirm('Cancel this demand?')) return;
  try {
    await api.demandOrg.cancelDemand(token, id);
    toast('Demand cancelled.', 'info');
    await loadDemands();
  } catch (err) {
    toast(err.message, 'error');
  }
};

// ── SUBMIT DEMAND ────────────────────────────────────────────
window.selectUrgency = function (urgency) {
  selectedUrgency = urgency;
  document.querySelectorAll('.urgency-btn').forEach(b => b.classList.remove('selected'));
  document.querySelector(`[data-urgency="${urgency}"]`).classList.add('selected');
};

window.submitDemand = async function () {
  const foodType = document.getElementById('d-food-type').value;
  const quantity = parseInt(document.getElementById('d-quantity').value);
  const unit = document.getElementById('d-unit').value;
  const neededBy = document.getElementById('d-needed-by').value;
  const dietary = document.getElementById('d-dietary').value.trim();
  const notes = document.getElementById('d-notes').value.trim();
  const recurring = document.getElementById('d-recurring').checked;
  const recurrFreq = document.getElementById('d-recur-freq')?.value;
  const recurrTime = document.getElementById('d-recur-time')?.value;

  const errEl = document.getElementById('demand-error');

  if (!quantity || quantity < 1) {
    errEl.textContent = 'Please enter a valid quantity.';
    errEl.style.display = 'block';
    return;
  }

  errEl.style.display = 'none';
  const btn = document.getElementById('demand-submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Registering…';

  const body = { foodType, quantity, unit, neededBy, dietary, notes, urgency: selectedUrgency, recurring };
  if (recurring) { body.recurrFreq = recurrFreq; body.recurrTime = recurrTime; }

  try {
    await api.demandOrg.postDemand(token, body);
    toast('✅ Demand registered! The network is searching for matching supply.', 'success');
    clearDemandForm();
    showPage('my-demands');
  } catch (err) {
    // Demo mode — show success anyway
    toast('✅ Demand registered (demo mode)!', 'success');
    clearDemandForm();
    showPage('my-demands');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📋 Register Demand';
  }
};

window.clearDemandForm = function () {
  ['d-food-type', 'd-quantity', 'd-unit', 'd-needed-by', 'd-dietary', 'd-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el.tagName === 'SELECT') el.selectedIndex = 0;
    else el.value = '';
  });
  document.getElementById('d-recurring').checked = false;
  document.getElementById('recurring-fields').style.display = 'none';
  selectedUrgency = 'regular';
  selectUrgency('regular');
  document.getElementById('demand-error').style.display = 'none';
};

document.getElementById('d-recurring').addEventListener('change', e => {
  document.getElementById('recurring-fields').style.display = e.target.checked ? 'block' : 'none';
});

// ── MATCHES ──────────────────────────────────────────────────
async function loadMatches() {
  let matches;
  try {
    const data = await api.demandOrg.getMatches(token);
    matches = data.matches || [];
  } catch {
    matches = demoMatchesData();
  }
  renderMatchList('matches-list', matches);
}

function renderMatchList(containerId, matches) {
  const el = document.getElementById(containerId);
  if (!matches || matches.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🎯</div>
      <p>No matches yet. The network will surface supply automatically.</p>
    </div>`;
    return;
  }
  el.innerHTML = matches.map(m => `
    <div class="match-card" id="match-card-${m.id}">
      <div class="match-header">
        <div>
          <div class="match-donor">🍽️ ${m.donorName || 'Anonymous Donor'}</div>
          <div style="font-size:0.78rem; color:var(--muted); margin-top:3px;">${m.foodType || 'Mixed food'}</div>
        </div>
        <div class="match-score">⚡ ${m.matchScore || 92}% match</div>
      </div>
      <div class="match-details">
        <span>📦 ${m.quantity || '—'} ${m.unit || 'servings'}</span>
        <span>📍 ${m.distance || '~2km away'}</span>
        <span>⏱️ Available: ${m.availableUntil ? new Date(m.availableUntil).toLocaleTimeString() : 'Now'}</span>
        <span>🚨 Your need: ${m.demandUrgency || 'regular'}</span>
      </div>
      ${m.status === 'pending' ? `
      <div class="match-actions">
        <button class="match-btn accept"  onclick="acceptMatch('${m.id}')">✅ Accept</button>
        <button class="match-btn decline" onclick="declineMatch('${m.id}')">✗ Decline</button>
      </div>` : `<span class="demand-status-badge status-${m.status}">${m.status}</span>`}
    </div>
  `).join('');
}

window.acceptMatch = async function (id) {
  try {
    await api.demandOrg.acceptMatch(token, id);
    toast('Match accepted! Supply is on its way.', 'success');
    const card = document.getElementById(`match-card-${id}`);
    if (card) card.querySelector('.match-actions').innerHTML = '<span class="demand-status-badge status-matched">Accepted</span>';
  } catch {
    toast('Match accepted (demo)!', 'success');
  }
};

window.declineMatch = async function (id) {
  try {
    await api.demandOrg.declineMatch(token, id);
    document.getElementById(`match-card-${id}`)?.remove();
    toast('Match declined.', 'info');
  } catch {
    document.getElementById(`match-card-${id}`)?.remove();
    toast('Match declined (demo).', 'info');
  }
};

// ── CAPACITY ─────────────────────────────────────────────────
async function loadCapacity() {
  try {
    const data = await api.demandOrg.getProfile(token);
    const cap = data.capacity || {};
    setValue('cap-receive', cap.receiveCapacity || '');
    setValue('cap-serve', cap.serveCapacity || '');
    setValue('cap-storage', cap.storageCapacity || '');
    setValue('cap-avail-until', cap.availUntil || '');
    setValue('cap-notes', cap.notes || '');
    updateCapacityBars(cap);
  } catch { /* demo */ }
}

function updateCapacityBars(cap) {
  const maxReceive = cap.receiveCapacity || 200;
  const maxServe = cap.serveCapacity || 300;
  const maxStorage = cap.storageCapacity || 500;
  const usedReceive = cap.committedReceive || 0;
  const usedServe = cap.committedServe || 0;
  const usedStorage = cap.committedStorage || 0;

  setBarWidth('bar-receive', Math.round((usedReceive / maxReceive) * 100));
  setBarWidth('bar-serve', Math.round((usedServe / maxServe) * 100));
  setBarWidth('bar-storage', Math.round((usedStorage / maxStorage) * 100));

  setText('val-receive', `${usedReceive}/${maxReceive}`);
  setText('val-serve', `${usedServe}/${maxServe}`);
  setText('val-storage', `${usedStorage}/${maxStorage}kg`);
}

function setBarWidth(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = Math.min(pct, 100) + '%';
  el.classList.remove('amber', 'red');
  if (pct > 85) el.classList.add('red');
  else if (pct > 65) el.classList.add('amber');
}

window.updateCapacity = async function () {
  const body = {
    receiveCapacity: parseInt(getValue('cap-receive')) || 0,
    serveCapacity: parseInt(getValue('cap-serve')) || 0,
    storageCapacity: parseInt(getValue('cap-storage')) || 0,
    availUntil: getValue('cap-avail-until'),
    notes: getValue('cap-notes'),
  };
  try {
    await api.demandOrg.updateCapacity(token, body);
    toast('✅ Capacity updated!', 'success');
  } catch {
    toast('✅ Capacity updated (demo)!', 'success');
  }
};

// ── INSIGHTS ─────────────────────────────────────────────────
async function loadInsights() {
  let ins;
  try {
    const data = await api.demandOrg.getInsights(token);
    ins = data || demoInsightsData();
  } catch {
    ins = demoInsightsData();
  }

  setText('ins-fulfillment-rate', (ins.fulfillmentRate || 78) + '%');
  setText('ins-total-demands', ins.totalDemands || 42);
  setText('ins-unmet', ins.unmetDemands || 9);
  setText('ins-people-total', ins.peopleTotalServed || '8,400');

  renderDemandChart(ins.weeklyData || demoDailyData());
  renderFoodBreakdown(ins.foodBreakdown || demoFoodBreakdown());
}

function renderDemandChart(data) {
  const wrap = document.getElementById('demand-chart');
  if (!wrap) return;
  const max = Math.max(...data.map(d => d.demand || 0), 1);
  wrap.innerHTML = `
    <div style="display:flex; gap:8px; align-items:flex-end; width:100%; height:100%;">
      ${data.map(d => `
        <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:3px; height:100%; justify-content:flex-end;">
          <div style="width:100%; display:flex; align-items:flex-end; gap:2px; height:${Math.round((d.demand / max) * 100)}%;">
            <div class="chart-bar fulfilled" style="height:${Math.round((d.fulfilled / d.demand) * 100 || 0)}%;">
              <div class="chart-bar-tooltip">${d.fulfilled} fulfilled</div>
            </div>
            <div class="chart-bar unfilled" style="height:${Math.round(((d.demand - d.fulfilled) / d.demand) * 100 || 0)}%;">
              <div class="chart-bar-tooltip">${d.demand - d.fulfilled} unmet</div>
            </div>
          </div>
          <div class="chart-x-label" style="position:static;">${d.day}</div>
        </div>
      `).join('')}
    </div>`;
}

function renderFoodBreakdown(breakdown) {
  const el = document.getElementById('food-breakdown');
  if (!el || !breakdown.length) return;
  el.innerHTML = breakdown.map(b =>
    `<span class="tag">${b.icon || '🍱'} ${b.type}: <strong>${b.count}</strong></span>`
  ).join('');
}

// ── ALERTS ───────────────────────────────────────────────────
async function loadAlerts() {
  let alerts;
  try {
    const data = await api.demandOrg.getAlerts(token);
    alerts = data.alerts || [];
  } catch {
    alerts = demoAlertsData();
  }
  renderAlertList('alerts-full-list', alerts);
}

function renderAlertList(containerId, alerts) {
  const el = document.getElementById(containerId);
  if (!alerts || alerts.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🔕</div><p>No alerts right now.</p></div>`;
    return;
  }
  el.innerHTML = alerts.map(a => `
    <div class="alert-item ${a.read ? '' : 'unread'}" id="alert-${a.id}" onclick="markAlertRead('${a.id}')">
      <div class="alert-icon ${alertColor(a.type)}">${alertIcon(a.type)}</div>
      <div class="alert-body">
        <div class="alert-title">${a.message || a.title || 'Alert'}</div>
        <div class="alert-time">${a.createdAt ? timeAgo(a.createdAt) : 'just now'}</div>
      </div>
      ${!a.read ? '<div class="alert-unread-dot"></div>' : ''}
    </div>
  `).join('');
}

function alertColor(type) {
  const map = { supply: 'green', warning: 'amber', error: 'red', info: 'blue', match: 'green', fulfilled: 'green' };
  return map[type] || 'blue';
}
function alertIcon(type) {
  const map = { supply: '🍽️', warning: '⚠️', error: '🚨', info: 'ℹ️', match: '🎯', fulfilled: '✅' };
  return map[type] || '🔔';
}

window.markAlertRead = async function (id) {
  try { await api.demandOrg.markAlertRead(token, id); } catch { /* demo */ }
  const el = document.getElementById(`alert-${id}`);
  if (el) { el.classList.remove('unread'); el.querySelector('.alert-unread-dot')?.remove(); }
};

window.markAllAlertsRead = async function () {
  try { await api.demandOrg.markAllRead(token); } catch { /* demo */ }
  document.querySelectorAll('.alert-item').forEach(el => {
    el.classList.remove('unread');
    el.querySelector('.alert-unread-dot')?.remove();
  });
  toast('All alerts marked as read.', 'info');
  updateBadge('alert-badge', 0);
  document.getElementById('topbar-alert-dot').style.display = 'none';
};

// ── PROFILE ──────────────────────────────────────────────────
async function loadProfile() {
  try {
    const data = await api.demandOrg.getProfile(token);
    const p = data.profile || data;
    setValue('p-org-name', p.orgName || p.name || '');
    setValue('p-org-type', p.orgType || '');
    setValue('p-address', p.locationAddress || p.address || '');
    setValue('p-phone', p.contactPhone || p.phone || '');
    setValue('p-hours', p.operatingHours || p.hours || '');
    setValue('p-serve-cap', p.servingCapacity || '');
    setValue('p-population', p.populationServed || '');
    setValue('p-food-req', p.foodRequirements || '');
  } catch { /* demo data already in placeholders */ }
}

window.saveProfile = async function () {
  const body = {
    orgName: getValue('p-org-name'),
    orgType: getValue('p-org-type'),
    locationAddress: getValue('p-address'),
    contactPhone: getValue('p-phone'),
    operatingHours: getValue('p-hours'),
    servingCapacity: parseInt(getValue('p-serve-cap')) || 0,
    populationServed: getValue('p-population'),
    foodRequirements: getValue('p-food-req'),
  };
  try {
    await api.demandOrg.updateProfile(token, body);
    showMsg('profile-success', '✅ Profile saved!');
    hideMsg('profile-error');
    // Update sidebar
    document.getElementById('sidebar-org-name').textContent = body.orgName;
  } catch {
    showMsg('profile-success', '✅ Profile saved (demo mode)!');
  }
};

// ── BADGES ───────────────────────────────────────────────────
async function checkUnreadBadges() {
  try {
    const [alertData, matchData] = await Promise.allSettled([
      api.demandOrg.getAlerts(token),
      api.demandOrg.getMatches(token),
    ]);
    const unreadAlerts = alertData.status === 'fulfilled'
      ? (alertData.value.alerts || []).filter(a => !a.read).length : 3;
    const pendingMatches = matchData.status === 'fulfilled'
      ? (matchData.value.matches || []).filter(m => m.status === 'pending').length : 2;

    updateBadge('alert-badge', unreadAlerts);
    updateBadge('match-badge', pendingMatches);
    if (unreadAlerts > 0) document.getElementById('topbar-alert-dot').style.display = 'block';
  } catch {
    updateBadge('alert-badge', 3);
    updateBadge('match-badge', 2);
    document.getElementById('topbar-alert-dot').style.display = 'block';
  }
}

function updateBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) { el.textContent = count; el.style.display = 'inline'; }
  else { el.style.display = 'none'; }
}

// ── DEMO DATA ─────────────────────────────────────────────────
function demoDemandsData() {
  return [
    { id: '1', foodType: 'Cooked Meals', quantity: 200, unit: 'servings', urgency: 'regular', status: 'searching', neededBy: new Date(Date.now() + 3600000).toISOString(), recurring: true },
    { id: '2', foodType: 'Raw Ingredients', quantity: 50, unit: 'kg', urgency: 'immediate', status: 'matched', neededBy: new Date(Date.now() + 7200000).toISOString() },
    { id: '3', foodType: 'Bread / Bakery', quantity: 100, unit: 'packets', urgency: 'planned', status: 'fulfilled', neededBy: new Date(Date.now() - 86400000).toISOString() },
    { id: '4', foodType: 'Cooked Meals', quantity: 150, unit: 'servings', urgency: 'emergency', status: 'active', neededBy: new Date(Date.now() + 1800000).toISOString() },
  ];
}

function demoMatchesData() {
  return [
    { id: 'm1', donorName: 'The Spice Garden Restaurant', foodType: 'Cooked Meals', quantity: 180, unit: 'servings', distance: '1.2km', matchScore: 96, demandUrgency: 'regular', status: 'pending', availableUntil: new Date(Date.now() + 5400000).toISOString() },
    { id: 'm2', donorName: 'Grand Hyatt Hotel', foodType: 'Cooked Meals', quantity: 60, unit: 'servings', distance: '3.8km', matchScore: 88, demandUrgency: 'immediate', status: 'accepted', availableUntil: new Date(Date.now() + 3600000).toISOString() },
  ];
}

function demoInsightsData() {
  return {
    fulfillmentRate: 82, totalDemands: 47, unmetDemands: 8,
    peopleTotalServed: '9,200', peopleServedMonth: 1240,
    weeklyData: demoDailyData(),
    foodBreakdown: demoFoodBreakdown(),
  };
}

function demoDailyData() {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return days.map(day => ({
    day,
    demand: Math.floor(Math.random() * 100) + 150,
    fulfilled: Math.floor(Math.random() * 80) + 120,
  }));
}

function demoFoodBreakdown() {
  return [
    { icon: '🍱', type: 'Cooked Meals', count: 28 },
    { icon: '🥦', type: 'Raw Ingredients', count: 9 },
    { icon: '🍞', type: 'Bread', count: 6 },
    { icon: '📦', type: 'Packaged', count: 4 },
  ];
}

function demoAlertsData() {
  return [
    { id: 'a1', type: 'match', read: false, message: '🎯 New match found: 180 meals from The Spice Garden — 1.2km away.', createdAt: new Date(Date.now() - 900000).toISOString() },
    { id: 'a2', type: 'supply', read: false, message: '🍽️ Surplus food available nearby matching your regular demand profile.', createdAt: new Date(Date.now() - 3600000).toISOString() },
    { id: 'a3', type: 'warning', read: true, message: '⚠️ Your daily demand for tomorrow is predicted to exceed your current profile.', createdAt: new Date(Date.now() - 86400000).toISOString() },
    { id: 'a4', type: 'fulfilled', read: true, message: '✅ Demand #D-2024-003 has been fulfilled. 100 meals received.', createdAt: new Date(Date.now() - 172800000).toISOString() },
  ];
}

function loadDemoData() {
  document.getElementById('sidebar-org-name').textContent = 'Helping Hands NGO';
  document.getElementById('sidebar-org-type').textContent = 'NGO / Charity';
  document.getElementById('sidebar-avatar').textContent = 'HH';
  loadDemoOverview();
}

// ── UTILITIES ────────────────────────────────────────────────
window.logout = function () {
  localStorage.removeItem('fb_token');
  localStorage.removeItem('fb_user');
  window.location.href = '/demand-org/index.html';
};

function toast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function getValue(id) { return document.getElementById(id)?.value || ''; }
function setValue(id, v) { const el = document.getElementById(id); if (el) el.value = v; }

function showMsg(id, msg) { const el = document.getElementById(id); if (el) { el.textContent = msg; el.style.display = 'block'; setTimeout(() => { el.style.display = 'none'; }, 4000); } }
function hideMsg(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

// ── Start ────────────────────────────────────────────────────
init();
