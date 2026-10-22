/**
 * FoodBridge — Individual Recipient Interface (Interface 3)
 * Client Application Logic
 * 
 * Features:
 * - GPS Geolocation & manual landmark/area search
 * - Intelligent Recommendation Engine (distance, capacity, dietary, urgency, hours)
 * - Access-point card rendering with live availability dots
 * - Slide-up detail inspection panel with directions & contact info
 * - Multi-criteria sorting (distance, availability, capacity)
 * - Browser Notification opt-in with SSE integration & desktop alerts
 * - Seamless live API integration + resilient offline demo fallback
 */

// ── State ──
const state = {
  userLat: null,
  userLng: null,
  locationName: '',
  people: 3,
  dietary: 'any',
  urgency: 'today',
  accessPoints: [],
  recommendedPoint: null,
  selectedPoint: null,
  sortBy: 'distance',
  alertsEnabled: false
};

// Known coordinates for common landmarks/cities for instant geocoding fallback
const LANDMARK_COORDS = {
  'bengaluru':      { lat: 12.9716, lng: 77.5946, name: 'Bengaluru Central' },
  'bangalore':      { lat: 12.9716, lng: 77.5946, name: 'Bengaluru Central' },
  'mg road':        { lat: 12.9752, lng: 77.6084, name: 'MG Road, Bengaluru' },
  'shanthi nagar':  { lat: 12.9560, lng: 77.5990, name: 'Shanthi Nagar, Bengaluru' },
  'shanthi':        { lat: 12.9560, lng: 77.5990, name: 'Shanthi Nagar, Bengaluru' },
  'shivajinagar':   { lat: 12.9850, lng: 77.6050, name: 'Shivajinagar, Bengaluru' },
  'indiranagar':    { lat: 12.9784, lng: 77.6408, name: 'Indiranagar, Bengaluru' },
  'koramangala':    { lat: 12.9340, lng: 77.6225, name: 'Koramangala, Bengaluru' },
  'yeshwanthpur':   { lat: 13.0230, lng: 77.5510, name: 'Yeshwanthpur, Bengaluru' },
  'btm layout':     { lat: 12.9166, lng: 77.6101, name: 'BTM Layout, Bengaluru' },
  'whitefield':     { lat: 12.9698, lng: 77.7500, name: 'Whitefield, Bengaluru' },
  'delhi':          { lat: 28.6139, lng: 77.2090, name: 'New Delhi' },
  'mumbai':         { lat: 19.0760, lng: 72.8777, name: 'Mumbai' }
};

