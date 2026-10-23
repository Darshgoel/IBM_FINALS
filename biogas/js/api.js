/**
 * FoodBridge — Biogas Operator API Client
 * Uses /api/biogas/* endpoints.
 */
const API_BASE = '/api';

async function request(method, endpoint, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(API_BASE + endpoint, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const api = {
  auth: {
    me: (token) => request('GET', '/auth/me', null, token)
  },
  biogas: {
    /* Facility profile */
    getFacility:      (t)       => request('GET',  '/biogas/facility',       null, t),
    updateFacility:   (t, body) => request('PUT',  '/biogas/facility',       body, t),

    /* Capacity */
    updateCapacity:   (t, body) => request('PUT',  '/biogas/capacity',       body, t),
    resetIntake:      (t)       => request('POST', '/biogas/capacity/reset', null, t),

    /* Availability toggle */
    setAvailability:  (t, body) => request('PUT',  '/biogas/availability',   body, t),

    /* Routes — GET returns { routes, todayIntakeKg } */
    getRoutes:        (t)       => request('GET',  '/biogas/routes',          null, t),
    updateRouteStatus:(t, id, body) => request('PUT', `/biogas/routes/${id}/status`, body, t),

    /* Claim flow */
    getUnowned:       (t)       => request('GET',  '/biogas/unowned',         null, t),
    claimFacility:    (t, id)   => request('POST', `/biogas/claim/${id}`,     null, t),

    /* Alerts */
    getAlerts:        (t)       => request('GET',  '/biogas/alerts',          null, t),
    markAlertRead:    (t, id)   => request('PUT',  `/biogas/alerts/${id}/read`, null, t)
  }
};

export default api;
