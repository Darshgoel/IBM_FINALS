/**
 * FoodBridge — Demand-Org Dashboard JS
 * Sections: Overview, Register Demand, My Demands, Matches, Capacity, Insights, Alerts, Profile
 *
 * Adapted to the IBM_FINALS backend. Only fields and actions supported by the
 * target API are used; unsupported source-only controls are intentionally absent.
 */

import api from './api.js';

// ── Auth guard ───────────────────────────────────────────────
const token = localStorage.getItem('fb_token');
const user = JSON.parse(localStorage.getItem('fb_user') || 'null');

if (!token || !user || user.role !== 'demand_org') {
  window.location.href = '/demand-org/index.html';
  throw new Error('Demand organization authentication required');
}

// ── State ────────────────────────────────────────────────────
let allDemands = [];
let allMatches = [];
let allAlerts = [];
let demandFilter = 'all';
let demandSearch = '';
let demandSort = 'newest';
let selectedUrgency = 'regular';
let profile = {};
let currentPage = 'overview';
let matchFilter = 'all';
let matchSearch = '';
let matchDetailLastFocus = null;
let currentCapacity = null;

// ── Page Router ──────────────────────────────────────────────
const pageMap = {
  overview: 'page-overview',
  'register-demand': 'page-register-demand',
  'my-demands': 'page-my-demands',
  matches: 'page-matches',
  capacity: 'page-capacity',
  insights: 'page-insights',
  alerts: 'page-alerts',
  profile: 'page-profile'
};

const pageTitles = {
  overview: ['Overview', 'Your organization activity at a glance'],
  'register-demand': ['Register Demand', 'Post a new food requirement'],
  'my-demands': ['My Demands', 'Manage all your registered needs'],
  matches: ['Matched Supply', 'Supply matched automatically by the network'],
  capacity: ['Capacity', 'Declared receiving and serving limits'],
  insights: ['Insights', 'Demand trends and fulfillment analysis'],
  alerts: ['Alerts', 'Network notifications for your organization'],
  profile: ['Organization Profile', 'Manage your organization information']
};

window.showPage = function (page) {
  const target = document.getElementById(pageMap[page]);
  if (!target) return;

  Object.values(pageMap).forEach(id => document.getElementById(id)?.classList.remove('active'));
  target.classList.add('active');

  Object.keys(pageMap).forEach(key => {
    const nav = document.getElementById(`nav-${key}`);
    nav?.classList.remove('active');
    nav?.removeAttribute('aria-current');
  });
  const activeNav = document.getElementById(`nav-${page}`);
  if (activeNav) {
    activeNav.classList.add('active');
    activeNav.setAttribute('aria-current', 'page');
  }

  const [title, sub] = pageTitles[page] || [page, ''];
  setText('topbar-title', title);
  setText('topbar-sub', sub);
  currentPage = page;
  loadPageData(page);
  window.closeSidebar?.();
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
      default: break;
    }
  } catch (err) {
    showToast(err.message || 'This page could not be loaded.', 'error');
  }
}

// ── Init ─────────────────────────────────────────────────────
async function init() {
  try {
    const meData = await api.auth.me(token);
    profile = meData.user || {};
    const org = meData.org || {};
    const orgName = org.name || profile.name || 'Organization';
    const initials = getInitials(orgName);
    const orgType = formatOrgType(org.type || profile.role);

    setText('sidebar-avatar', initials);
    setText('sidebar-org-name', orgName);
    setText('sidebar-org-type', orgType);
    setText('welcome-name', orgName);
    setText('user-chip', orgName);
    setText('account-name', orgName);
    setText('account-email', user.email || '—');
    setText('profile-account-email', user.email || '—');
    setText('profile-org-type', orgType);
    setText('account-avatar', initials);
    setText('account-menu-avatar', initials);
    setText('topbar-sub', orgType);

    await loadOverview();
    await checkUnreadBadges();
    selectUrgency('regular');
    initLiveNotifications();
  } catch (err) {
    showToast('Could not load your organization data. Please sign in again.', 'error');
  }
}

function initLiveNotifications() {
  if (!token || !('EventSource' in window)) return;
  try {
    const evtSource = new EventSource(`/api/notifications/stream?token=${encodeURIComponent(token)}`);
    evtSource.addEventListener('notification', event => {
      try {
        const notification = JSON.parse(event.data);
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(notification.title, { body: notification.message });
        }
        showToast(`${notification.title}: ${notification.message}`, 'info');
        checkUnreadBadges();
        if (currentPage === 'overview') loadOverview();
        if (currentPage === 'matches') loadMatches();
        if (currentPage === 'alerts') loadAlerts();
        if (currentPage === 'my-demands') loadDemands();
      } catch (err) {
        // Keep the stream alive; a malformed event should not break the page.
      }
    });
  } catch (err) {
    // SSE is additive; the portal remains usable without it.
  }
}

function formatOrgType(type) {
  const map = {
    ngo: 'NGO / Charity',
    food_bank: 'Food Bank',
    community_kitchen: 'Community Kitchen',
    shelter: 'Shelter / Refuge',
    demand_org: 'Demand Organization',
    other_demand: 'Other demand organization'
  };
  return map[type] || type || 'Demand Organization';
}

// ── Overview ─────────────────────────────────────────────────
async function loadOverview() {
  const [demandsData, matchesData, insightsData, alertsData] = await Promise.allSettled([
    api.demandOrg.getDemands(token),
    api.demandOrg.getMatches(token),
    api.demandOrg.getInsights(token),
    api.demandOrg.getAlerts(token)
  ]);

  const demands = demandsData.status === 'fulfilled'
    ? (demandsData.value.demands || []).map(mapDemand)
    : [];
  const matches = matchesData.status === 'fulfilled'
    ? (matchesData.value.matches || []).map(mapMatch)
    : [];
  const insights = insightsData.status === 'fulfilled' ? insightsData.value : {};
  const alerts = alertsData.status === 'fulfilled'
    ? (alertsData.value.alerts || []).map(mapAlert)
    : [];

  allDemands = demands;
  allMatches = matches;
  allAlerts = alerts;

  const active = demands.filter(d => ['active', 'matched', 'searching'].includes(d.status)).length;
  const fulfilled = demands.filter(d => d.status === 'fulfilled').length;
  const pending = matches.filter(m => m.status === 'pending').length;

  setText('stat-active', active);
  setText('stat-fulfilled', fulfilled);
  setText('stat-pending', pending);
  setText('stat-people', insights.peopleTotalServed != null
    ? Number(insights.peopleTotalRaw ?? insights.peopleTotalServed).toLocaleString()
    : '0');
  setText('stat-active-sub', active ? 'Open needs currently in matching' : 'No open needs right now');
  setText('stat-fulfilled-sub', fulfilled ? 'Needs completed through the network' : 'No fulfilled needs yet');
  setText('stat-pending-sub', pending ? 'Offers awaiting your decision' : 'No offers awaiting a decision');
  setText('stat-people-sub', insights.peopleTotalRaw
    ? 'Servings committed, all time'
    : 'No handovers recorded yet');

  const recentDemands = demands
    .filter(d => d.status !== 'cancelled')
    .slice(0, 3);
  renderDemandList('overview-demands', recentDemands, { compact: true });

  const orderedMatches = [...matches].sort(matchPriority);
  renderMatchList('overview-matches', orderedMatches.slice(0, 3), { compact: true });
  renderAlertList('overview-alerts', alerts.slice(0, 3));

  if (demandsData.status === 'rejected' && matchesData.status === 'rejected') {
    showToast('Overview data could not be loaded from the server.', 'error');
  }
}

