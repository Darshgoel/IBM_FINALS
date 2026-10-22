/**
 * FoodBridge — Donor Dashboard JS
 * Handles all sections: Overview, Post Surplus, My Surplus, Impact, Predictions, Profile
 */

import api from './api.js';

// ── Auth guard ───────────────────────────────────────────────────────────────
const token = localStorage.getItem('fb_token');
const user  = JSON.parse(localStorage.getItem('fb_user') || 'null');
if (!token || !user || user.role !== 'donor') {
  window.location.href = '/donor/index.html';
}

// ── State ────────────────────────────────────────────────────────────────────
let currentSection = 'overview';
let allSurplus = [];
let trendChart = null;
let impactDoughnut = null;
let impactBar = null;

// ── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Set user chip
  document.getElementById('user-chip').textContent = user.name || user.email;

  // Load profile
  try {
    const { org } = await api.donor.getProfile(token);
    if (org) {
      const initials = org.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
      document.getElementById('org-avatar').textContent = initials;
      document.getElementById('sidebar-org-name').textContent = org.name;
      document.getElementById('welcome-name').textContent = user.name || org.name;
      if (org.status !== 'active') {
        document.getElementById('sidebar-org-status').innerHTML =
          `<span class="status-dot" style="background:var(--primary)"></span><span>Pending Verification</span>`;
      }
    }
  } catch {}

  await loadOverview();
  loadAlerts();
  initLiveNotifications();
});

function initLiveNotifications() {
  if (!token) return;
  if ('Notification' in window && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (e) {}
  }
  try {
    const evtSource = new EventSource(`http://localhost:3000/api/notifications/stream?token=${token}`);
    evtSource.addEventListener('notification', (e) => {
      try {
        const notif = JSON.parse(e.data);
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(notif.title, { body: notif.message });
        }
        loadAlerts();
        loadOverview();
      } catch (err) {}
    });
  } catch (e) {}
}

// ── Navigation ───────────────────────────────────────────────────────────────
window.navigate = function(section, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`section-${section}`).classList.add('active');
  if (el) el.classList.add('active');
  else {
    const navEl = document.querySelector(`[data-section="${section}"]`);
    if (navEl) navEl.classList.add('active');
  }
  document.getElementById('page-title').textContent = {
    overview: 'Overview', post: 'Post Surplus', 'my-surplus': 'My Surplus',
    impact: 'Impact', predictions: 'Predictions', profile: 'Profile'
  }[section] || section;
  currentSection = section;

  // Lazy load sections
  if (section === 'my-surplus') loadSurplus();
  if (section === 'impact') loadImpact();
  if (section === 'predictions') loadPredictions();
  if (section === 'profile') loadProfile();

  // Close sidebar on mobile
  document.getElementById('sidebar').classList.remove('open');
};

window.toggleSidebar = () => {
  document.getElementById('sidebar').classList.toggle('open');
};

// ── Alerts ───────────────────────────────────────────────────────────────────
let alertsOpen = false;
window.toggleAlerts = () => {
  alertsOpen = !alertsOpen;
  document.getElementById('alerts-panel').classList.toggle('open', alertsOpen);
  if (alertsOpen) loadAlerts();
};
document.addEventListener('click', e => {
  if (!e.target.closest('.alerts-panel') && !e.target.closest('#alert-btn')) {
    alertsOpen = false;
    document.getElementById('alerts-panel').classList.remove('open');
  }
});

async function loadAlerts() {
  try {
    const { alerts } = await api.donor.getAlerts(token);
    const unread = alerts.filter(a => !a.is_read);
    document.getElementById('alert-dot').style.display = unread.length ? 'block' : 'none';

    const list = document.getElementById('alerts-list');
    if (!alerts.length) {
      list.innerHTML = '<div class="alert-empty">No notifications yet.</div>';
      return;
    }
    list.innerHTML = alerts.map(a => `
      <div class="alert-item ${!a.is_read ? 'unread' : ''}" onclick="markAlertRead('${a.id}', this)">
        <div class="alert-item-title">${a.title}</div>
        <div class="alert-item-msg">${a.message}</div>
        <div class="alert-item-time">${timeAgo(a.created_at)}</div>
      </div>
    `).join('');
  } catch {}
}

