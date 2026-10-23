/**
 * FoodBridge — Donor Dashboard JS
 * Sections: Overview, Post Surplus, My Surplus, Impact, Predictions, Profile
 */

import api from './api.js';

// ── Auth guard ───────────────────────────────────────────────────────────────
const token = localStorage.getItem('fb_token');
const user = JSON.parse(localStorage.getItem('fb_user') || 'null');
if (!token || !user || user.role !== 'donor') {
  window.location.href = '/donor/index.html';
  throw new Error('Donor authentication required');
}

// ── State ────────────────────────────────────────────────────────────────────
let currentSection = 'overview';
let allSurplus = [];
let trendChart = null;
let impactDoughnut = null;
let impactBar = null;
let alertsOpen = false;
let allAlerts = [];
let surplusFilter = 'all';
let surplusSearch = '';
let surplusSort = 'newest';

const sectionCopy = {
  overview: ['Overview', 'Surplus food recovery and impact'],
  post: ['Post Surplus', 'Share safe, usable food with the network'],
  'my-surplus': ['My Surplus', 'Track every listing from posting to handover'],
  impact: ['Impact', 'Meals recovered and waste prevented'],
  predictions: ['Predictions', 'Forecasts built from your surplus history'],
  profile: ['Profile', 'Organization details and collection preferences']
};

// ── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const displayName = user.name || user.email || 'Donor';
  const initials = getInitials(displayName);

  setText('user-chip', displayName);
  setText('account-name', displayName);
  setText('account-email', user.email || '—');
  setText('profile-account-email', user.email || '—');
  setText('account-avatar', initials);
  setText('account-menu-avatar', initials);

  try {
    const { org } = await api.donor.getProfile(token);
    if (org) {
      const orgInitials = getInitials(org.name);
      setText('org-avatar', orgInitials);
      setText('sidebar-org-name', org.name);
      setText('welcome-name', org.name || displayName);
      setText('account-avatar', orgInitials);
      setText('account-menu-avatar', orgInitials);

      const status = document.getElementById('sidebar-org-status');
      if (status && org.status !== 'active') {
        status.innerHTML = `<span class="status-dot" style="background:#FFD166"></span><span>${escapeHtml(statusLabel(org.status))}</span>`;
      }
    }
  } catch (err) {
    showToast(err.message || 'Organization profile could not be loaded.', 'error');
  }

  await Promise.all([loadOverview(), loadAlerts()]);
  initLiveNotifications();
});

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
        loadAlerts();
        loadOverview();
      } catch (err) {
        // The stream will reconnect; ignore malformed events.
      }
    });
  } catch (err) {
    // Notifications are additive; the workspace remains usable without SSE.
  }
}

