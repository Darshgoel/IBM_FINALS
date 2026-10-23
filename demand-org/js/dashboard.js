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

    const demands = demandsData.status === 'fulfilled' ? (demandsData.value.demands || []) : [];
    const matches = matchesData.status === 'fulfilled' ? (matchesData.value.matches || []) : [];
    const insights = insightsData.status === 'fulfilled' ? (insightsData.value || {}) : {};
    const alerts = alertsData.status === 'fulfilled' ? (alertsData.value.alerts || []) : [];

    // Stats based on real database records
    const active = demands.filter(d => ['open', 'active', 'searching', 'partially_fulfilled'].includes(d.status)).length;
    const fulfilled = demands.filter(d => d.status === 'fulfilled').length;
    const pending = matches.filter(m => m.status === 'pending').length;

    setText('stat-active', active);
    setText('stat-fulfilled', fulfilled);
    setText('stat-pending', pending);
    setText('stat-people', insights.peopleServedMonth ?? '0');

    // Recent demands (last 3)
    allDemands = demands;
    renderDemandList('overview-demands', demands.slice(0, 3));

    // Recent matches (last 3)
    renderMatchList('overview-matches', matches.slice(0, 3));

    // Alerts
    renderAlertList('overview-alerts', alerts.slice(0, 3));

  } catch (err) {
    console.error('loadOverview', err);
    setText('stat-active', 0);
    setText('stat-fulfilled', 0);
    setText('stat-pending', 0);
    setText('stat-people', '0');
  }
}