window.markAlertRead = async (id, el) => {
  el.classList.remove('unread');
  await api.donor.markAlertRead(token, id);
};
window.markAllRead = async () => {
  document.querySelectorAll('.alert-item.unread').forEach(el => el.classList.remove('unread'));
  document.getElementById('alert-dot').style.display = 'none';
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

    document.getElementById('stat-posted').textContent    = impactData.totalPosts;
    document.getElementById('stat-recovered').textContent = impactData.recovered.quantity + ' kg';
    document.getElementById('stat-matched').textContent   = impactData.matched;
    document.getElementById('stat-meals').textContent     = impactData.mealsEquivalent.toLocaleString();

    // Active badge
    const active = surplusData.posts.filter(p => p.status === 'available').length;
    const badge = document.getElementById('active-count');
    badge.textContent = active;
    badge.style.display = active > 0 ? 'inline-block' : 'none';

    // Recent surplus list (last 5)
    const recent = surplusData.posts.slice(0, 5);
    const rList = document.getElementById('recent-surplus-list');
    if (!recent.length) {
      rList.innerHTML = '<div class="empty-state">No surplus posted yet.<br>Click <strong>Post Surplus</strong> to get started.</div>';
    } else {
      rList.innerHTML = recent.map(p => `
        <div class="item-row">
          <div class="item-row-left">
            <span>${foodEmoji(p.food_type)}</span>
            <div>
              <div class="item-food">${p.food_name}</div>
              <div class="item-qty">${p.quantity} ${p.quantity_unit}</div>
            </div>
          </div>
          <span class="badge badge-${p.status}">${p.status}</span>
        </div>
      `).join('');
    }

    // Monthly trend chart
    const trend = impactData.monthlyTrend.reverse();
    renderTrendChart(trend);
  } catch (err) {
    console.error(err);
  }
}

function renderTrendChart(trend) {
  if (trendChart) trendChart.destroy();
  const ctx = document.getElementById('trend-chart').getContext('2d');
  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: trend.map(t => t.month),
      datasets: [{
        label: 'Posts', data: trend.map(t => t.posts),
        borderColor: '#F59E0B', backgroundColor: 'rgba(245,158,11,0.1)',
        tension: 0.4, fill: true, pointBackgroundColor: '#F59E0B'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6B7280', font: { size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6B7280', font: { size: 11 } }, beginAtZero: true }
      }
    }
  });
}