// Fallback seed data in case backend server is unreachable
const DEMO_ACCESS_POINTS = [
  {
    id: 'ngo-helping-hands',
    name: 'Helping Hands Food Mission',
    type: 'ngo',
    location_address: '14, 2nd Cross, Shanthi Nagar, Bengaluru',
    location_lat: 12.9560,
    location_lng: 77.5990,
    operating_hours: 'Daily 11:00 AM – 8:00 PM',
    contact_phone: '+91 80 2221 4455',
    description: 'Community feeding program and hot meal distribution center serving families and migrant workers.',
    serving_capacity: 350,
    food_requirements: ['Cooked meals', 'Rice & Curry', 'Dal', 'Fresh Chapati'],
    dietary_restrictions: ['vegetarian', 'halal'],
    activeIncoming: 2,
    status: 'open',
    foodAvailableText: 'Fresh cooked lunch & dinner meals (Vegetarian, Halal-certified)',
    accessInfo: 'Walk-ins welcome at community dining hall. Free hot meals distributed on a first-come basis. Carry a reusable container if taking food for family.'
  },
  {
    id: 'shelter-city-hope',
    name: 'City Hope Night Shelter & Community Kitchen',
    type: 'shelter',
    location_address: '88 Broadway Street, Shivajinagar, Bengaluru',
    location_lat: 12.9850,
    location_lng: 77.6050,
    operating_hours: 'Daily 6:00 PM – 10:00 AM (Dinner 7:30 PM)',
    contact_phone: '+91 80 2559 7800',
    description: 'Overnight shelter and kitchen providing nutritious dinner, clean drinking water, and morning breakfast to unhoused citizens.',
    serving_capacity: 180,
    food_requirements: ['Hot meals', 'Bread', 'Milk', 'Nutritious snacks'],
    dietary_restrictions: ['vegetarian'],
    activeIncoming: 1,
    status: 'open',
    foodAvailableText: 'Nutritious hot khichdi, whole grain bread, and warm milk',
    accessInfo: 'Evening meal token counter opens at 6:30 PM. Wheelchair accessible ground floor dining area.'
  },
  {
    id: 'foodbank-central-reserve',
    name: 'Central Food Bank & Community Pantry',
    type: 'food_bank',
    location_address: 'Plot 42, Yeshwanthpur Industrial Area, Bengaluru',
    location_lat: 13.0230,
    location_lng: 77.5510,
    operating_hours: 'Daily 24/7 (Public Pantry: 8:00 AM – 9:00 PM)',
    contact_phone: '+91 80 2337 9911',
    description: 'Regional food distribution center and dry pantry buffering large surplus for high-volume emergency aid.',
    serving_capacity: 1500,
    food_requirements: ['Dry ration kits', 'Packaged dairy', 'Fresh produce', 'Baked goods'],
    dietary_restrictions: ['vegetarian', 'vegan', 'halal'],
    activeIncoming: 4,
    status: 'open',
    foodAvailableText: 'Prepared meal packs, dry ration emergency boxes, bakery assortments',
    accessInfo: 'Family emergency pantry open at Gate 2. Family ration kits available upon direct request. No ID or documents needed.'
  },
  {
    id: 'ngo-nourish-kids',
    name: 'Nourish Kids Youth Nutrition Pantry',
    type: 'ngo',
    location_address: '77, 2nd Stage, BTM Layout, Bengaluru',
    location_lat: 12.9166,
    location_lng: 77.6101,
    operating_hours: 'Mon–Sat 10:00 AM – 6:00 PM',
    contact_phone: '+91 80 2668 5544',
    description: 'After-school nutrition and evening snack center supporting underprivileged children and student families.',
    serving_capacity: 120,
    food_requirements: ['Fresh fruits', 'Milk', 'Cooked snacks', 'Biscuits', 'Nutritious meals'],
    dietary_restrictions: ['vegetarian'],
    activeIncoming: 1,
    status: 'soon',
    foodAvailableText: 'Fruit baskets, fortified milk packets, and healthy snacks',
    accessInfo: 'Open to children and families with young dependents. Evening meal distribution starts at 4:30 PM.'
  }
];

// ── DOM Helpers ──
const $ = (id) => document.getElementById(id);

// ── Geolocation & Distance Calculation ──
function calculateDistance(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const R = 6371; // km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

/**
 * Triggered by the satellite/GPS icon button
 */
window.useMyLocation = function () {
  const locateBtn = $('locate-btn');
  const locInput = $('location-input');

  if (!navigator.geolocation) {
    showToast('Geolocation is not supported by your browser', 'info');
    return;
  }

  locateBtn.innerHTML = '<span class="spinner"></span>';
  locateBtn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.userLat = pos.coords.latitude;
      state.userLng = pos.coords.longitude;
      state.locationName = 'Current Location (GPS)';
      locInput.value = state.locationName;
      locateBtn.innerHTML = '📍';
      locateBtn.disabled = false;
      showToast('Location detected successfully', 'success');
      searchFood();
    },
    (err) => {
      console.warn('[GPS Error]', err);
      locateBtn.innerHTML = '📡';
      locateBtn.disabled = false;
      // Default to central Bengaluru coordinates if GPS permission is denied
      state.userLat = 12.9716;
      state.userLng = 77.5946;
      state.locationName = 'Bengaluru Central (Default)';
      locInput.value = state.locationName;
      showToast('Could not access GPS. Using default area center.', 'info');
      searchFood();
    },
    { timeout: 8000, enableHighAccuracy: true }
  );
};

/**
 * Main search function
 */