// ── Demands ──────────────────────────────────────────────────
function mapDemandStatus(status) {
  if (status === 'open' || status === 'searching') return 'active';
  if (status === 'partially_fulfilled') return 'matched';
  return status || 'active';
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return String(value).split(',').map(item => item.trim()).filter(Boolean);
  }
}

function mapDemand(d) {
  return {
    id: d.id,
    foodType: d.foodType || d.food_requirement,
    quantity: d.quantity ?? d.quantity_needed,
    unit: d.unit || d.quantity_unit,
    neededBy: d.neededBy || d.required_by,
    createdAt: d.created_at,
    urgency: d.urgency || 'regular',
    dietary: d.dietary != null
      ? (Array.isArray(d.dietary) ? d.dietary.join(', ') : String(d.dietary))
      : parseJsonList(d.dietary_requirements).join(', '),
    recurring: Boolean(d.is_recurring),
    status: mapDemandStatus(d.status),
    rawStatus: d.status,
    recurringPattern: d.recurring_pattern,
    matchId: d.match_id,
    matchStatus: d.match_status,
    matchedFood: d.matched_food_name,
    matchedDonor: d.matched_donor_name
  };
}

function mapMatch(m) {
  return {
    id: m.id,
    demandId: m.demand_id,
    donorName: m.donorName || m.donor_name,
    donorPhone: m.donor_phone,
    donorEmail: m.donor_email,
    foodType: m.foodName || m.food_name || m.foodType || m.food_type,
    quantity: m.quantity ?? m.allocated_quantity,
    unit: m.unit || m.allocated_unit || m.surplus_unit,
    matchScore: Math.round(m.matchScore || m.match_score || 0),
    availableUntil: m.availableUntil || m.remaining_usable_time,
    status: m.status,
    pickupAddress: m.pickup_address,
    instructions: m.special_instructions,
    explanation: m.explanation || m.notes,
    demandUrgency: m.demandUrgency || m.demand_urgency || 'regular',
    routeDistanceKm: m.route_distance_km,
    routeDurationMinutes: m.route_duration_minutes,
    routeProvider: m.route_provider,
    matchedAt: m.matched_at,
    completedAt: m.completed_at
  };
}

function mapAlert(a) {
  return {
    id: a.id,
    title: a.title,
    message: a.message || a.title,
    type: a.type || 'info',
    read: Boolean(a.is_read),
    createdAt: a.created_at
  };
}

async function loadDemands() {
  const list = document.getElementById('demands-list');
  if (list) list.innerHTML = '<div class="empty-state"><p>Loading your demands…</p></div>';
  try {
    const data = await api.demandOrg.getDemands(token);
    allDemands = (data.demands || []).map(mapDemand);
    renderMyDemands();
  } catch (err) {
    if (list) {
      list.innerHTML = `<div class="error-state">${fbIcon('alert-circle')}<strong>Demands could not be loaded</strong><span>${escapeHtml(err.message || 'Please try again.')}</span><button class="btn btn-sm" type="button" onclick="loadDemands()">Retry</button></div>`;
    }
    showToast(err.message || 'Demands could not be loaded.', 'error');
  }
}

window.filterDemands = function (status, button) {
  demandFilter = status;
  document.querySelectorAll('#page-my-demands .filter-btn').forEach(btn => btn.classList.remove('active'));
  (button || document.getElementById(`filter-${status}`))?.classList.add('active');
  renderMyDemands();
};

window.setDemandSearch = value => {
  demandSearch = String(value || '').trim().toLowerCase();
  renderMyDemands();
};

window.setDemandSort = value => {
  demandSort = value || 'newest';
  renderMyDemands();
};

window.resetDemandFilters = () => {
  demandFilter = 'all';
  demandSearch = '';
  demandSort = 'newest';
  const search = document.getElementById('demand-search');
  const sort = document.getElementById('demand-sort');
  if (search) search.value = '';
  if (sort) sort.value = 'newest';
  document.querySelectorAll('#page-my-demands .filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.id === 'filter-all');
  });
  renderMyDemands();
};

function filterDemandsArr(arr, status) {
  if (status === 'all') return arr;
  if (status === 'active') {
    return arr.filter(d => ['active', 'matched'].includes(d.status));
  }
  if (status === 'searching') {
    return arr.filter(d => d.rawStatus === 'open' || d.rawStatus === 'searching');
  }
  if (status === 'matched') {
    return arr.filter(d => ['matched', 'partially_fulfilled'].includes(d.status) || d.rawStatus === 'partially_fulfilled');
  }
  if (status === 'fulfilled') {
    return arr.filter(d => ['fulfilled', 'completed'].includes(d.status));
  }
  if (status === 'recurring') {
    return arr.filter(d => d.recurring);
  }
  if (status === 'cancelled') {
    return arr.filter(d => ['cancelled', 'canceled'].includes(d.status));
  }
  return arr.filter(d => d.status === status);
}