// ── Navigation ───────────────────────────────────────────────────────────────
window.navigate = function (section, el) {
  const target = document.getElementById(`section-${section}`);
  if (!target) return;

  document.querySelectorAll('.section').forEach(sectionEl => sectionEl.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(nav => {
    nav.classList.remove('active');
    nav.removeAttribute('aria-current');
  });

  target.classList.add('active');
  const navEl = el || document.querySelector(`[data-section="${section}"]`);
  if (navEl) {
    navEl.classList.add('active');
    navEl.setAttribute('aria-current', 'page');
  }

  const [sectionTitle, sectionSub] = sectionCopy[section] || [section, ''];
  setText('page-title', sectionTitle);
  setText('topbar-sub', sectionSub);
  currentSection = section;
  closeAlerts();

  if (section === 'overview') loadOverview();
  if (section === 'my-surplus') loadSurplus();
  if (section === 'impact') loadImpact();
  if (section === 'predictions') loadPredictions();
  if (section === 'profile') loadProfile();

  window.closeSidebar?.();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.toggleSidebar = () => {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const open = !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  backdrop?.classList.toggle('show', open);
  document.body.classList.toggle('nav-open', open);
};

// ── Alerts ───────────────────────────────────────────────────────────────────
window.toggleAlerts = () => {
  alertsOpen = !alertsOpen;
  const panel = document.getElementById('alerts-panel');
  const button = document.getElementById('alert-btn');
  panel?.classList.toggle('open', alertsOpen);
  button?.setAttribute('aria-expanded', String(alertsOpen));
  document.querySelector('[data-account-menu]')?.classList.remove('open');
  if (alertsOpen) loadAlerts();
};

function closeAlerts() {
  alertsOpen = false;
  document.getElementById('alerts-panel')?.classList.remove('open');
  document.getElementById('alert-btn')?.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', event => {
  if (!event.target.closest('.alerts-panel') && !event.target.closest('#alert-btn')) closeAlerts();
});

async function loadAlerts() {
  const list = document.getElementById('alerts-list');
  try {
    const { alerts } = await api.donor.getAlerts(token);
    allAlerts = Array.isArray(alerts) ? alerts : [];
    const unread = allAlerts.filter(alert => !alert.is_read);
    const dot = document.getElementById('alert-dot');
    if (dot) dot.hidden = unread.length === 0;

    if (!allAlerts.length) {
      if (list) list.innerHTML = '<div class="alert-empty">No notifications yet. Match updates and collection reminders will appear here.</div>';
      return;
    }

    if (list) {
      list.innerHTML = allAlerts.map(alert => {
        const meta = alertIcon(alert);
        return `
          <div class="alert-item ${alert.is_read ? '' : 'unread'}" role="button" tabindex="0"
               onclick="markAlertRead('${escapeAttr(alert.id)}', this)"
               onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();markAlertRead('${escapeAttr(alert.id)}',this)}">
            <span class="alert-icon ${meta.tone}">${fbIcon(meta.icon)}</span>
            <div class="alert-body">
              <div class="alert-item-title">${escapeHtml(cleanAlertText(alert.title))}</div>
              <div class="alert-item-msg">${escapeHtml(cleanAlertText(alert.message))}</div>
              <div class="alert-item-time">${timeAgo(alert.created_at)}</div>
            </div>
            ${alert.is_read ? '' : '<span class="alert-unread-dot" aria-label="Unread"></span>'}
          </div>`;
      }).join('');
    }
  } catch (err) {
    if (list) list.innerHTML = '<div class="alert-empty">Notifications could not be loaded. Please try again.</div>';
  }
}

window.markAlertRead = async (id, el) => {
  if (el?.classList.contains('unread')) {
    el.classList.remove('unread');
    el.querySelector('.alert-unread-dot')?.remove();
  }
  try {
    await api.donor.markAlertRead(token, id);
    const alert = allAlerts.find(item => item.id === id);
    if (alert) alert.is_read = 1;
    if (!allAlerts.some(item => !item.is_read)) {
      const dot = document.getElementById('alert-dot');
      if (dot) dot.hidden = true;
    }
  } catch (err) {
    showToast(err.message || 'Notification could not be marked as read.', 'error');
    await loadAlerts();
  }
};

window.markAllRead = async () => {
  const unread = allAlerts.filter(alert => !alert.is_read);
  if (!unread.length) {
    showToast('Everything is already read.', 'info');
    return;
  }
  const button = document.querySelector('.alerts-header button');
  if (button) button.disabled = true;
  try {
    await Promise.all(unread.map(alert => api.donor.markAlertRead(token, alert.id)));
    await loadAlerts();
    showToast('All notifications marked as read.', 'success');
  } catch (err) {
    showToast(err.message || 'Some notifications could not be updated.', 'error');
    await loadAlerts();
  } finally {
    if (button) button.disabled = false;
  }
};

window.logout = () => {
  localStorage.removeItem('fb_token');
  localStorage.removeItem('fb_user');
  window.location.href = '/donor/index.html';
};

// ── Overview ─────────────────────────────────────────────────────────────────
async function loadOverview() {
  try {
    const [impactData, surplusData] = await Promise.all([
      api.donor.getImpact(token),
      api.donor.getSurplus(token)
    ]);

    setText('stat-posted', impactData.totalPosts ?? 0);
    setText('stat-recovered', `${impactData.recovered?.quantity ?? 0} kg`);
    setText('stat-matched', impactData.matched ?? 0);
    setText('stat-meals', Number(impactData.mealsEquivalent || 0).toLocaleString());

    const active = (surplusData.posts || []).filter(post => post.status === 'available').length;
    const badge = document.getElementById('active-count');
    if (badge) {
      badge.textContent = active;
      badge.hidden = active === 0;
    }

    const recent = (surplusData.posts || []).slice(0, 5);
    const list = document.getElementById('recent-surplus-list');
    if (list) {
      if (!recent.length) {
        list.innerHTML = `
          <div class="empty-state">
            <span class="empty-icon">${fbIcon('package')}</span>
            <strong>No surplus posted yet</strong>
            <p>Post surplus food and the network will look for a suitable recipient.</p>
            <button class="cta" type="button" onclick="navigate('post', null)">Post your first surplus</button>
          </div>`;
      } else {
        list.innerHTML = recent.map(post => {
          const status = statusMeta(post.status);
          return `
            <button class="item-row interactive" type="button" onclick="openSurplusDetail('${escapeAttr(post.id)}')">
              <span class="item-row-left">
                ${foodIcon(post.food_type)}
                <span>
                  <span class="item-food">${escapeHtml(post.food_name || 'Surplus food')}</span>
                  <span class="item-qty">${escapeHtml(post.quantity)} ${escapeHtml(post.quantity_unit)} · ${timeAgo(post.created_at)}</span>
                </span>
              </span>
              <span class="item-row-right">
                <span class="badge badge-${status.tone}">${status.label}</span>
                ${fbIcon('chevron-right', 'icon icon-sm')}
              </span>
            </button>`;
        }).join('');
      }
    }

    renderTrendChart([...(impactData.monthlyTrend || [])].reverse());
  } catch (err) {
    showToast(err.message || 'Overview could not be loaded.', 'error');
  }
}

function renderTrendChart(trend) {
  const canvas = document.getElementById('trend-chart');
  const empty = document.getElementById('trend-empty');
  if (!canvas) return;
  if (trendChart) {
    trendChart.destroy();
    trendChart = null;
  }

  const hasPosts = trend.some(item => Number(item.posts) > 0);
  if (!hasPosts) {
    canvas.style.display = 'none';
    if (empty) empty.hidden = false;
    return;
  }
  canvas.style.display = 'block';
  if (empty) empty.hidden = true;

  const ctx = canvas.getContext('2d');
  trendChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: trend.map(item => formatMonth(item.month)),
      datasets: [
        {
          type: 'bar',
          label: 'Posts created',
          data: trend.map(item => Number(item.posts) || 0),
          backgroundColor: 'rgba(22, 131, 59, 0.16)',
          borderColor: '#16833B',
          borderWidth: 1,
          borderRadius: 5,
          maxBarThickness: 30,
          yAxisID: 'y'
        },
        {
          type: 'line',
          label: 'Quantity posted (kg equivalent)',
          data: trend.map(item => Number(item.quantity) || 0),
          borderColor: '#2563EB',
          backgroundColor: 'rgba(37, 99, 235, 0.08)',
          borderWidth: 2,
          pointBackgroundColor: '#2563EB',
          pointRadius: 3,
          pointHoverRadius: 4,
          tension: 0.32,
          fill: true,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#173D27',
          padding: 9,
          cornerRadius: 7,
          callbacks: {
            label: context => `${context.dataset.label}: ${context.parsed.y}`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#7A857D', font: { size: 10, family: 'Inter' } },
          border: { display: false }
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#7A857D', font: { size: 10, family: 'Inter' }, precision: 0 },
          grid: { color: 'rgba(24, 33, 28, 0.06)' },
          border: { display: false },
          title: { display: true, text: 'Posts', color: '#7A857D', font: { size: 10 } }
        },
        y1: {
          beginAtZero: true,
          position: 'right',
          ticks: { color: '#7A857D', font: { size: 10, family: 'Inter' } },
          grid: { drawOnChartArea: false },
          border: { display: false },
          title: { display: true, text: 'kg equivalent', color: '#7A857D', font: { size: 10 } }
        }
      }
    }
  });
}