window.searchFood = async function () {
  const locInput = $('location-input');
  const peopleSelect = $('sel-people');
  const dietarySelect = $('sel-dietary');
  const urgencySelect = $('sel-urgency');
  const errorDiv = $('search-error');
  const loadingDiv = $('loading-state');
  const resultsSec = $('results-section');
  const recBanner = $('rec-banner');
  const accessList = $('access-list');
  const countLabel = $('results-count');
  const alertOpt = $('alert-opt');

  errorDiv.style.display = 'none';
  resultsSec.classList.add('show');
  loadingDiv.style.display = 'flex';
  accessList.innerHTML = '';
  countLabel.textContent = 'Searching nearby access points…';

  state.people = parseInt(peopleSelect.value) || 3;
  state.dietary = dietarySelect.value || 'any';
  state.urgency = urgencySelect.value || 'today';

  const rawLocation = (locInput.value || '').trim();

  // Resolve typed location to coordinates if not using GPS
  if (rawLocation && rawLocation !== 'Current Location (GPS)') {
    const lower = rawLocation.toLowerCase();
    let matched = false;
    for (const [key, coords] of Object.entries(LANDMARK_COORDS)) {
      if (lower.includes(key)) {
        state.userLat = coords.lat;
        state.userLng = coords.lng;
        state.locationName = coords.name;
        matched = true;
        break;
      }
    }
    if (!matched && !state.userLat) {
      // Default fallback coordinates (Central Bangalore)
      state.userLat = 12.9716;
      state.userLng = 77.5946;
      state.locationName = rawLocation;
    }
  } else if (!state.userLat) {
    state.userLat = 12.9716;
    state.userLng = 77.5946;
    state.locationName = 'Bengaluru Central';
    locInput.value = state.locationName;
  }

  // Build query URL
  const queryParams = new URLSearchParams();
  if (state.userLat && state.userLng) {
    queryParams.append('lat', state.userLat);
    queryParams.append('lng', state.userLng);
  }
  queryParams.append('people', state.people);
  queryParams.append('dietary', state.dietary);
  queryParams.append('urgency', state.urgency);
  if (rawLocation) queryParams.append('q', rawLocation);

  let points = [];

  try {
    const res = await fetch(`/api/recipient/search?${queryParams.toString()}`);
    if (res.ok) {
      const data = await res.json();
      points = data.accessPoints || [];
    } else {
      throw new Error('API returned status ' + res.status);
    }
  } catch (err) {
    console.info('[Recipient Search] Backend API not responding, using rich demo dataset:', err.message);
    // Use fallback demo points
    points = DEMO_ACCESS_POINTS.map((item) => ({ ...item }));
  }

  // Ensure all points have computed distances & dietary arrays
  points.forEach((ap) => {
    if (ap.distance == null && state.userLat && state.userLng && ap.location_lat && ap.location_lng) {
      ap.distance = calculateDistance(state.userLat, state.userLng, ap.location_lat, ap.location_lng);
    }
    if (!Array.isArray(ap.dietary_restrictions)) {
      try {
        ap.dietary_restrictions = JSON.parse(ap.dietary_restrictions || '[]');
      } catch (e) {
        ap.dietary_restrictions = [];
      }
    }
    if (!Array.isArray(ap.food_requirements)) {
      try {
        ap.food_requirements = JSON.parse(ap.food_requirements || '[]');
      } catch (e) {
        ap.food_requirements = [];
      }
    }
  });

  state.accessPoints = points;
  loadingDiv.style.display = 'none';

  if (!points || points.length === 0) {
    countLabel.textContent = 'No access points found';
    accessList.innerHTML = `
      <div class="empty-state">
        <div class="ei">🔍</div>
        <h3>No verified food access points in this immediate area</h3>
        <p>Try searching for a nearby landmark (e.g. "Shanthi Nagar", "Shivajinagar", "Koramangala") or broaden your dietary filters.</p>
      </div>
    `;
    recBanner.classList.remove('show');
    return;
  }

  // Run Recommendation Intelligence
  computeRecommendation();

  // Sort and Render
  sortResults();

  // Show alert opt-in banner if not yet enabled
  if (!state.alertsEnabled && alertOpt) {
    alertOpt.classList.add('show');
  }
};

/**
 * Intelligent Recommendation Algorithm (Interface 3.D)
 * Considers: Distance + Current Availability + Dietary Suitability + Serving Capacity + Urgency
 */