function loadDemoOverview() {
  setText('stat-active', 0);
  setText('stat-fulfilled', 0);
  setText('stat-pending', 0);
  setText('stat-people', '0');
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
  if (status === 'active') {
    return arr.filter(d => ['active', 'open', 'searching', 'pending'].includes(d.status));
  }
  if (status === 'searching') {
    return arr.filter(d => ['searching', 'open', 'pending'].includes(d.status));
  }
  if (status === 'matched') {
    return arr.filter(d => ['matched', 'partially_fulfilled'].includes(d.status));
  }
  if (status === 'fulfilled') {
    return arr.filter(d => ['fulfilled', 'completed'].includes(d.status));
  }
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
  el.innerHTML = demands.map(d => {
    const foodName = d.food_requirement || d.foodRequirement || d.foodType || d.food_type || 'Food Request';
    const qty = d.quantity_needed != null ? d.quantity_needed : (d.quantity != null ? d.quantity : '—');
    const unit = d.quantity_unit || d.unit || 'servings';
    const needed = d.required_by || d.neededBy;
    const dateStr = needed ? new Date(needed).toLocaleString() : 'ASAP';
    const urgency = d.urgency || 'regular';
    const status = d.status || 'open';
    const dietary = d.dietary || (Array.isArray(d.dietary_requirements) ? d.dietary_requirements.join(', ') : d.dietary_requirements);
    const recurring = d.is_recurring || d.recurring;

    return `
      <div class="demand-item">
        <div class="demand-urgency urgency-${urgency}"></div>
        <div class="demand-info">
          <div class="demand-food">${foodName}</div>
          <div class="demand-meta">
            <span>📅 ${dateStr}</span>
            <span>⚡ ${urgency}</span>
            ${dietary ? `<span>🥗 ${dietary}</span>` : ''}
            ${recurring ? '<span>🔄 Recurring</span>' : ''}
          </div>
        </div>
        <div class="demand-right">
          <div class="demand-qty">${qty}</div>
          <div class="demand-qty-label">${unit}</div>
          <div class="demand-status-badge status-${status}">${status}</div>
          ${status === 'open' || status === 'active' || status === 'searching' ? `<br><button style="margin-top:6px; font-size:0.72rem; padding:4px 10px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); color:var(--red); border-radius:6px; cursor:pointer;" onclick="cancelDemand('${d.id}')">Cancel</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
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

  const body = {
    foodRequirement: foodType,
    foodType,
    quantityNeeded: quantity,
    quantity,
    quantityUnit: unit,
    unit,
    requiredBy: neededBy || new Date(Date.now() + 4 * 3600000).toISOString(),
    neededBy,
    dietaryRequirements: dietary ? [dietary] : [],
    dietary,
    notes,
    urgency: selectedUrgency || 'regular',
    isRecurring: !!recurring,
    recurring,
    recurrFreq,
    recurrTime
  };

  try {
    await api.demandOrg.postDemand(token, body);
    toast('✅ Demand registered! The network is searching for matching supply.', 'success');
    clearDemandForm();
    await loadDemands();
    showPage('my-demands');
  } catch (err) {
    console.error('[Demand Submit Error]', err);
    errEl.textContent = err.message || 'Failed to register demand';
    errEl.style.display = 'block';
    toast('❌ ' + (err.message || 'Failed to register demand'), 'error');
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
        <span>📍 ${m.distance ? (typeof m.distance === 'number' ? m.distance + ' km away' : m.distance) : '~2km away'}</span>
        <span>⏱️ Available: ${m.availableUntil ? new Date(m.availableUntil).toLocaleTimeString() : 'Now'}</span>
        <span>🚨 Your need: ${m.demandUrgency || 'regular'}</span>
      </div>
      ${m.explanation || m.notes ? `
      <div class="match-explanation" style="margin-top:8px; padding:7px 10px; background:rgba(16,185,129,0.08); border-left:3px solid #10b981; border-radius:4px; font-size:0.79rem; color:var(--text-primary, #e2e8f0); line-height:1.4;">
        <strong>💡 Why matched:</strong> ${m.explanation || m.notes}
      </div>` : ''}
      ${m.status === 'pending' ? `
      <div class="match-actions" style="margin-top:10px;">
        <button class="match-btn accept"  onclick="acceptMatch('${m.id}')">✅ Accept</button>
        <button class="match-btn decline" onclick="declineMatch('${m.id}')">✗ Decline</button>
      </div>` : `<span class="demand-status-badge status-${m.status}" style="margin-top:8px; display:inline-block;">${m.status}</span>`}
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
    ins = await api.demandOrg.getInsights(token);
  } catch (err) {
    console.error('loadInsights', err);
    ins = {};
  }

  setText('ins-fulfillment-rate', (ins.fulfillmentRate ?? 0) + '%');
  setText('ins-total-demands', ins.totalDemands ?? 0);
  setText('ins-unmet', ins.unmetDemands ?? 0);
  setText('ins-people-total', ins.peopleTotalServed ?? '0');

  renderDemandChart(ins.weeklyData || []);
  renderFoodBreakdown(ins.foodBreakdown || []);
  renderShortages(ins.shortages || []);
}

function renderDemandChart(data) {
  const wrap = document.getElementById('demand-chart');
  if (!wrap) return;
  const hasActivity = data && data.some(d => (d.demand > 0 || d.fulfilled > 0));
  if (!hasActivity) {
    wrap.innerHTML = `
      <div class="empty-state" style="padding: 30px 16px; text-align: center; margin: auto;">
        <div style="font-size: 2rem; margin-bottom: 8px;">📊</div>
        <p style="color:var(--text);font-weight:600;margin-bottom:4px;">No demand activity this week</p>
        <p style="color:var(--muted);font-size:0.85rem;">Register a food requirement to see daily demand vs fulfillment.</p>
      </div>`;
    return;
  }
  const max = Math.max(...data.map(d => Math.max(d.demand || 0, d.fulfilled || 0)), 1);

  const barsHtml = data.map(d => {
    const fulfilledHeight = d.fulfilled > 0 ? Math.max(8, Math.round((d.fulfilled / max) * 100)) : 0;
    const unmet = Math.max(0, d.demand - d.fulfilled);
    const unmetHeight = unmet > 0 ? Math.max(8, Math.round((unmet / max) * 100)) : 0;

    return `
      <div class="demand-chart-col">
        ${fulfilledHeight > 0 ? `
          <div class="demand-bar fulfilled" style="height: ${fulfilledHeight}%;">
            <div class="demand-bar-tooltip">${d.fulfilled} fulfilled</div>
          </div>
        ` : ''}
        ${unmetHeight > 0 ? `
          <div class="demand-bar unmet" style="height: ${unmetHeight}%;">
            <div class="demand-bar-tooltip">${unmet} unmet</div>
          </div>
        ` : ''}
        ${fulfilledHeight === 0 && unmetHeight === 0 ? `
          <div style="height: 3px; width: 14px; background: rgba(255,255,255,0.08); border-radius: 2px;"></div>
        ` : ''}
      </div>
    `;
  }).join('');

  const labelsHtml = data.map(d => `
    <div class="demand-chart-label">${d.day}</div>
  `).join('');

  wrap.innerHTML = `
    <div class="demand-chart-bars">
      ${barsHtml}
    </div>
    <div class="demand-chart-labels">
      ${labelsHtml}
    </div>
  `;
}

function renderFoodBreakdown(breakdown) {
  const el = document.getElementById('food-breakdown');
  if (!el) return;
  if (!breakdown || !breakdown.length) {
    el.innerHTML = '<div class="empty-state" style="padding:15px;color:var(--muted);">No food categories logged yet. Register a demand to see food categories.</div>';
    return;
  }
  el.innerHTML = breakdown.map(b =>
    `<span class="tag">${b.icon || '🍱'} ${b.type}: <strong>${b.quantity ? b.quantity + ' ' + (b.unit || '') : b.count + ' demands'}</strong></span>`
  ).join('');
}

function renderShortages(shortages) {
  const el = document.getElementById('shortage-list');
  if (!el) return;
  if (!shortages || !shortages.length) {
    el.innerHTML = `
      <div class="empty-state" style="padding: 20px;">
        <div class="empty-icon" style="font-size: 2rem;">✅</div>
        <p>No unmet shortage patterns detected.</p>
      </div>
    `;
    return;
  }
  el.innerHTML = shortages.map(s => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(239,68,68,0.06); border-radius:8px; margin-bottom:8px; border:1px solid rgba(239,68,68,0.2);">
      <div>
        <div style="font-weight:600; color:var(--text); font-size:0.9rem;">${s.type}</div>
        <div style="color:var(--muted); font-size:0.8rem;">${s.count} open requirement${s.count > 1 ? 's' : ''}</div>
      </div>
      <div style="color:var(--danger,#EF4444); font-weight:700; font-size:0.95rem;">${s.quantity} unmet</div>
    </div>
  `).join('');
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
      ? (alertData.value.alerts || []).filter(a => !a.is_read && !a.read).length : 0;
    const pendingMatches = matchData.status === 'fulfilled'
      ? (matchData.value.matches || []).filter(m => m.status === 'pending').length : 0;

    updateBadge('alert-badge', unreadAlerts);
    updateBadge('match-badge', pendingMatches);
    const dot = document.getElementById('topbar-alert-dot');
    if (dot) dot.style.display = unreadAlerts > 0 ? 'block' : 'none';
  } catch {
    updateBadge('alert-badge', 0);
    updateBadge('match-badge', 0);
    const dot = document.getElementById('topbar-alert-dot');
    if (dot) dot.style.display = 'none';
  }
}

function updateBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) { el.textContent = count; el.style.display = 'inline'; }
  else { el.style.display = 'none'; }
}

// ── EMPTY DEFAULTS ────────────────────────────────────────────
function demoDemandsData() { return []; }
function demoMatchesData() { return []; }
function demoInsightsData() {
  return {
    fulfillmentRate: 0, totalDemands: 0, unmetDemands: 0,
    peopleTotalServed: '0', peopleServedMonth: 0,
    weeklyData: [],
    foodBreakdown: [],
  };
}
function demoDailyData() { return []; }
function demoFoodBreakdown() { return []; }
function demoAlertsData() { return []; }

function loadDemoData() {
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