// ── Post Surplus ──────────────────────────────────────────────────────────────
// Set default datetime values
const nowLocal = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
};
const inHours = (h) => {
  const d = new Date();
  d.setHours(d.getHours() + h);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

document.getElementById('p-avail-time').value  = nowLocal();
document.getElementById('p-usable-time').value = inHours(4);

window.toggleTag = (btn) => {
  btn.classList.toggle('selected');
};

window.postSurplus = async () => {
  const foodName     = document.getElementById('p-food-name').value.trim();
  const foodType     = document.getElementById('p-food-type').value;
  const quantity     = parseFloat(document.getElementById('p-quantity').value);
  const quantityUnit = document.getElementById('p-unit').value;
  const prepState    = document.getElementById('p-prep-state').value;
  const availTime    = document.getElementById('p-avail-time').value;
  const usableTime   = document.getElementById('p-usable-time').value;
  const pickup       = document.getElementById('p-pickup').value.trim();
  const instructions = document.getElementById('p-instructions').value.trim();
  const dietaryTags  = [...document.querySelectorAll('#dietary-tags .tag-btn.selected')].map(b => b.dataset.val);

  const errEl  = document.getElementById('post-error');
  const succEl = document.getElementById('post-success');
  errEl.style.display = 'none';
  succEl.style.display = 'none';

  if (!foodName) { errEl.textContent = 'Food name is required.'; errEl.style.display = 'block'; return; }
  if (!quantity || quantity <= 0) { errEl.textContent = 'Please enter a valid quantity.'; errEl.style.display = 'block'; return; }
  if (!availTime || !usableTime) { errEl.textContent = 'Please set both availability and safe-until times.'; errEl.style.display = 'block'; return; }

  const btn = document.getElementById('post-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Posting…';

  try {
    await api.donor.postSurplus(token, {
      foodName, foodType, quantity, quantityUnit,
      preparationState: prepState,
      dietaryTags,
      availabilityTime: new Date(availTime).toISOString(),
      remainingUsableTime: new Date(usableTime).toISOString(),
      pickupAddress: pickup,
      specialInstructions: instructions
    });

    succEl.textContent = '✅ Surplus posted! Our network is now matching it automatically.';
    succEl.style.display = 'block';

    // Reset form
    document.getElementById('p-food-name').value = '';
    document.getElementById('p-quantity').value = '';
    document.getElementById('p-instructions').value = '';
    document.getElementById('p-pickup').value = '';
    document.querySelectorAll('#dietary-tags .tag-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('p-avail-time').value  = nowLocal();
    document.getElementById('p-usable-time').value = inHours(4);

    // Refresh overview
    await loadOverview();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">🚀</span> Post Surplus — Network Handles the Rest';
  }
};

// ── My Surplus ────────────────────────────────────────────────────────────────
let surplusFilter = 'all';
async function loadSurplus() {
  try {
    const { posts } = await api.donor.getSurplus(token);
    allSurplus = posts;
    renderSurplus(surplusFilter);
  } catch {
    document.getElementById('surplus-list').innerHTML = '<div class="empty-state">Failed to load surplus posts.</div>';
  }
}

window.filterSurplus = (filter, btn) => {
  surplusFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderSurplus(filter);
};

function renderSurplus(filter) {
  const list = filter === 'all' ? allSurplus : allSurplus.filter(p => p.status === filter);
  const el = document.getElementById('surplus-list');
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">No surplus posts with status "${filter}".</div>`;
    return;
  }
  el.innerHTML = list.map(p => `
    <div class="surplus-card">
      <div class="surplus-card-header">
        <div>
          <div class="surplus-food-name">${foodEmoji(p.food_type)} ${p.food_name}</div>
        </div>
        <span class="badge badge-${p.status}">${p.status.replace('_',' ')}</span>
      </div>
      <div class="surplus-meta">
        <span>⚖️ ${p.quantity} ${p.quantity_unit}</span>
        <span>📅 Available: ${fmtDt(p.availability_time)}</span>
        <span>⏰ Safe until: ${fmtDt(p.remaining_usable_time)}</span>
        ${p.matched_org_name ? `<span>🤝 Matched to: <strong>${p.matched_org_name}</strong></span>` : ''}
      </div>
      ${['available'].includes(p.status) ? `
        <div class="surplus-actions">
          <button class="btn-sm btn-sm-danger" onclick="cancelSurplus('${p.id}', this)">Cancel</button>
        </div>
      ` : ''}
    </div>
  `).join('');
}

window.cancelSurplus = async (id, btn) => {
  if (!confirm('Cancel this surplus post?')) return;
  btn.disabled = true;
  btn.textContent = 'Cancelling…';
  try {
    await api.donor.cancelSurplus(token, id);
    await loadSurplus();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = 'Cancel';
  }
};

// ── Impact ────────────────────────────────────────────────────────────────────
async function loadImpact() {
  try {
    const data = await api.donor.getImpact(token);

    document.getElementById('impact-meals').textContent = data.mealsEquivalent.toLocaleString();
    document.getElementById('impact-kg').textContent    = data.recovered.quantity + ' kg';
    document.getElementById('impact-waste').textContent = (data.wasted.quantity || 0) + ' kg';

    // Doughnut chart
    if (impactDoughnut) impactDoughnut.destroy();
    const dCtx = document.getElementById('impact-doughnut').getContext('2d');
    const recovered = data.recovered.count || 0;
    const expired   = data.wasted.count || 0;
    const pending   = (data.totalPosts || 0) - recovered - expired;
    impactDoughnut = new Chart(dCtx, {
      type: 'doughnut',
      data: {
        labels: ['Recovered', 'Wasted', 'Pending'],
        datasets: [{ data: [recovered, expired, Math.max(0,pending)], backgroundColor: ['#10B981','#EF4444','#3B82F6'], borderWidth: 0 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        cutout: '70%'
      }
    });

    const legend = document.getElementById('impact-legend');
    legend.innerHTML = [
      ['#10B981','Recovered','color:#10B981'],
      ['#EF4444','Wasted','color:#EF4444'],
      ['#3B82F6','Pending','color:#3B82F6']
    ].map(([c,l]) => `<span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:50%;background:${c};display:inline-block"></span>${l}</span>`).join('');

    // Bar chart
    if (impactBar) impactBar.destroy();
    const bCtx = document.getElementById('impact-bar').getContext('2d');
    const trend = [...data.monthlyTrend].reverse();
    impactBar = new Chart(bCtx, {
      type: 'bar',
      data: {
        labels: trend.map(t => t.month),
        datasets: [{
          label: 'kg Recovered',
          data: trend.map(t => t.quantity || 0),
          backgroundColor: 'rgba(16,185,129,0.6)',
          borderColor: '#10B981', borderWidth: 1, borderRadius: 6
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6B7280', font: { size: 11 } } },
          y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6B7280', font: { size: 11 } }, beginAtZero: true }
        }
      }
    });
  } catch (err) {
    console.error(err);
  }
}

// ── Predictions ───────────────────────────────────────────────────────────────
async function loadPredictions() {
  const el = document.getElementById('prediction-content');
  try {
    const { prediction, patterns, riskDays } = await api.donor.getPredictions(token);

    if (!prediction || !patterns.length) {
      el.innerHTML = '<div class="empty-state">Post at least 2 surplus records to generate predictions.</div>';
      return;
    }

    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    el.innerHTML = `
      <div class="prediction-grid">
        <div class="prediction-card">
          <div class="prediction-icon">📦</div>
          <div class="prediction-title">Expected Next Surplus</div>
          <div class="prediction-value">${prediction.expectedQty || '—'} kg</div>
          <div class="prediction-sub">${prediction.foodType || 'Based on your history'}</div>
          <div class="confidence-bar"><div class="confidence-fill" style="width:${Math.round((prediction.confidence || 0.5)*100)}%"></div></div>
          <div class="prediction-sub" style="margin-top:5px">Confidence: ${Math.round((prediction.confidence || 0.5)*100)}%</div>
        </div>
        <div class="prediction-card">
          <div class="prediction-icon">📈</div>
          <div class="prediction-title">Your Top Surplus Types</div>
          ${patterns.slice(0,3).map(p => `
            <div class="risk-item" style="margin-top:8px">
              <span class="day">${foodEmoji(p.food_type)} ${p.food_type.replace('_',' ')}</span>
              <span class="count">~${Math.round(p.avg_qty || 0)} kg avg</span>
            </div>
          `).join('')}
        </div>
        <div class="prediction-card">
          <div class="prediction-icon">⚠️</div>
          <div class="prediction-title">High Surplus Days</div>
          <div class="risk-list">
            ${riskDays.slice(0,5).map(d => `
              <div class="risk-item">
                <span class="day">${d.day}</span>
                <span class="count">${d.count} posts historically</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">💡 Reduction Tips</span></div>
        <div style="color:var(--muted);font-size:0.87rem;line-height:1.8">
          ${patterns.slice(0,3).map(p => `
            • Consider reducing <strong style="color:var(--text)">${p.food_type.replace('_',' ')}</strong> production on 
            <strong style="color:var(--primary)">${riskDays[0]?.day || 'peak days'}</strong> — 
            you average <strong style="color:var(--text)">${Math.round(p.avg_qty||0)} kg</strong> surplus of this type.
          `).join('<br>')}
        </div>
      </div>
    `;
  } catch (err) {
    el.innerHTML = '<div class="empty-state">Failed to load predictions.</div>';
  }
}

// ── Profile ───────────────────────────────────────────────────────────────────
async function loadProfile() {
  try {
    const { org, profile } = await api.donor.getProfile(token);

    document.getElementById('pr-name').value    = org?.name || '';
    document.getElementById('pr-address').value = org?.location_address || '';
    document.getElementById('pr-phone').value   = org?.contact_phone || '';
    document.getElementById('pr-hours').value   = org?.operating_hours || '';
    document.getElementById('pr-desc').value    = org?.description || '';

    // Food categories
    const cats = JSON.parse(profile?.food_categories || '[]');
    document.querySelectorAll('#profile-food-cats .tag-btn').forEach(btn => {
      btn.classList.toggle('selected', cats.includes(btn.dataset.val));
    });

    // Verification status
    const statusMap = {
      pending:   '⏳ Pending verification — our team will review soon.',
      active:    '✅ Verified and active.',
      rejected:  '❌ Verification rejected. Please contact support.',
      suspended: '⛔ Account suspended.',
    };
    const box = document.getElementById('verify-status-box');
    box.textContent = statusMap[org?.status] || '—';
    if (org?.status === 'active') box.style.background = 'rgba(16,185,129,0.08)';
    else if (org?.status === 'rejected') box.style.background = 'rgba(239,68,68,0.08)';

  } catch (err) {
    console.error(err);
  }
}

window.toggleProfileTag = (btn) => {
  btn.classList.toggle('selected');
};

window.saveProfile = async () => {
  const btn = document.getElementById('profile-save-btn');
  document.getElementById('profile-error').style.display = 'none';
  document.getElementById('profile-success').style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';

  const foodCategories = [...document.querySelectorAll('#profile-food-cats .tag-btn.selected')].map(b => b.dataset.val);

  try {
    await api.donor.updateProfile(token, {
      name:          document.getElementById('pr-name').value.trim(),
      locationAddress: document.getElementById('pr-address').value.trim(),
      contactPhone:  document.getElementById('pr-phone').value.trim(),
      operatingHours: document.getElementById('pr-hours').value.trim(),
      description:   document.getElementById('pr-desc').value.trim(),
      foodCategories
    });
    const succEl = document.getElementById('profile-success');
    succEl.textContent = 'Profile updated successfully.';
    succEl.style.display = 'block';
  } catch (err) {
    const errEl = document.getElementById('profile-error');
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Profile';
  }
};

// ── Utilities ─────────────────────────────────────────────────────────────────
function foodEmoji(type) {
  const map = {
    cooked_meal: '🍱', bakery: '🍞', produce: '🥦',
    dairy: '🥛', packaged: '📦', beverages: '🥤', other: '🍽️'
  };
  return map[type] || '🍽️';
}

function fmtDt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