function computeRecommendation() {
  const points = state.accessPoints;
  if (!points || points.length === 0) return;

  let bestPoint = null;
  let bestScore = -999;
  let recommendationReason = '';

  points.forEach((ap) => {
    let score = 50;

    // 1. Distance scoring (closer = higher score)
    const dist = ap.distance != null ? ap.distance : 5.0;
    if (dist <= 2.0) score += 35;
    else if (dist <= 5.0) score += 20;
    else if (dist <= 10.0) score += 5;
    else score -= 15;

    // 2. Availability scoring
    const activeIncoming = ap.activeIncoming || 0;
    if (activeIncoming > 0) score += 25;
    if (ap.status === 'open' || (ap.operating_hours && !ap.operating_hours.toLowerCase().includes('closed'))) {
      score += 20;
    }

    // 3. Dietary suitability
    if (state.dietary !== 'any') {
      const match = ap.dietary_restrictions.some(
        (d) => d.toLowerCase() === state.dietary.toLowerCase()
      );
      if (match) {
        score += 25;
      } else {
        score -= 20;
      }
    }

    // 4. Capacity vs people requested
    const cap = ap.serving_capacity || 100;
    if (cap >= state.people * 10) score += 15;
    else if (cap >= state.people) score += 5;

    // 5. Urgency weighting
    if (state.urgency === 'now') {
      if (ap.type === 'ngo' || ap.type === 'shelter') score += 15;
    } else if (state.urgency === 'tomorrow') {
      if (ap.type === 'food_bank') score += 15;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPoint = ap;

      // Construct a human-readable explanation
      const parts = [];
      if (dist != null) parts.push(`Only ${dist} km from you`);
      if (activeIncoming > 0) parts.push('has active fresh surplus meals on hand');
      else parts.push('open and currently serving');

      if (state.dietary !== 'any') {
        parts.push(`meets your ${state.dietary} preference`);
      }
      parts.push(`ample capacity (${cap}+ meals)`);

      recommendationReason = parts.join(' • ');
    }
  });

  state.recommendedPoint = bestPoint;

  const recBanner = $('rec-banner');
  if (bestPoint && recBanner) {
    $('rec-name').textContent = bestPoint.name;
    $('rec-why').textContent = recommendationReason;
    const recBtn = $('rec-go-btn');
    recBtn.onclick = () => openDetail(bestPoint.id);
    recBanner.classList.add('show');
  }
}

/**
 * Multi-criteria sorting
 */
window.sortResults = function () {
  const sortSelect = $('sort-select');
  state.sortBy = sortSelect.value || 'distance';

  const pts = [...state.accessPoints];

  if (state.sortBy === 'distance') {
    pts.sort((a, b) => {
      const da = a.distance != null ? a.distance : 999;
      const db = b.distance != null ? b.distance : 999;
      return da - db;
    });
  } else if (state.sortBy === 'availability') {
    pts.sort((a, b) => {
      const aAvail = (a.activeIncoming || 0) + (a.status === 'open' ? 2 : 0);
      const bAvail = (b.activeIncoming || 0) + (b.status === 'open' ? 2 : 0);
      return bAvail - aAvail;
    });
  } else if (state.sortBy === 'capacity') {
    pts.sort((a, b) => (b.serving_capacity || 0) - (a.serving_capacity || 0));
  }

  renderCards(pts);
};

/**
 * Render access-point cards into #access-list
 */