// ── Post Surplus ──────────────────────────────────────────────────────────────
const nowLocal = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
};
const inHours = hours => {
  const date = new Date();
  date.setHours(date.getHours() + hours);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
};

document.getElementById('p-avail-time').value = nowLocal();
document.getElementById('p-usable-time').value = inHours(4);

window.toggleTag = button => {
  button.classList.toggle('selected');
};

window.postSurplus = async () => {
  const foodName = document.getElementById('p-food-name').value.trim();
  const foodType = document.getElementById('p-food-type').value;
  const quantity = parseFloat(document.getElementById('p-quantity').value);
  const quantityUnit = document.getElementById('p-unit').value;
  const prepState = document.getElementById('p-prep-state').value;
  const availTime = document.getElementById('p-avail-time').value;
  const usableTime = document.getElementById('p-usable-time').value;
  const pickup = document.getElementById('p-pickup').value.trim();
  const instructions = document.getElementById('p-instructions').value.trim();
  const pickupStart = document.getElementById('p-pickup-start').value;
  const pickupEnd = document.getElementById('p-pickup-end').value;
  const tempZone = document.getElementById('p-temp-zone').value;
  const storage = document.getElementById('p-storage').value.trim();
  const handling = document.getElementById('p-handling').value.trim();
  const hygiene = document.getElementById('p-hygiene').checked;
  const dietaryTags = [...document.querySelectorAll('#dietary-tags .tag-btn.selected')].map(button => button.dataset.val);

  const errEl = document.getElementById('post-error');
  const succEl = document.getElementById('post-success');
  errEl.style.display = 'none';
  succEl.style.display = 'none';

  const fail = message => {
    errEl.textContent = message;
    errEl.style.display = 'block';
    errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  if (!foodName) return fail('Food name is required.');
  if (!quantity || quantity <= 0) return fail('Please enter a valid quantity.');
  if (!availTime || !usableTime) return fail('Please set both availability and safe-until times.');
  if (new Date(usableTime) <= new Date()) return fail('Safe-until time must be in the future.');
  if (pickupStart && pickupEnd && new Date(pickupEnd) <= new Date(pickupStart)) {
    return fail('The pickup window must close after it opens.');
  }
  if (!hygiene) return fail('Please confirm the food safety and hygiene attestation before posting.');

  const button = document.getElementById('post-btn');
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Posting…';

  try {
    await api.donor.postSurplus(token, {
      foodName,
      foodType,
      quantity,
      quantityUnit,
      preparationState: prepState,
      dietaryTags,
      availabilityTime: new Date(availTime).toISOString(),
      remainingUsableTime: new Date(usableTime).toISOString(),
      pickupAddress: pickup,
      specialInstructions: instructions,
      pickupWindowStart: pickupStart ? new Date(pickupStart).toISOString() : null,
      pickupWindowEnd: pickupEnd ? new Date(pickupEnd).toISOString() : null,
      temperatureZone: tempZone,
      storageRequirements: storage,
      handlingNotes: handling,
      hygieneConfirmed: true
    });

    succEl.textContent = 'Surplus posted. The network is now checking recipients for a safe, feasible match.';
    succEl.style.display = 'block';

    document.getElementById('p-food-name').value = '';
    document.getElementById('p-quantity').value = '';
    document.getElementById('p-instructions').value = '';
    document.getElementById('p-pickup').value = '';
    document.getElementById('p-pickup-start').value = '';
    document.getElementById('p-pickup-end').value = '';
    document.getElementById('p-storage').value = '';
    document.getElementById('p-handling').value = '';
    document.getElementById('p-hygiene').checked = false;
    document.querySelectorAll('#dietary-tags .tag-btn').forEach(tag => tag.classList.remove('selected'));
    document.getElementById('p-avail-time').value = nowLocal();
    document.getElementById('p-usable-time').value = inHours(4);

    showToast('Surplus posted successfully.', 'success');
    await loadOverview();
  } catch (err) {
    fail(err.message || 'The surplus could not be posted.');
    showToast(err.message || 'The surplus could not be posted.', 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = `${fbIcon('upload')} Post surplus`;
  }
};

// ── My Surplus ───────────────────────────────────────────────────────────────
async function loadSurplus() {
  const el = document.getElementById('surplus-list');
  if (el) {
    el.innerHTML = '<div class="empty-state"><p>Loading your surplus posts…</p></div>';
  }
  try {
    const { posts } = await api.donor.getSurplus(token);
    allSurplus = Array.isArray(posts) ? posts : [];
    renderSurplus(surplusFilter);
  } catch (err) {
    if (el) {
      el.innerHTML = `<div class="error-state">${fbIcon('alert-circle')}<strong>Surplus posts could not be loaded</strong><span>${escapeHtml(err.message || 'Please try again.')}</span><button class="btn btn-sm" type="button" onclick="loadSurplus()">Retry</button></div>`;
    }
  }
}

window.filterSurplus = (filter, button) => {
  surplusFilter = filter;
  document.querySelectorAll('#section-my-surplus .filter-btn').forEach(btn => btn.classList.remove('active'));
  (button || document.querySelector(`#section-my-surplus .filter-btn[data-filter="${filter}"]`))?.classList.add('active');
  renderSurplus(filter);
};

window.setSurplusSearch = value => {
  surplusSearch = String(value || '').trim().toLowerCase();
  renderSurplus(surplusFilter);
};

window.setSurplusSort = value => {
  surplusSort = value || 'newest';
  renderSurplus(surplusFilter);
};

window.resetSurplusFilters = () => {
  surplusFilter = 'all';
  surplusSearch = '';
  surplusSort = 'newest';
  const search = document.getElementById('surplus-search');
  const sort = document.getElementById('surplus-sort');
  if (search) search.value = '';
  if (sort) sort.value = 'newest';
  document.querySelectorAll('#section-my-surplus .filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === 'all');
  });
  renderSurplus('all');
};

function filteredSurplus(filter) {
  let list = filter === 'all' ? allSurplus.slice() : allSurplus.filter(post => post.status === filter);

  if (surplusSearch) {
    list = list.filter(post => {
      const haystack = [
        post.food_name,
        post.food_type,
        post.status,
        post.matched_org_name,
        post.pickup_address,
        post.special_instructions
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(surplusSearch);
    });
  }

  list.sort((a, b) => {
    if (surplusSort === 'oldest') return new Date(a.created_at) - new Date(b.created_at);
    if (surplusSort === 'quantity') return (Number(b.quantity) || 0) - (Number(a.quantity) || 0);
    if (surplusSort === 'expiry') return new Date(a.remaining_usable_time || 0) - new Date(b.remaining_usable_time || 0);
    return new Date(b.created_at) - new Date(a.created_at);
  });

  return list;
}

function renderSurplus(filter) {
  const list = filteredSurplus(filter);
  const el = document.getElementById('surplus-list');
  if (!el) return;

  if (!list.length) {
    const hasFilters = surplusFilter !== 'all' || Boolean(surplusSearch);
    el.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <span class="empty-icon">${fbIcon('package')}</span>
        <strong>No surplus posts match this view</strong>
        <p>${hasFilters ? `No listing matches the current filter${surplusSearch ? ` and search “${escapeHtml(surplusSearch)}”` : ''}.` : 'Post surplus food and it will appear here with its live match status.'}</p>
        ${hasFilters
          ? '<button class="cta" type="button" onclick="resetSurplusFilters()">Reset filters</button>'
          : '<button class="cta" type="button" onclick="navigate(\'post\', null)">Post surplus</button>'}
      </div>`;
    return;
  }

  el.innerHTML = list.map(post => {
    const status = statusMeta(post.status);
    return `
      <article class="surplus-card">
        <div class="surplus-card-header">
          <div class="surplus-card-title-wrap">
            <div class="surplus-food-name">${foodIcon(post.food_type)} ${escapeHtml(post.food_name || 'Surplus food')}</div>
            <div class="surplus-meta">
              <span>${fbIcon('scale', 'icon icon-sm')} ${escapeHtml(post.quantity)} ${escapeHtml(post.quantity_unit)}</span>
              <span>${fbIcon('calendar', 'icon icon-sm')} ${fmtDt(post.availability_time)}</span>
            </div>
          </div>
          <span class="badge badge-${status.tone}">${status.label}</span>
        </div>
        <div class="surplus-meta">
          <span>${fbIcon('clock', 'icon icon-sm')} Safe until ${fmtDt(post.remaining_usable_time)}</span>
          ${!['completed', 'cancelled', 'canceled', 'expired'].includes(post.status)
            ? `<span>${fbIcon('clock-fast', 'icon icon-sm')} ${post.timeLeft === 'Expired' || (toDate(post.remaining_usable_time)?.getTime() || Infinity) <= Date.now() ? 'Safe-until window passed' : `${escapeHtml(post.timeLeft || 'Open')} left`}</span>`
            : ''}
          <span>${fbIcon('shield', 'icon icon-sm')} ${temperatureLabel(post.temperature_zone)}${post.hygiene_confirmed ? ' · Safety attested' : ' · Safety not attested'}</span>
          ${post.matched_org_name ? `<span>${fbIcon('truck', 'icon icon-sm')} ${escapeHtml(post.matched_org_name)}${post.match_route === 'reserve' ? ' (reserve)' : ''}</span>` : ''}
        </div>
        <div class="surplus-actions">
          <button class="btn btn-sm" type="button" onclick="openSurplusDetail('${escapeAttr(post.id)}')">${fbIcon('eye')} View details</button>
          ${post.status === 'available'
            ? `<button class="btn btn-sm btn-danger" type="button" onclick="cancelSurplus('${escapeAttr(post.id)}', this)">${fbIcon('trash')} Cancel post</button>`
            : ''}
          ${post.status === 'matched' || post.status === 'in_transit'
            ? `<span class="form-help" style="margin:0 0 0 auto">A recipient has this offer. Changes are handled through the collection workflow.</span>`
            : ''}
        </div>
      </article>`;
  }).join('');
}

// ── Surplus detail ───────────────────────────────────────────────────────────
let detailLastFocus = null;

window.openSurplusDetail = async id => {
  const modal = document.getElementById('surplusDetailModal');
  const title = document.getElementById('surplusDetailTitle');
  const body = document.getElementById('surplusDetailBody');
  if (!modal || !body) return;

  detailLastFocus = document.activeElement;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  body.innerHTML = '<div class="empty-state"><p>Loading post details…</p></div>';
  if (title) title.textContent = 'Surplus post';
  modal.querySelector('.fb-modal-close')?.focus();

  try {
    const { post, decisions } = await api.donor.getSurplusDetail(token, id);
    if (title) title.textContent = post.food_name || 'Surplus post';
    const status = statusMeta(post.status);
    body.innerHTML = `
      <div class="fb-detail-grid">
        <div class="fb-detail-item"><small>Status</small><strong><span class="badge badge-${status.tone}">${status.label}</span></strong></div>
        <div class="fb-detail-item"><small>Quantity</small><strong>${escapeHtml(post.quantity)} ${escapeHtml(post.quantity_unit)}</strong></div>
        <div class="fb-detail-item"><small>Food category</small><span>${escapeHtml(String(post.food_type || 'Not specified').replace(/_/g, ' '))}</span></div>
        <div class="fb-detail-item"><small>Preparation</small><span>${escapeHtml(String(post.preparation_state || 'Not specified').replace(/_/g, ' '))}</span></div>
        <div class="fb-detail-item"><small>Available from</small><span>${fmtDt(post.availability_time)}</span></div>
        <div class="fb-detail-item"><small>Safe until</small><span>${fmtDt(post.remaining_usable_time)}</span></div>
        <div class="fb-detail-item"><small>Pickup window</small><span>${fmtDt(post.pickup_window_start)} – ${fmtDt(post.pickup_window_end)}</span></div>
        <div class="fb-detail-item"><small>Temperature zone</small><span>${temperatureLabel(post.temperature_zone)}</span></div>
        <div class="fb-detail-item full"><small>Pickup address</small><span>${escapeHtml(post.pickup_address || 'Registered organization address')}</span></div>
        <div class="fb-detail-item full"><small>Collection instructions</small><span>${escapeHtml(post.special_instructions || 'None recorded')}</span></div>
        <div class="fb-detail-item"><small>Storage requirements</small><span>${escapeHtml(post.storage_requirements || 'None recorded')}</span></div>
        <div class="fb-detail-item"><small>Handling notes</small><span>${escapeHtml(post.handling_notes || 'None recorded')}</span></div>
        ${post.matched_org_name ? `<div class="fb-detail-item full"><small>Matched partner</small><strong>${escapeHtml(post.matched_org_name)}</strong><span>${escapeHtml(post.matched_org_address || '')}</span></div>` : ''}
        <div class="fb-detail-item"><small>Safety attestation</small><span>${post.hygiene_confirmed ? 'Confirmed by donor' : 'Not recorded'}</span></div>
        <div class="fb-detail-item"><small>Created</small><span>${fmtDt(post.created_at)}</span></div>
      </div>
      ${post.status === 'completed' ? '<div class="fb-detail-note">This handover is complete and is included in your impact totals.</div>' : ''}
      ${post.status === 'matched' || post.status === 'in_transit' ? '<div class="fb-detail-note">This listing is matched but not yet complete. It is not counted as rescued food until the recipient confirms the handover.</div>' : ''}
      ${post.status === 'expired' ? '<div class="fb-detail-note" style="border-color:#F3C8C4;background:var(--fb-error-soft);color:#B42D24">This offer expired before a completed handover. It does not count as recovered food.</div>' : ''}
      ${decisions && decisions.length ? `<div class="fb-detail-note"><strong>Allocation trail:</strong> ${decisions.map(decision => `${escapeHtml(decision.tier)} — ${escapeHtml(decision.reason || `score ${Math.round(decision.score || 0)}`)}`).join(' · ')}</div>` : ''}
    `;
  } catch (err) {
    body.innerHTML = `<div class="error-state">${fbIcon('alert-circle')}<strong>This post could not be loaded</strong><span>${escapeHtml(err.message || 'Please try again.')}</span></div>`;
  }
};

window.closeSurplusDetail = () => {
  const modal = document.getElementById('surplusDetailModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  if (detailLastFocus && typeof detailLastFocus.focus === 'function') detailLastFocus.focus();
  detailLastFocus = null;
};

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeSurplusDetail();
});

window.cancelSurplus = async (id, button) => {
  const post = allSurplus.find(item => item.id === id);
  const confirmed = await window.fbConfirm({
    title: 'Cancel this surplus post?',
    message: 'The listing will be withdrawn from matching. This cannot be undone, and any recipient looking at it will no longer be able to accept it.',
    confirmLabel: 'Cancel post',
    cancelLabel: 'Keep listing',
    tone: 'danger',
    details: post ? `<strong>${escapeHtml(post.food_name)}</strong><br>${escapeHtml(post.quantity)} ${escapeHtml(post.quantity_unit)}` : ''
  });
  if (!confirmed) return;

  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spinner" style="border-color:rgba(216,58,46,.25);border-top-color:#D83A2E"></span> Cancelling…';
  try {
    await api.donor.cancelSurplus(token, id);
    showToast('Surplus post cancelled.', 'success');
    await Promise.all([loadSurplus(), loadOverview()]);
  } catch (err) {
    showToast(err.message || 'The post could not be cancelled.', 'error');
    button.disabled = false;
    button.innerHTML = original;
  }
};

// ── Impact ────────────────────────────────────────────────────────────────────
async function loadImpact() {
  try {
    const data = await api.donor.getImpact(token);

    setText('impact-meals', Number(data.mealsEquivalent || 0).toLocaleString());
    setText('impact-kg', `${data.recovered?.quantity ?? 0} kg`);
    setText('impact-waste', `${data.wasted?.quantity ?? 0} kg`);
    setText('impact-completed', data.recovered?.count ?? 0);

    const totalPosts = Number(data.totalPosts || 0);
    const recovered = Number(data.recovered?.count || 0);
    const expired = Number(data.wasted?.count || 0);
    const pending = Math.max(0, totalPosts - recovered - expired);

    const doughnutCanvas = document.getElementById('impact-doughnut');
    const doughnutEmpty = document.getElementById('impact-doughnut-empty');
    if (impactDoughnut) {
      impactDoughnut.destroy();
      impactDoughnut = null;
    }
    if (!totalPosts) {
      if (doughnutCanvas) doughnutCanvas.style.display = 'none';
      if (doughnutEmpty) doughnutEmpty.hidden = false;
      setText('impact-legend', '');
    } else {
      if (doughnutCanvas) doughnutCanvas.style.display = 'block';
      if (doughnutEmpty) doughnutEmpty.hidden = true;
      impactDoughnut = new Chart(doughnutCanvas.getContext('2d'), {
        type: 'doughnut',
        data: {
          labels: ['Recovered', 'Expired unused', 'Open / other'],
          datasets: [{
            data: [recovered, expired, pending],
            backgroundColor: ['#16833B', '#D83A2E', '#2563EB'],
            hoverBackgroundColor: ['#0B5B2E', '#B42D24', '#1D4FBE'],
            borderWidth: 0,
            spacing: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '68%',
          plugins: {
            legend: { display: false },
            tooltip: { backgroundColor: '#173D27', padding: 9, cornerRadius: 7 }
          }
        }
      });

      const legend = document.getElementById('impact-legend');
      if (legend) {
        legend.innerHTML = [
          ['#16833B', 'Recovered', recovered],
          ['#D83A2E', 'Expired unused', expired],
          ['#2563EB', 'Open / other', pending]
        ].map(([color, label, count]) => `
          <span class="legend-item">
            <span class="legend-dot" style="background:${color}"></span>
            ${label} <strong>${count}</strong>
          </span>`).join('');
      }
    }

    const trend = [...(data.monthlyTrend || [])].reverse();
    const barCanvas = document.getElementById('impact-bar');
    const barEmpty = document.getElementById('impact-bar-empty');
    const hasVolume = trend.some(item => Number(item.quantity) > 0 || Number(item.recoveredQuantity) > 0);

    if (impactBar) {
      impactBar.destroy();
      impactBar = null;
    }
    if (!hasVolume) {
      if (barCanvas) barCanvas.style.display = 'none';
      if (barEmpty) barEmpty.hidden = false;
    } else {
      if (barCanvas) barCanvas.style.display = 'block';
      if (barEmpty) barEmpty.hidden = true;
      impactBar = new Chart(barCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: trend.map(item => formatMonth(item.month)),
          datasets: [
            {
              label: 'Posted (kg equivalent)',
              data: trend.map(item => Number(item.quantity) || 0),
              backgroundColor: 'rgba(22, 131, 59, 0.22)',
              borderColor: '#16833B',
              borderWidth: 1,
              borderRadius: 5,
              maxBarThickness: 24
            },
            {
              label: 'Recovered (kg equivalent)',
              data: trend.map(item => Number(item.recoveredQuantity) || 0),
              backgroundColor: '#83E0A0',
              borderColor: '#16833B',
              borderWidth: 1,
              borderRadius: 5,
              maxBarThickness: 24
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: true,
              position: 'bottom',
              labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, color: '#5D685F', font: { size: 10 } }
            },
            tooltip: { backgroundColor: '#173D27', padding: 9, cornerRadius: 7 }
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#7A857D', font: { size: 10 } }, border: { display: false } },
            y: { beginAtZero: true, grid: { color: 'rgba(24, 33, 28, 0.06)' }, ticks: { color: '#7A857D', font: { size: 10 } }, border: { display: false } }
          }
        }
      });
    }
  } catch (err) {
    showToast(err.message || 'Impact data could not be loaded.', 'error');
  }
}

// ── Predictions ───────────────────────────────────────────────────────────────
async function loadPredictions() {
  const el = document.getElementById('prediction-content');
  try {
    const { prediction, patterns, riskDays, prevention, accuracy, history, todayRecord } =
      await api.donor.getPredictions(token);

    if (!prediction || (!patterns.length && !accuracy?.samples)) {
      el.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">${fbIcon('sparkles')}</span>
          <strong>Forecasts need more history</strong>
          <p>Post at least two surplus records to generate a prediction. Accuracy appears after your first full forecast day closes.</p>
          <button class="cta" type="button" onclick="navigate('post', null)">Post surplus</button>
        </div>`;
      return;
    }

    const accuracyText = accuracy?.mape != null ? `±${accuracy.mape}%` : 'Not yet measured';
    const accuracySub = accuracy?.samples
      ? `${accuracy.samples} back-tested day${accuracy.samples === 1 ? '' : 's'} · MAE ${accuracy.mae} kg`
      : 'Accuracy is measured after each forecast day closes';
    const historyRows = (history || []).filter(item => item.status === 'resolved').slice(0, 6);
    const confidence = Math.round((prediction.confidence || 0) * 100);

    el.innerHTML = `
      <div class="prediction-grid">
        <div class="prediction-card">
          <div class="prediction-icon">${fbIcon('package', 'icon icon-lg')}</div>
          <div class="prediction-title">Expected next surplus</div>
          <div class="prediction-value">${prediction.expectedQty ?? '—'} <span class="unit">kg</span></div>
          <div class="prediction-sub">${escapeHtml(prediction.foodType || 'Based on your history')} · ${escapeHtml(formatPredictionDate(prediction.targetDate))}</div>
          <div class="confidence-bar" aria-label="Prediction confidence ${confidence}%"><div class="confidence-fill" style="width:${confidence}%"></div></div>
          <div class="prediction-sub" style="margin-top:5px">Confidence: ${confidence}% · ${prediction.samples || 0} day${Number(prediction.samples) === 1 ? '' : 's'} of data</div>
        </div>
        <div class="prediction-card">
          <div class="prediction-icon" style="background:var(--fb-success-soft);color:var(--fb-success)">${fbIcon('target', 'icon icon-lg')}</div>
          <div class="prediction-title">Forecast accuracy</div>
          <div class="prediction-value small">${accuracyText}</div>
          <div class="prediction-sub">${accuracySub}</div>
          ${todayRecord ? `<div class="prediction-sub" style="margin-top:8px">Today predicted: <strong>${todayRecord.predicted_quantity} kg</strong> · ${todayRecord.status === 'resolved' ? `actual ${todayRecord.actual_quantity} kg` : 'measuring…'}</div>` : ''}
        </div>
        <div class="prediction-card">
          <div class="prediction-icon" style="background:var(--fb-warning-soft);color:var(--fb-warning)">${fbIcon('calendar', 'icon icon-lg')}</div>
          <div class="prediction-title">High surplus days</div>
          <div class="risk-list" style="margin-top:8px">
            ${riskDays.length ? riskDays.slice(0, 5).map(day => `
              <div class="history-row">
                <span class="day">${escapeHtml(day.day)}</span>
                <span class="count">${day.count} historical post${day.count === 1 ? '' : 's'}</span>
              </div>`).join('') : '<div class="prediction-sub">No peak day detected yet.</div>'}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-header">
          <div class="card-heading">
            <h2 class="card-title">Waste prevention playbook</h2>
            <p class="card-sub">Practical steps based on your recorded surplus pattern</p>
          </div>
        </div>
        <div class="stack-sm">
          ${(prevention || []).map(tip => `
            <div class="prevention-tip">
              <span class="tip-icon">${fbIcon('lightbulb')}</span>
              <div>
                <div class="tip-title">${escapeHtml(tip.title)}</div>
                <div class="tip-detail">${escapeHtml(tip.detail)}</div>
              </div>
            </div>`).join('') || '<div class="prediction-sub">No prevention actions right now.</div>'}
        </div>
      </div>

      <div class="prediction-grid" style="margin-top:16px">
        <div class="prediction-card">
          <div class="prediction-icon" style="background:var(--fb-blue-soft);color:var(--fb-blue)">${fbIcon('chart', 'icon icon-lg')}</div>
          <div class="prediction-title">Your top surplus types</div>
          <div class="stack-sm" style="margin-top:9px">
            ${patterns.slice(0, 3).map(pattern => `
              <div class="history-row">
                <span class="day">${foodIcon(pattern.food_type, true)} ${escapeHtml(String(pattern.food_type || 'other').replace(/_/g, ' '))}</span>
                <span class="count">~${Math.round(pattern.avg_qty || 0)} kg avg · ${pattern.frequency}×</span>
              </div>`).join('') || '<div class="prediction-sub">No pattern yet.</div>'}
          </div>
        </div>
        <div class="prediction-card" style="grid-column:span 2">
          <div class="prediction-icon">${fbIcon('activity', 'icon icon-lg')}</div>
          <div class="prediction-title">Predicted vs actual (walk-forward test)</div>
          <div class="stack-sm" style="margin-top:9px">
            ${historyRows.length ? historyRows.map(item => {
              const errorTone = (item.error_pct ?? 0) <= 20 ? 'color:var(--fb-success)' : 'color:var(--fb-error)';
              return `
                <div class="history-row">
                  <span class="day">${escapeHtml(item.predicted_for_date)}</span>
                  <span class="count">Predicted ${item.predicted_quantity} kg · actual ${item.actual_quantity ?? '—'} kg · <strong style="${errorTone}">${item.error_pct != null ? item.error_pct + '% error' : '—'}</strong></span>
                </div>`;
            }).join('') : '<div class="prediction-sub">Accuracy appears after your first full day of posts. Every forecast is stored and compared with what actually happened — no retro-fitting.</div>'}
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="error-state">${fbIcon('alert-circle')}<strong>Predictions could not be loaded</strong><span>${escapeHtml(err.message || 'Please try again.')}</span><button class="btn btn-sm" type="button" onclick="navigate('predictions', null)">Retry</button></div>`;
  }
}

// ── Profile ───────────────────────────────────────────────────────────────────
async function loadProfile() {
  try {
    const { org, profile } = await api.donor.getProfile(token);

    document.getElementById('pr-name').value = org?.name || '';
    document.getElementById('pr-address').value = org?.location_address || '';
    document.getElementById('pr-phone').value = org?.contact_phone || '';
    document.getElementById('pr-hours').value = org?.operating_hours || '';
    document.getElementById('pr-desc').value = org?.description || '';

    let cats = [];
    try {
      cats = JSON.parse(profile?.food_categories || '[]');
    } catch (err) {
      cats = [];
    }
    document.querySelectorAll('#profile-food-cats .tag-btn').forEach(button => {
      button.classList.toggle('selected', cats.includes(button.dataset.val));
    });

    const statusMap = {
      pending: 'Pending verification — the FoodBridge team will review your organization soon.',
      active: 'Verified and active. You can post surplus and receive match offers.',
      rejected: 'Verification was rejected. Please contact FoodBridge support before posting again.',
      suspended: 'This organization is suspended. Posting and matching are unavailable until support restores access.'
    };
    const box = document.getElementById('verify-status-box');
    if (box) {
      box.className = `verify-status-box ${org?.status || 'pending'}`;
      box.textContent = statusMap[org?.status] || 'Verification status is not available.';
    }
    setText('profile-account-email', user.email || '—');
  } catch (err) {
    showToast(err.message || 'Profile could not be loaded.', 'error');
  }
}

window.toggleProfileTag = button => {
  button.classList.toggle('selected');
};

window.saveProfile = async () => {
  const button = document.getElementById('profile-save-btn');
  const errorEl = document.getElementById('profile-error');
  const successEl = document.getElementById('profile-success');
  errorEl.style.display = 'none';
  successEl.style.display = 'none';

  const name = document.getElementById('pr-name').value.trim();
  if (!name) {
    errorEl.textContent = 'Organization name is required.';
    errorEl.style.display = 'block';
    document.getElementById('pr-name').focus();
    return;
  }

  button.disabled = true;
  button.innerHTML = '<span class="spinner" style="border-color:rgba(255,255,255,.35);border-top-color:#fff"></span> Saving…';

  const foodCategories = [...document.querySelectorAll('#profile-food-cats .tag-btn.selected')].map(tag => tag.dataset.val);

  try {
    await api.donor.updateProfile(token, {
      name,
      locationAddress: document.getElementById('pr-address').value.trim(),
      contactPhone: document.getElementById('pr-phone').value.trim(),
      operatingHours: document.getElementById('pr-hours').value.trim(),
      description: document.getElementById('pr-desc').value.trim(),
      foodCategories
    });
    successEl.textContent = 'Profile updated. Matching and pickup details now use the saved information.';
    successEl.style.display = 'block';
    setText('sidebar-org-name', name);
    setText('welcome-name', name);
    setText('org-avatar', getInitials(name));
    showToast('Organization profile saved.', 'success');
  } catch (err) {
    errorEl.textContent = err.message || 'Profile could not be saved.';
    errorEl.style.display = 'block';
    showToast(err.message || 'Profile could not be saved.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Save profile';
  }
};

// ── Utilities ─────────────────────────────────────────────────────────────────
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function showToast(message, type = 'info') {
  if (typeof window.fbToast === 'function') window.fbToast(message, type);
}

function fbIcon(name, className = 'icon') {
  if (typeof window.fbIcon === 'function') return window.fbIcon(name, className);
  return '';
}

function getInitials(name) {
  return String(name || 'D')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'D';
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

function statusMeta(status) {
  const map = {
    available: { label: 'Available', tone: 'available' },
    matched: { label: 'Matched', tone: 'info' },
    in_transit: { label: 'In transit', tone: 'info' },
    completed: { label: 'Completed', tone: 'success' },
    expired: { label: 'Expired', tone: 'danger' },
    cancelled: { label: 'Cancelled', tone: 'danger' },
    canceled: { label: 'Cancelled', tone: 'danger' }
  };
  return map[status] || { label: String(status || 'Unknown').replace(/_/g, ' '), tone: 'neutral' };
}

function statusLabel(status) {
  const labels = {
    pending: 'Pending verification',
    active: 'Verified and active',
    rejected: 'Verification rejected',
    suspended: 'Account suspended'
  };
  return labels[status] || String(status || 'Unknown');
}

function foodIcon(type, inline = false) {
  const map = {
    cooked_meal: { icon: 'utensils', tone: 'orange' },
    cooked_meals: { icon: 'utensils', tone: 'orange' },
    bakery: { icon: 'package', tone: 'amber' },
    bread_bakery: { icon: 'package', tone: 'amber' },
    produce: { icon: 'leaf', tone: 'green' },
    fruits_vegetables: { icon: 'leaf', tone: 'green' },
    raw_ingredients: { icon: 'leaf', tone: 'green' },
    dairy: { icon: 'package', tone: 'blue' },
    packaged: { icon: 'box', tone: 'purple' },
    packaged_food: { icon: 'box', tone: 'purple' },
    beverages: { icon: 'package', tone: 'blue' },
    other: { icon: 'utensils', tone: '' }
  };
  const meta = map[type] || map.other;
  if (inline) return fbIcon(meta.icon, 'icon icon-sm');
  return `<span class="food-avatar ${meta.tone}">${fbIcon(meta.icon)}</span>`;
}

function cleanAlertText(value) {
  return String(value || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function temperatureLabel(zone) {
  const labels = { chilled: 'Chilled', frozen: 'Frozen', ambient: 'Ambient' };
  return labels[zone] || 'Ambient';
}

function alertIcon(alert) {
  const type = String(alert?.type || '').toLowerCase();
  if (type.includes('match') || type.includes('offer')) return { icon: 'target', tone: 'blue' };
  if (type.includes('complete') || type.includes('deliver')) return { icon: 'check-circle', tone: 'green' };
  if (type.includes('expire') || type.includes('waste') || type.includes('risk')) return { icon: 'clock', tone: 'amber' };
  if (type.includes('cancel') || type.includes('reject')) return { icon: 'alert-circle', tone: 'red' };
  return { icon: 'bell', tone: 'blue' };
}

function formatPredictionDate(value) {
  const date = toDate(value);
  if (!date) return value || 'tomorrow';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatMonth(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4})-(\d{2})$/);
  if (!match) return text;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return date.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
}

function fmtDt(iso) {
  const date = toDate(iso);
  if (!date) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
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

function timeAgo(iso) {
  const date = toDate(iso);
  if (!date) return '—';
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