function visibleDemands() {
  let list = filterDemandsArr(allDemands, demandFilter);
  if (demandSearch) {
    list = list.filter(demand => {
      const haystack = [
        demand.foodType,
        demand.status,
        demand.urgency,
        demand.dietary,
        demand.matchedFood,
        demand.matchedDonor
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(demandSearch);
    });
  }

  const urgencyRank = { emergency: 4, immediate: 3, regular: 2, planned: 1 };
  list.sort((a, b) => {
    if (demandSort === 'deadline') return new Date(a.neededBy || '9999-12-31') - new Date(b.neededBy || '9999-12-31');
    if (demandSort === 'quantity') return (Number(b.quantity) || 0) - (Number(a.quantity) || 0);
    if (demandSort === 'urgency') return (urgencyRank[b.urgency] || 0) - (urgencyRank[a.urgency] || 0);
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
  return list;
}

function renderMyDemands() {
  const list = visibleDemands();
  const count = document.getElementById('demand-count');
  if (count) count.textContent = `${list.length} of ${allDemands.length}`;
  renderDemandList('demands-list', list, { showActions: true });
}

function renderDemandList(containerId, demands, options = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!demands || demands.length === 0) {
    const hasFilters = containerId === 'demands-list' && (demandFilter !== 'all' || Boolean(demandSearch));
    el.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">${fbIcon('inbox')}</span>
        <strong>${hasFilters ? 'No demands match this view' : 'No demands registered yet'}</strong>
        <p>${hasFilters ? 'Try a different status filter or clear the search.' : 'Register your first food need and the network will look for safe, feasible supply.'}</p>
        ${hasFilters
          ? '<button class="cta" type="button" onclick="resetDemandFilters()">Reset filters</button>'
          : '<button class="cta" type="button" onclick="showPage(\'register-demand\')">Register a demand</button>'}
      </div>`;
    return;
  }

  el.innerHTML = demands.map(demand => {
    const status = demandStatusMeta(demand);
    const cancellable = ['active', 'matched'].includes(demand.status);
    const urgency = urgencyMeta(demand.urgency);
    return `
      <article class="demand-item">
        <div class="demand-urgency urgency-${escapeAttr(demand.urgency)}"></div>
        <div class="demand-info">
          <div class="demand-food">${escapeHtml(demand.foodType || 'Food requirement')}</div>
          <div class="demand-meta">
            <span>${fbIcon('calendar', 'icon icon-sm')} ${demand.neededBy ? `Needed ${fmtDt(demand.neededBy)}` : 'No fixed deadline'}</span>
            <span class="badge badge-${urgency.tone}">${urgency.label}</span>
            ${demand.dietary ? `<span>${fbIcon('leaf', 'icon icon-sm')} ${escapeHtml(demand.dietary)}</span>` : ''}
            ${demand.recurring ? `<span class="badge badge-recurring">${fbIcon('recycle', 'icon icon-sm')} Recurring</span>` : ''}
            ${demand.matchedDonor ? `<span>${fbIcon('truck', 'icon icon-sm')} ${escapeHtml(demand.matchedFood || 'Supply')} from ${escapeHtml(demand.matchedDonor)}</span>` : ''}
          </div>
        </div>
        <div class="demand-right">
          <div class="demand-qty">${demand.quantity != null ? escapeHtml(demand.quantity) : '—'}</div>
          <div class="demand-qty-label">${escapeHtml(demand.unit || 'servings')}</div>
          <span class="badge demand-status-badge badge-${status.tone}">${status.label}</span>
          ${options.showActions && cancellable
            ? `<button class="link-btn" type="button" style="margin-top:5px;color:var(--fb-error)" onclick="cancelDemand('${escapeAttr(demand.id)}')" aria-label="Cancel ${escapeAttr(demand.foodType || 'demand')}">${fbIcon('trash', 'icon icon-sm')} Cancel</button>`
            : ''}
          ${options.showActions && demand.matchId
            ? `<button class="link-btn" type="button" style="margin-top:5px" onclick="showPage('matches')">${fbIcon('truck', 'icon icon-sm')} View match</button>`
            : ''}
        </div>
      </article>`;
  }).join('');
}

function demandStatusMeta(demand) {
  const map = {
    active: { label: 'Active', tone: 'info' },
    searching: { label: 'Searching', tone: 'warning' },
    matched: { label: 'Matched', tone: 'info' },
    fulfilled: { label: 'Fulfilled', tone: 'success' },
    cancelled: { label: 'Cancelled', tone: 'danger' },
    canceled: { label: 'Cancelled', tone: 'danger' },
    expired: { label: 'Expired', tone: 'danger' }
  };
  return map[demand.status] || { label: String(demand.status || 'Unknown').replace(/_/g, ' '), tone: 'neutral' };
}

function urgencyMeta(urgency) {
  const map = {
    emergency: { label: 'Emergency', tone: 'urgent' },
    immediate: { label: 'Immediate', tone: 'immediate' },
    regular: { label: 'Regular', tone: 'regular' },
    planned: { label: 'Planned', tone: 'planned' }
  };
  return map[urgency] || map.regular;
}

window.cancelDemand = async function (id) {
  const demand = allDemands.find(item => item.id === id);
  const confirmed = await window.fbConfirm({
    title: 'Cancel this demand?',
    message: 'The need will be withdrawn from matching and any pending offers will be released. This cannot be undone.',
    confirmLabel: 'Cancel demand',
    cancelLabel: 'Keep it',
    tone: 'danger',
    details: demand ? `<strong>${escapeHtml(demand.foodType || 'Demand')}</strong><br>${escapeHtml(demand.quantity)} ${escapeHtml(demand.unit || 'servings')}` : ''
  });
  if (!confirmed) return;

  try {
    await api.demandOrg.cancelDemand(token, id);
    showToast('Demand cancelled.', 'success');
    await Promise.all([loadDemands(), currentPage === 'overview' ? loadOverview() : Promise.resolve()]);
  } catch (err) {
    showToast(err.message || 'The demand could not be cancelled.', 'error');
  }
};

// ── Submit Demand ────────────────────────────────────────────
window.selectUrgency = function (urgency) {
  selectedUrgency = urgency;
  document.querySelectorAll('#urgency-selector .urgency-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.urgency === urgency);
    btn.setAttribute('aria-pressed', String(btn.dataset.urgency === urgency));
  });
};

window.submitDemand = async function () {
  const foodTypeEl = document.getElementById('d-food-type');
  const foodType = foodTypeEl.value;
  const foodTypeLabel = foodTypeEl.options[foodTypeEl.selectedIndex]?.text || 'Food';
  const quantity = parseInt(document.getElementById('d-quantity').value, 10);
  const unit = document.getElementById('d-unit').value;
  const neededBy = document.getElementById('d-needed-by').value;
  const dietary = document.getElementById('d-dietary').value.trim();
  const notes = document.getElementById('d-notes').value.trim();
  const recurring = document.getElementById('d-recurring').checked;
  const recurrFreq = document.getElementById('d-recur-freq')?.value || 'daily';
  const recurrTime = document.getElementById('d-recur-time')?.value || '17:00';

  const errEl = document.getElementById('demand-error');
  const fail = message => {
    errEl.textContent = message;
    errEl.style.display = 'block';
    errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  errEl.style.display = 'none';
  if (!quantity || quantity < 1) return fail('Please enter a valid quantity.');
  if (neededBy && new Date(neededBy) <= new Date()) return fail('The needed-by time must be in the future.');

  const button = document.getElementById('demand-submit-btn');
  button.disabled = true;
  button.innerHTML = '<span class="spinner" style="border-color:rgba(255,255,255,.35);border-top-color:#fff"></span> Registering…';

  const foodRequirement = `${foodTypeLabel}${notes ? ' — ' + notes : ''}`;
  const body = {
    foodRequirement,
    quantityNeeded: quantity,
    quantityUnit: unit,
    requiredBy: neededBy ? new Date(neededBy).toISOString() : undefined,
    urgency: selectedUrgency,
    dietaryRequirements: dietary
      ? dietary.split(/[,;]/).map(item => item.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean)
      : [],
    isRecurring: recurring
  };
  if (recurring) {
    body.recurringPattern = {
      frequency: recurrFreq,
      time: recurrTime,
      quantity,
      unit
    };
  }

  try {
    const result = await api.demandOrg.postDemand(token, body);
    showToast(result.message || 'Demand registered. The network is searching for matching supply.', 'success');
    clearDemandForm();
    showPage('my-demands');
  } catch (err) {
    fail(err.message || 'The demand could not be registered.');
    showToast(err.message || 'The demand could not be registered.', 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = `${fbIcon('plus')} Register demand`;
  }
};

window.clearDemandForm = function () {
  ['d-food-type', 'd-quantity', 'd-unit', 'd-needed-by', 'd-dietary', 'd-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === 'SELECT') el.selectedIndex = 0;
    else el.value = '';
  });
  document.getElementById('d-recurring').checked = false;
  document.getElementById('recurring-fields').style.display = 'none';
  selectedUrgency = 'regular';
  selectUrgency('regular');
  hideMsg('demand-error');
};

document.getElementById('d-recurring').addEventListener('change', event => {
  document.getElementById('recurring-fields').style.display = event.target.checked ? 'block' : 'none';
});

// ── Matches ──────────────────────────────────────────────────
function matchGroup(status) {
  if (status === 'pending') return 'action';
  if (status === 'in_transit' || status === 'accepted') return 'active';
  if (status === 'completed') return 'completed';
  return 'other';
}

function matchPriority(a, b) {
  const rank = { pending: 0, in_transit: 1, completed: 2, declined: 3, cancelled: 4 };
  return (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
}

async function loadMatches() {
  const list = document.getElementById('matches-list');
  if (list) list.innerHTML = '<div class="empty-state"><p>Loading matched supply…</p></div>';
  try {
    const data = await api.demandOrg.getMatches(token);
    allMatches = (data.matches || []).map(mapMatch);
    renderMatchList('matches-list', allMatches);
  } catch (err) {
    allMatches = [];
    if (list) {
      list.innerHTML = `<div class="error-state">${fbIcon('alert-circle')}<strong>Matched supply could not be loaded</strong><span>${escapeHtml(err.message || 'Please try again.')}</span><button class="btn btn-sm" type="button" onclick="loadMatches()">Retry</button></div>`;
    }
    showToast(err.message || 'Matched supply could not be loaded.', 'error');
  }
}

window.filterMatches = (filter, button) => {
  matchFilter = filter;
  document.querySelectorAll('#page-matches [data-match-filter]').forEach(btn => btn.classList.remove('active'));
  (button || document.querySelector(`#page-matches [data-match-filter="${filter}"]`))?.classList.add('active');
  renderMatchList('matches-list', allMatches);
};

window.setMatchSearch = value => {
  matchSearch = String(value || '').trim().toLowerCase();
  renderMatchList('matches-list', allMatches);
};

function visibleMatches(matches) {
  const needle = matchSearch;
  return matches.filter(match => {
    if (matchFilter !== 'all' && matchGroup(match.status) !== matchFilter) return false;
    if (!needle) return true;
    return [match.donorName, match.foodType, match.pickupAddress, match.status, match.instructions]
      .filter(Boolean).join(' ').toLowerCase().includes(needle);
  });
}

function renderMatchList(containerId, matches, options = {}) {
  const isMain = containerId === 'matches-list';
  const list = isMain ? visibleMatches(matches) : matches;
  const el = document.getElementById(containerId);
  if (!el) return;

  if (isMain) {
    const pending = matches.filter(match => match.status === 'pending').length;
    const active = matches.filter(match => match.status === 'in_transit').length;
    const completed = matches.filter(match => match.status === 'completed').length;
    setText('match-summary', `${pending} awaiting decision · ${active} in transit · ${completed} completed`);
  }

  if (!list || list.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">${fbIcon('truck')}</span>
        <strong>${isMain ? 'No matches in this view' : 'No matched supply yet'}</strong>
        <p>${isMain
          ? `Nothing matches the current filter${matchSearch ? ` and search “${escapeHtml(matchSearch)}”` : ''}. The network will surface suitable supply automatically.`
          : 'The network will surface suitable supply automatically when a safe match is found.'}</p>
        ${isMain && (matchFilter !== 'all' || matchSearch)
          ? '<button class="cta" type="button" onclick="resetMatchFilters()">Reset filters</button>'
          : '<button class="cta" type="button" onclick="showPage(\'register-demand\')">Register a demand</button>'}
      </div>`;
    return;
  }

  if (options.compact) {
    el.innerHTML = list.map(match => {
      const status = matchStatusMeta(match.status);
      return `
        <article class="match-card">
          <div class="match-header">
            <div>
              <div class="match-donor">${escapeHtml(match.donorName || 'FoodBridge donor')}</div>
              <div class="match-details" style="margin-top:4px">
                <span>${fbIcon('utensils', 'icon icon-sm')} ${escapeHtml(match.foodType || 'Mixed food')}</span>
                <span>${fbIcon('scale', 'icon icon-sm')} ${escapeHtml(match.quantity || '—')} ${escapeHtml(match.unit || 'servings')}</span>
              </div>
            </div>
            <span class="badge badge-${status.tone}">${status.label}</span>
          </div>
          <div class="match-details">
            <span>${fbIcon('pin', 'icon icon-sm')} ${escapeHtml(match.pickupAddress || 'Donor site')}</span>
            <span>${fbIcon('clock', 'icon icon-sm')} Use by ${fmtDt(match.availableUntil)}</span>
          </div>
          <div class="match-actions">
            <button class="btn btn-sm" type="button" onclick="showPage('matches')">${fbIcon('eye')} Review match</button>
          </div>
        </article>`;
    }).join('');
    return;
  }

  el.innerHTML = list.map(match => {
    const status = matchStatusMeta(match.status);
    return `
      <article class="match-card" id="match-card-${escapeAttr(match.id)}">
        <div class="match-header">
          <div>
            <div class="match-donor">${fbIcon('building')} ${escapeHtml(match.donorName || 'FoodBridge donor')}</div>
            <div class="match-details" style="margin-top:4px">
              <span>${fbIcon('utensils', 'icon icon-sm')} ${escapeHtml(match.foodType || 'Mixed food')}</span>
              ${match.donorPhone ? `<span>${fbIcon('phone', 'icon icon-sm')} ${escapeHtml(match.donorPhone)}</span>` : ''}
            </div>
          </div>
          <span class="match-score">${fbIcon('target')} ${Number(match.matchScore) || 0}% match</span>
        </div>
        <div class="match-details">
          <span>${fbIcon('scale', 'icon icon-sm')} ${escapeHtml(match.quantity || '—')} ${escapeHtml(match.unit || 'servings')}</span>
          <span>${fbIcon('pin', 'icon icon-sm')} ${escapeHtml(match.pickupAddress || 'Donor site')}</span>
          <span>${fbIcon('clock', 'icon icon-sm')} Use by ${fmtDt(match.availableUntil)}</span>
          ${match.routeDistanceKm != null
            ? `<span>${fbIcon('route', 'icon icon-sm')} ${Number(match.routeDistanceKm).toFixed(1)} km · ~${Math.round(match.routeDurationMinutes || 0)} min${match.routeProvider ? ` · ${escapeHtml(match.routeProvider)}` : ''}</span>`
            : ''}
          <span>${fbIcon('alert', 'icon icon-sm')} Your urgency: ${escapeHtml(match.demandUrgency || 'regular')}</span>
          ${match.explanation ? `<span>${fbIcon('lightbulb', 'icon icon-sm')} ${escapeHtml(match.explanation)}</span>` : ''}
        </div>
        <div class="match-actions">
          <span class="badge badge-${status.tone}">${status.label}</span>
          <button class="btn btn-sm" type="button" onclick="openMatchDetail('${escapeAttr(match.id)}')">${fbIcon('eye')} View details</button>
          ${match.status === 'pending'
            ? `<button class="match-btn accept" type="button" data-match-accept="${escapeAttr(match.id)}" onclick="acceptMatch('${escapeAttr(match.id)}', this)">${fbIcon('check')} Accept offer</button>`
            : ''}
          ${['pending'].includes(match.status)
            ? `<button class="match-btn decline" type="button" onclick="declineMatch('${escapeAttr(match.id)}')">${fbIcon('x')} Decline</button>`
            : ''}
        </div>
        ${match.status === 'in_transit' ? '<div class="form-help" style="margin-top:8px">You have accepted this offer and confirmed the transfer. The donor records the completed handover.</div>' : ''}
        ${match.status === 'completed' ? '<div class="form-help" style="margin-top:8px">This handover is complete and is included in your impact history.</div>' : ''}
      </article>`;
  }).join('');
}

window.resetMatchFilters = () => {
  matchFilter = 'all';
  matchSearch = '';
  const search = document.getElementById('match-search');
  if (search) search.value = '';
  document.querySelectorAll('#page-matches [data-match-filter]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.matchFilter === 'all');
  });
  renderMatchList('matches-list', allMatches);
};

function matchStatusMeta(status) {
  const map = {
    pending: { label: 'Awaiting decision', tone: 'warning' },
    in_transit: { label: 'Accepted · in transit', tone: 'info' },
    completed: { label: 'Completed', tone: 'success' },
    declined: { label: 'Declined', tone: 'danger' },
    cancelled: { label: 'Cancelled', tone: 'danger' }
  };
  return map[status] || { label: String(status || 'Unknown').replace(/_/g, ' '), tone: 'neutral' };
}

window.openMatchDetail = function (id) {
  const match = allMatches.find(item => item.id === id);
  const modal = document.getElementById('matchDetailModal');
  const body = document.getElementById('matchDetailBody');
  const title = document.getElementById('matchDetailTitle');
  const footer = document.getElementById('matchDetailFooter');
  if (!match || !modal || !body) return;

  matchDetailLastFocus = document.activeElement;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  title.textContent = match.foodType || 'Matched supply';
  const status = matchStatusMeta(match.status);

  body.innerHTML = `
    <div class="fb-detail-grid">
      <div class="fb-detail-item"><small>Status</small><strong><span class="badge badge-${status.tone}">${status.label}</span></strong></div>
      <div class="fb-detail-item"><small>Match score</small><strong>${Number(match.matchScore) || 0}%</strong></div>
      <div class="fb-detail-item"><small>Donor</small><strong>${escapeHtml(match.donorName || 'FoodBridge donor')}</strong></div>
      <div class="fb-detail-item"><small>Quantity</small><strong>${escapeHtml(match.quantity || '—')} ${escapeHtml(match.unit || 'servings')}</strong></div>
      <div class="fb-detail-item"><small>Use by</small><span>${fmtDt(match.availableUntil)}</span></div>
      <div class="fb-detail-item"><small>Your urgency</small><span>${escapeHtml(match.demandUrgency || 'regular')}</span></div>
      <div class="fb-detail-item full"><small>Pickup address</small><span>${escapeHtml(match.pickupAddress || 'Donor site')}</span></div>
      <div class="fb-detail-item full"><small>Collection instructions</small><span>${escapeHtml(match.instructions || 'None recorded')}</span></div>
      ${match.routeDistanceKm != null ? `<div class="fb-detail-item"><small>Route</small><span>${Number(match.routeDistanceKm).toFixed(1)} km · ~${Math.round(match.routeDurationMinutes || 0)} min</span></div>` : ''}
      ${match.routeProvider ? `<div class="fb-detail-item"><small>Routing source</small><span>${escapeHtml(match.routeProvider)}</span></div>` : ''}
      ${match.donorPhone ? `<div class="fb-detail-item"><small>Donor phone</small><span>${escapeHtml(match.donorPhone)}</span></div>` : ''}
      ${match.donorEmail ? `<div class="fb-detail-item"><small>Donor email</small><span>${escapeHtml(match.donorEmail)}</span></div>` : ''}
    </div>
    ${match.explanation ? `<div class="fb-detail-note"><strong>Why this matched:</strong> ${escapeHtml(match.explanation)}</div>` : ''}
    ${match.status === 'pending' ? '<div class="fb-dialog-details">Accepting confirms that your team can collect and safely handle this food within its usable window. Pending offers are held for your decision.</div>' : ''}
    ${match.status === 'in_transit' ? '<div class="fb-detail-note">You have accepted this offer. The donor completes the handover record.</div>' : ''}
  `;

  footer.innerHTML = `
    ${match.status === 'pending'
      ? `<button class="btn btn-primary" type="button" data-match-accept="${escapeAttr(match.id)}" onclick="acceptMatch('${escapeAttr(match.id)}', this)">${fbIcon('check')} Accept offer</button>`
      : ''}
    ${match.status === 'pending'
      ? `<button class="btn btn-danger" type="button" onclick="declineMatch('${escapeAttr(match.id)}')">${fbIcon('x')} Decline</button>`
      : ''}
    <button class="btn" type="button" onclick="closeMatchDetail()">Close</button>
  `;

  modal.querySelector('.fb-modal-close')?.focus();
};

window.closeMatchDetail = function () {
  const modal = document.getElementById('matchDetailModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  if (matchDetailLastFocus && typeof matchDetailLastFocus.focus === 'function') matchDetailLastFocus.focus();
  matchDetailLastFocus = null;
};

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMatchDetail();
});

window.acceptMatch = async function (id, button) {
  const match = allMatches.find(item => item.id === id);
  if (!match) return;

  const confirmed = await window.fbConfirm({
    title: 'Accept this food offer?',
    message: 'Confirm the food is still within its usable window, packaging is intact, and your team can store and serve it safely. Accepting starts the pickup workflow.',
    confirmLabel: 'Accept offer',
    cancelLabel: 'Not now',
    details: `<strong>${escapeHtml(match.foodType || 'Matched supply')}</strong><br>${escapeHtml(match.quantity)} ${escapeHtml(match.unit || 'servings')} from ${escapeHtml(match.donorName || 'donor')}<br>Pickup: ${escapeHtml(match.pickupAddress || 'donor site')}`
  });
  if (!confirmed) return;

  const controls = button
    ? [button]
    : [...document.querySelectorAll(`[data-match-accept="${cssEscape(id)}"]`)];
  const original = button?.innerHTML;
  controls.forEach(control => {
    control.disabled = true;
    if (control === button) control.innerHTML = '<span class="spinner"></span> Accepting…';
  });

  try {
    await api.demandOrg.acceptMatch(token, id);
    showToast('Offer accepted. Collect within the usable window.', 'success');
    closeMatchDetail();
    await Promise.all([loadMatches(), loadOverview(), checkUnreadBadges()]);
  } catch (err) {
    showToast(err.message || 'The offer could not be accepted.', 'error');
    controls.forEach(control => { control.disabled = false; });
    if (button && original) button.innerHTML = original;
  }
};

window.declineMatch = async function (id) {
  const match = allMatches.find(item => item.id === id);
  const confirmed = await window.fbConfirm({
    title: 'Decline this offer?',
    message: 'The reserved food is released back to the network and may be re-routed to another recipient. If you are unsure about safety or capacity, declining is safer than accepting food you cannot handle.',
    confirmLabel: 'Decline offer',
    cancelLabel: 'Keep offer',
    tone: 'warning',
    details: match ? `<strong>${escapeHtml(match.foodType || 'Matched supply')}</strong><br>${escapeHtml(match.quantity)} ${escapeHtml(match.unit || 'servings')} from ${escapeHtml(match.donorName || 'donor')}` : ''
  });
  if (!confirmed) return;

  try {
    const result = await api.demandOrg.declineMatch(token, id);
    showToast(result.message || 'Offer declined. Food released for re-routing.', 'success');
    closeMatchDetail();
    await Promise.all([loadMatches(), loadOverview(), checkUnreadBadges()]);
  } catch (err) {
    showToast(err.message || 'The offer could not be declined.', 'error');
  }
};

// ── Capacity ─────────────────────────────────────────────────
async function loadCapacity() {
  try {
    const [profileData, demandsData] = await Promise.all([
      api.demandOrg.getProfile(token),
      api.demandOrg.getDemands(token)
    ]);

    const orgProfile = profileData.profile || {};
    const demands = (demandsData.demands || []).map(mapDemand);

    currentCapacity = {
      receiving: orgProfile.receiving_capacity,
      serving: orgProfile.serving_capacity,
      storage: orgProfile.storage_capacity,
      dietary: orgProfile.dietary_restrictions
    };

    setValue('cap-receive', toInputValue(orgProfile.receiving_capacity));
    setValue('cap-serve', toInputValue(orgProfile.serving_capacity));
    setValue('cap-storage', toInputValue(orgProfile.storage_capacity));
    updateCapacityBars(currentCapacity);
    renderDemandProfile(orgProfile, demands);
    renderRecurring(demands.filter(demand => demand.recurring && demand.status !== 'cancelled'));
  } catch (err) {
    showToast(err.message || 'Capacity could not be loaded.', 'error');
  }
}

function toInputValue(value) {
  if (value == null || value === '') return '';
  const num = Number(value);
  return Number.isFinite(num) ? num : '';
}

function updateCapacityBars(cap) {
  const receiving = toInputValue(cap.receiving);
  const serving = toInputValue(cap.serving);
  const storage = toInputValue(cap.storage);

  setBarWidth('bar-receive', 0);
  setBarWidth('bar-serve', 0);
  setBarWidth('bar-storage', 0);

  setText('val-receive', receiving === '' ? 'Not declared' : `${receiving} servings`);
  setText('val-serve', serving === '' ? 'Not declared' : `${serving} meals/day`);
  setText('val-storage', storage === '' ? 'Not declared' : `${storage} kg`);
  setText('cap-utilization-note',
    'Only the declared limits above are stored and used by matching. Committed handover volumes and live storage occupancy are not tracked in this version.');
}

function renderDemandProfile(orgProfile, demands) {
  const el = document.getElementById('demand-profile-tags');
  if (!el) return;
  const tags = [];
  if (orgProfile?.serving_capacity) tags.push(`${fbIcon('utensils', 'icon icon-sm')} ~${orgProfile.serving_capacity} meals/day`);
  parseJsonList(orgProfile?.dietary_restrictions).forEach(restriction => {
    tags.push(`${fbIcon('leaf', 'icon icon-sm')} ${String(restriction).replace(/_/g, ' ')}`);
  });
  const recurring = demands.filter(demand => demand.recurring && demand.status !== 'cancelled');
  recurring.slice(0, 4).forEach(item => {
    tags.push(`${fbIcon('recycle', 'icon icon-sm')} ${item.quantity} ${item.unit} · recurring`);
  });
  el.innerHTML = tags.length
    ? tags.map(tag => `<span class="tag">${tag}</span>`).join('')
    : '<span class="tag">No declared profile needs yet</span>';
}

function renderRecurring(list) {
  const el = document.getElementById('recurring-list');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">${fbIcon('recycle')}</span>
        <strong>No recurring requirements</strong>
        <p>Flag a need as recurring when registering it. The current backend stores the pattern for planning but does not post future occurrences automatically.</p>
        <button class="cta" type="button" onclick="showPage('register-demand')">Register a need</button>
      </div>`;
    return;
  }
  el.innerHTML = list.map(item => `
    <article class="recurring-card">
      <div class="recurring-head">
        <div>
          <div class="recurring-title">${fbIcon('recycle', 'icon icon-sm')} ${escapeHtml(item.foodType || 'Recurring food need')}</div>
          <div class="recurring-meta">
            <span>${fbIcon('scale', 'icon icon-sm')} ${escapeHtml(item.quantity)} ${escapeHtml(item.unit)}</span>
            <span>${fbIcon('calendar', 'icon icon-sm')} ${escapeHtml(recurringLabel(item.recurringPattern))}</span>
            <span>${fbIcon('info', 'icon icon-sm')} Stored for planning · automatic reposting not enabled</span>
          </div>
        </div>
        <button class="btn btn-sm" type="button" onclick="showPage('my-demands')">${fbIcon('eye')} View in demands</button>
      </div>
    </article>`).join('');
}

function recurringLabel(pattern) {
  if (!pattern) return 'Recurring need';
  let parsed = pattern;
  if (typeof pattern === 'string') {
    try { parsed = JSON.parse(pattern); } catch (err) { return 'Recurring need'; }
  }
  const frequency = parsed?.frequency || 'daily';
  const time = parsed?.time ? ` at ${parsed.time}` : '';
  return `${frequency}${time}`.replace(/_/g, ' ');
}

function setBarWidth(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = Math.min(Math.max(pct, 0), 100) + '%';
  el.classList.remove('amber', 'red');
  if (pct > 85) el.classList.add('red');
  else if (pct > 65) el.classList.add('amber');
}

window.updateCapacity = async function () {
  const parseCapacity = id => {
    const raw = String(getValue(id) || '').trim();
    if (!raw) return null;
    return Number(raw);
  };
  const receiving = parseCapacity('cap-receive');
  const serving = parseCapacity('cap-serve');
  const storage = parseCapacity('cap-storage');
  const values = [receiving, serving, storage];
  if (values.some(value => value !== null && (!Number.isFinite(value) || value < 0))) {
    showToast('Capacity values must be zero or a positive number.', 'error');
    return;
  }
  if (values.every(value => value === null)) {
    showToast('Enter at least one capacity value before saving.', 'error');
    return;
  }

  const button = document.getElementById('capacity-save-btn');
  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="spinner" style="border-color:rgba(255,255,255,.35);border-top-color:#fff"></span> Saving…';
  }
  try {
    await api.demandOrg.updateCapacity(token, {
      receivingCapacity: receiving,
      servingCapacity: serving,
      storageCapacity: storage
    });
    showToast('Capacity updated.', 'success');
    await loadCapacity();
  } catch (err) {
    showToast(err.message || 'Capacity could not be updated.', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
};

// ── Insights ─────────────────────────────────────────────────
async function loadInsights() {
  let insights;
  try {
    insights = await api.demandOrg.getInsights(token);
  } catch (err) {
    showToast(err.message || 'Insights could not be loaded.', 'error');
    const chart = document.getElementById('demand-chart');
    if (chart) chart.innerHTML = '<div class="error-state">Insights are temporarily unavailable.</div>';
    return;
  }

  setText('ins-fulfillment-rate', `${insights.fulfillmentRate ?? 0}%`);
  setText('ins-total-demands', insights.totalDemands ?? 0);
  setText('ins-unmet', insights.unmetDemands ?? 0);
  setText('ins-people-total', Number(insights.peopleTotalRaw ?? 0).toLocaleString());

  const weekly = (insights.weeklyData || []).map(day => ({
    day: day.day,
    demand: Number(day.demand) || 0,
    fulfilled: Number(day.fulfilled) || 0
  }));
  renderDemandChart(weekly);
  renderFoodBreakdown(insights.foodBreakdown || []);
  renderShortages(insights.shortages || []);
}

function renderShortages(shortages) {
  const el = document.getElementById('shortage-list');
  if (!el) return;
  if (!shortages.length) {
    el.innerHTML = `<div class="empty-state"><span class="empty-icon">${fbIcon('check-circle')}</span><strong>No open shortages</strong><p>Open and partially fulfilled needs will be summarised here.</p></div>`;
    return;
  }
  el.innerHTML = shortages.map(shortage => `
    <div class="demand-item">
      <div class="demand-urgency urgency-regular"></div>
      <div class="demand-info">
        <div class="demand-food">${escapeHtml(shortage.type || 'Food need')}</div>
        <div class="demand-meta">
          <span>${fbIcon('scale', 'icon icon-sm')} ${escapeHtml(shortage.quantity)} unmet</span>
          <span>${fbIcon('inbox', 'icon icon-sm')} ${shortage.count} open requirement${shortage.count === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>`).join('');
}

function renderDemandChart(data) {
  const wrap = document.getElementById('demand-chart');
  if (!wrap) return;
  if (!data.length || data.every(day => day.demand === 0 && day.fulfilled === 0)) {
    wrap.innerHTML = `<div class="empty-state"><span class="empty-icon">${fbIcon('chart')}</span><strong>No demand history yet</strong><p>The last seven days will appear after demands have been registered.</p></div>`;
    return;
  }

  const max = Math.max(...data.map(day => Math.max(day.demand, day.fulfilled)), 1);
  wrap.innerHTML = `
    <div class="demand-bars" role="img" aria-label="Demand versus fulfilled over the last seven days">
      ${data.map(day => {
        const requestedHeight = Math.round((day.demand / max) * 100);
        const receivedHeight = Math.round((day.fulfilled / max) * 100);
        return `
          <div class="demand-bar-column">
            <div class="demand-bar-pair" style="height:calc(100% - 20px)">
              <div class="chart-bar fulfilled" style="height:${receivedHeight}%" aria-label="${day.fulfilled} received on ${day.day}">
                <span class="chart-bar-tooltip">${day.fulfilled} received</span>
              </div>
              <div class="chart-bar unfilled" style="height:${requestedHeight}%" aria-label="${day.demand} requested on ${day.day}">
                <span class="chart-bar-tooltip">${day.demand} requested</span>
              </div>
            </div>
            <div class="chart-x-label">${escapeHtml(day.day)}</div>
          </div>`;
      }).join('')}
    </div>
    <div class="chart-legend">
      <span class="legend-item"><span class="legend-dot" style="background:#16833B"></span>Received</span>
      <span class="legend-item"><span class="legend-dot" style="background:#F1C6C1"></span>Requested</span>
    </div>`;
}

function renderFoodBreakdown(breakdown) {
  const el = document.getElementById('food-breakdown');
  if (!el) return;
  if (!breakdown.length) {
    el.innerHTML = '<span class="tag">No requirement patterns yet</span>';
    return;
  }
  el.innerHTML = breakdown.map(item =>
    `<span class="tag">${item.icon || fbIcon('utensils', 'icon icon-sm')} ${escapeHtml(item.type)}: <strong>${item.count}×</strong> · ${Math.round(item.quantity)} ${escapeHtml(item.unit || 'servings')}</span>`
  ).join('');
}

// ── Alerts ───────────────────────────────────────────────────
async function loadAlerts() {
  const el = document.getElementById('alerts-full-list');
  try {
    const data = await api.demandOrg.getAlerts(token);
    allAlerts = (data.alerts || []).map(mapAlert);
    renderAlertList('alerts-full-list', allAlerts);
    if (currentPage === 'overview') renderAlertList('overview-alerts', allAlerts.slice(0, 3));
    await checkUnreadBadges();
  } catch (err) {
    if (el) {
      el.innerHTML = `<div class="error-state" style="margin:16px">${fbIcon('alert-circle')}<strong>Alerts could not be loaded</strong><span>${escapeHtml(err.message || 'Please try again.')}</span><button class="btn btn-sm" type="button" onclick="loadAlerts()">Retry</button></div>`;
    }
    showToast(err.message || 'Alerts could not be loaded.', 'error');
  }
}

function renderAlertList(containerId, alerts) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!alerts || alerts.length === 0) {
    el.innerHTML = `<div class="empty-state"><span class="empty-icon">${fbIcon('bell')}</span><strong>No alerts right now</strong><p>Offer decisions, handover reminders and capacity notices will appear here.</p></div>`;
    return;
  }
  el.innerHTML = alerts.map(alert => {
    const meta = alertMeta(alert.type);
    return `
      <div class="alert-item ${alert.read ? '' : 'unread'}" id="alert-${escapeAttr(alert.id)}" role="button" tabindex="0"
           onclick="markAlertRead('${escapeAttr(alert.id)}')"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();markAlertRead('${escapeAttr(alert.id)}')}">
        <span class="alert-icon ${meta.tone}">${fbIcon(meta.icon)}</span>
        <div class="alert-body">
          <div class="alert-title">${escapeHtml(cleanAlertText(alert.title || 'Alert'))}</div>
          <div class="alert-message">${escapeHtml(cleanAlertText(alert.message || ''))}</div>
          <div class="alert-time">${alert.createdAt ? timeAgo(alert.createdAt) : 'just now'}</div>
        </div>
        ${alert.read ? '' : '<span class="alert-unread-dot" aria-label="Unread"></span>'}
      </div>`;
  }).join('');
}

function alertMeta(type) {
  const map = {
    supply: { icon: 'truck', tone: 'green' },
    match: { icon: 'target', tone: 'green' },
    warning: { icon: 'alert', tone: 'amber' },
    error: { icon: 'alert-circle', tone: 'red' },
    info: { icon: 'info', tone: 'blue' },
    fulfilled: { icon: 'check-circle', tone: 'green' },
    impact: { icon: 'heart', tone: 'green' }
  };
  return map[type] || { icon: 'bell', tone: 'blue' };
}

window.markAlertRead = async function (id) {
  const alert = allAlerts.find(item => item.id === id);
  if (alert?.read) return;
  try {
    await api.demandOrg.markAlertRead(token, id);
    if (alert) alert.read = true;
    const el = document.getElementById(`alert-${id}`);
    if (el) {
      el.classList.remove('unread');
      el.querySelector('.alert-unread-dot')?.remove();
    }
    await checkUnreadBadges();
  } catch (err) {
    showToast(err.message || 'The alert could not be marked as read.', 'error');
  }
};

window.markAllAlertsRead = async function () {
  try {
    await api.demandOrg.markAllRead(token);
    allAlerts.forEach(alert => { alert.read = true; });
    renderAlertList('alerts-full-list', allAlerts);
    if (currentPage === 'overview') renderAlertList('overview-alerts', allAlerts.slice(0, 3));
    updateBadge('alert-badge', 0);
    const dot = document.getElementById('topbar-alert-dot');
    if (dot) dot.hidden = true;
    showToast('All alerts marked as read.', 'success');
  } catch (err) {
    showToast(err.message || 'Alerts could not be updated.', 'error');
  }
};

// ── Profile ──────────────────────────────────────────────────
async function loadProfile() {
  try {
    const data = await api.demandOrg.getProfile(token);
    const org = data.org || {};
    const orgProfile = data.profile || {};

    setValue('p-org-name', org.name || '');
    setValue('p-org-type', formatOrgType(org.type));
    setValue('p-address', org.location_address || '');
    setValue('p-phone', org.contact_phone || '');
    setValue('p-hours', org.operating_hours || '');
    setValue('p-serve-cap', toInputValue(orgProfile.serving_capacity));
    setValue('p-population', orgProfile.population_served || '');
    setValue('p-food-req', parseJsonList(orgProfile.food_requirements).join(', '));
    setText('profile-account-email', user.email || '—');
    setText('profile-org-type', formatOrgType(org.type));
  } catch (err) {
    showToast(err.message || 'Profile could not be loaded.', 'error');
  }
}

window.saveProfile = async function () {
  const name = getValue('p-org-name').trim();
  if (!name) {
    showMsg('profile-error', 'Organization name is required.');
    document.getElementById('p-org-name').focus();
    return;
  }

  const button = document.getElementById('profile-save-btn');
  const original = button?.innerHTML;
  hideMsg('profile-error');
  hideMsg('profile-success');
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="spinner" style="border-color:rgba(255,255,255,.35);border-top-color:#fff"></span> Saving…';
  }

  const body = {
    name,
    locationAddress: getValue('p-address').trim(),
    contactPhone: getValue('p-phone').trim(),
    operatingHours: getValue('p-hours').trim(),
    servingCapacity: parseInt(getValue('p-serve-cap'), 10) || 0,
    populationServed: getValue('p-population').trim(),
    foodRequirements: getValue('p-food-req')
      ? getValue('p-food-req').split(/[,;]/).map(item => item.trim()).filter(Boolean)
      : []
  };

  try {
    await api.demandOrg.updateProfile(token, body);
    showMsg('profile-success', 'Profile updated. The next matching run will use the saved details.');
    setText('sidebar-org-name', name);
    setText('welcome-name', name);
    setText('user-chip', name);
    setText('account-name', name);
    setText('account-avatar', getInitials(name));
    setText('account-menu-avatar', getInitials(name));
    showToast('Organization profile saved.', 'success');
    if (currentPage === 'capacity') await loadCapacity();
  } catch (err) {
    showMsg('profile-error', err.message || 'Profile could not be saved.');
    showToast(err.message || 'Profile could not be saved.', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
};

// ── Badges ───────────────────────────────────────────────────
async function checkUnreadBadges() {
  try {
    const [alertData, matchData] = await Promise.allSettled([
      api.demandOrg.getAlerts(token),
      api.demandOrg.getMatches(token)
    ]);
    const unreadAlerts = alertData.status === 'fulfilled'
      ? (alertData.value.alerts || []).filter(alert => !alert.is_read).length
      : 0;
    const pendingMatches = matchData.status === 'fulfilled'
      ? (matchData.value.matches || []).filter(match => match.status === 'pending').length
      : 0;

    updateBadge('alert-badge', unreadAlerts);
    updateBadge('match-badge', pendingMatches);
    const dot = document.getElementById('topbar-alert-dot');
    if (dot) dot.hidden = unreadAlerts === 0;
  } catch (err) {
    // Badges are non-critical.
  }
}

function updateBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = count;
  el.hidden = !(count > 0);
}

// ── Utilities ────────────────────────────────────────────────
window.logout = function () {
  localStorage.removeItem('fb_token');
  localStorage.removeItem('fb_user');
  window.location.href = '/demand-org/index.html';
};

function showToast(message, type = 'info') {
  if (typeof window.fbToast === 'function') window.fbToast(message, type);
}

function fbIcon(name, className = 'icon') {
  if (typeof window.fbIcon === 'function') return window.fbIcon(name, className);
  return '';
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function getValue(id) {
  return document.getElementById(id)?.value || '';
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function showMsg(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function hideMsg(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\s+/g, ' ');
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function getInitials(name) {
  return String(name || 'NG')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'NG';
}

function cleanAlertText(value) {
  return String(value || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value) ? null : value;
  let text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(text) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    text = text.replace(' ', 'T') + 'Z';
  }
  const date = new Date(text);
  return isNaN(date.getTime()) ? null : date;
}

function fmtDt(value) {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso) {
  const date = toDate(iso);
  if (!date) return '—';
  const diff = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

// ── Start ────────────────────────────────────────────────────
init();