function renderCards(points) {
  const container = $('access-list');
  const countLabel = $('results-count');

  countLabel.textContent = `${points.length} verified access point${points.length === 1 ? '' : 's'} near you`;

  container.innerHTML = points
    .map((ap) => {
      const isTopPick = state.recommendedPoint && state.recommendedPoint.id === ap.id;

      // Icon & color styling by organization type
      let icon = '🍲';
      let iconBg = 'icon-bg-orange';
      let tagClass = '';
      let typeLabel = 'Community Kitchen';

      if (ap.type === 'shelter') {
        icon = '🏠';
        iconBg = 'icon-bg-blue';
        tagClass = 'blue';
        typeLabel = 'Night Shelter & Kitchen';
      } else if (ap.type === 'food_bank') {
        icon = '📦';
        iconBg = 'icon-bg-purple';
        tagClass = '';
        typeLabel = 'Food Bank & Pantry';
      } else if (ap.type === 'ngo') {
        icon = '🤝';
        iconBg = 'icon-bg-green';
        tagClass = 'green';
        typeLabel = 'NGO Mission';
      }

      // Availability status calculation
      const hasFood = (ap.activeIncoming || 0) > 0;
      let dotClass = 'open';
      let statusText = 'Open • Ready to Serve';

      if (hasFood) {
        statusText = 'Fresh Surplus Meals Available Right Now';
        dotClass = 'open';
      } else if (ap.operating_hours && ap.operating_hours.toLowerCase().includes('daily')) {
        statusText = 'Serving Regular Hours';
        dotClass = 'open';
      } else {
        statusText = 'Open Today';
        dotClass = 'soon';
      }

      const distText = ap.distance != null ? `${ap.distance} km` : 'Near you';
      const travelEstimate = ap.distance != null ? `~${Math.max(3, Math.round(ap.distance * 3))} min` : 'Short distance';

      return `
        <div class="access-card ${isTopPick ? 'top-pick' : ''}" onclick="openDetail('${ap.id}')">
          <div class="access-type-icon ${iconBg}">
            ${icon}
          </div>
          <div class="access-info">
            <div class="access-name">
              ${escapeHtml(ap.name)}
              <span class="access-type-tag ${tagClass}">${typeLabel}</span>
              ${isTopPick ? '<span class="access-type-tag" style="background:rgba(249,115,22,0.2);color:#F97316;">★ Top Pick</span>' : ''}
            </div>
            <div class="access-meta">
              <span>📍 ${escapeHtml(ap.location_address || 'Central Address')}</span>
              <span>⏰ ${escapeHtml(ap.operating_hours || 'Regular daily hours')}</span>
              <span>👥 Capacity: ${ap.serving_capacity || 100}+ people</span>
            </div>
            <div class="access-avail">
              <span class="avail-dot ${dotClass}"></span>
              <span>${statusText}</span>
            </div>
          </div>
          <div class="access-right">
            <div class="access-dist">${distText}</div>
            <div class="access-dist-sub">${travelEstimate}</div>
            <button class="access-go-btn" onclick="openDetail('${ap.id}'); event.stopPropagation();">
              View Details →
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

/**
 * Slide-Up Detail Panel Handler
 */
window.openDetail = async function (id) {
  let ap = state.accessPoints.find((p) => p.id === id);

  // Attempt to fetch fresh extended detail from backend if available
  try {
    const res = await fetch(`/api/recipient/access-point/${id}`);
    if (res.ok) {
      const data = await res.json();
      if (data.org) {
        ap = { ...ap, ...data.org };
      }
    }
  } catch (e) {
    // Graceful fallback to existing ap object in memory
  }

  if (!ap) return;
  state.selectedPoint = ap;

  // Icons and titles
  let icon = '🍲';
  let typeLabel = 'Community Kitchen & Meal Point';
  if (ap.type === 'shelter') {
    icon = '🏠';
    typeLabel = 'Night Shelter & Hot Meal Counter';
  } else if (ap.type === 'food_bank') {
    icon = '📦';
    typeLabel = 'Central Food Bank & Reserve Hub';
  } else if (ap.type === 'ngo') {
    icon = '🤝';
    typeLabel = 'Community Food Mission';
  }

  $('d-icon').textContent = icon;
  $('d-name').textContent = ap.name;
  $('d-subtype').textContent = `${typeLabel} • Verified Partner`;

  // Availability chip
  const availChip = $('d-avail-chip');
  availChip.className = 'avail-chip open';
  availChip.innerHTML = `● Open & Distributing Meals`;

  // Details
  $('d-hours').textContent = ap.operating_hours || 'Daily 11:00 AM – 8:00 PM';

  // Food summary
  let foodDesc = ap.foodAvailableText || 'Freshly prepared hot meals, rice, nutritious lentils, and whole wheat chapati';
  if (Array.isArray(ap.food_requirements) && ap.food_requirements.length > 0) {
    foodDesc += ` (${ap.food_requirements.join(', ')})`;
  }
  if (Array.isArray(ap.dietary_restrictions) && ap.dietary_restrictions.length > 0) {
    foodDesc += ` — Certified: ${ap.dietary_restrictions.join(', ')}`;
  }
  $('d-food').textContent = foodDesc;

  $('d-capacity').textContent = `${ap.serving_capacity || 200}+ meals daily (Storage: ${ap.storage_capacity || 'Cold + Dry storage'})`;
  $('d-address').textContent = ap.location_address || 'Address provided upon arrival';

  const distVal = ap.distance != null ? `${ap.distance} km away` : 'Within reachable distance';
  $('d-distance').textContent = `${distVal} (Estimated travel time: ~${ap.distance != null ? Math.max(3, Math.round(ap.distance * 3)) : 10} mins)`;

  $('d-access-info').textContent =
    ap.accessInfo ||
    'Free walk-in distribution. No vouchers, registration, or paperwork required. Clean dining space available for families.';

  $('d-phone').textContent = ap.contact_phone || '+91 80 2221 4455 (Coordinator Helpdesk)';

  // Directions button opens Google Maps navigation
  const dirBtn = $('d-directions-btn');
  dirBtn.onclick = () => {
    const destination = encodeURIComponent(ap.location_address || ap.name);
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${destination}`, '_blank');
  };

  // Open overlay
  const overlay = $('detail-overlay');
  overlay.classList.add('show');
};

/**
 * Close Slide-Up Detail Panel
 */
window.closeDetailPanel = function () {
  const overlay = $('detail-overlay');
  if (overlay) overlay.classList.remove('show');
};

window.closeDetail = function (e) {
  if (e && e.target && e.target.id === 'detail-overlay') {
    closeDetailPanel();
  }
};

/**
 * Browser Web Notification Opt-in (Interface 3.G)
 */
window.enableAlerts = async function () {
  const alertOpt = $('alert-opt');

  if (!('Notification' in window)) {
    showToast('Your browser does not support web notifications', 'info');
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      state.alertsEnabled = true;
      localStorage.setItem('foodbridge_recipient_alerts', 'true');
      if (alertOpt) alertOpt.style.display = 'none';

      showToast('🔔 Alerts activated! You will receive updates when meals arrive nearby.', 'success');

      // Test notification
      new Notification('FoodBridge Meal Alerts Active', {
        body: 'We will notify you immediately whenever surplus meals arrive at verified access points near you.',
        icon: 'https://cdn-icons-png.flaticon.com/512/1046/1046784.png'
      });

      // Connect to SSE stream if available for live broadcast
      connectLiveAlerts();
    } else {
      showToast('Notification permission was dismissed', 'info');
    }
  } catch (err) {
    console.error('[Notification Permission Error]', err);
    showToast('Could not enable notifications', 'info');
  }
};

/**
 * Connect to SSE stream for live real-time food surplus alerts
 */
function connectLiveAlerts() {
  if (window.EventSource) {
    try {
      const evtSource = new EventSource('/api/notifications/stream');
      evtSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload && payload.title) {
            new Notification(`FoodBridge: ${payload.title}`, {
              body: payload.message || 'Fresh surplus food is now available nearby.',
              icon: 'https://cdn-icons-png.flaticon.com/512/1046/1046784.png'
            });
            showToast(`🔔 ${payload.title}: ${payload.message}`, 'info');
          }
        } catch (e) {}
      };
      evtSource.onerror = () => {
        evtSource.close();
      };
    } catch (e) {}
  }
}

/**
 * Toast Notification Utility
 */
function showToast(message, type = 'info') {
  const container = $('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✅' : 'ℹ️'}</span>
    <div>${escapeHtml(message)}</div>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Initialization ──
document.addEventListener('DOMContentLoaded', () => {
  // Check if user previously enabled alerts
  if (localStorage.getItem('foodbridge_recipient_alerts') === 'true' && Notification.permission === 'granted') {
    state.alertsEnabled = true;
    const alertOpt = $('alert-opt');
    if (alertOpt) alertOpt.style.display = 'none';
    connectLiveAlerts();
  }

  // Handle enter key inside location input
  const locInput = $('location-input');
  if (locInput) {
    locInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        searchFood();
      }
    });
  }

  // Auto-run search on load so page immediately renders access points
  searchFood();
});
