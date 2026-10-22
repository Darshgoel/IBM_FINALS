/**
 * FoodBridge — Demand-Org API Client
 */
const API_BASE = 'http://localhost:3000/api';

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
    login:  (body)  => request('POST', '/auth/login', body),
    me:     (token) => request('GET',  '/auth/me', null, token),
  },
  demandOrg: {
    /* Profile */
    getProfile:    (t)       => request('GET',  '/demand-org/profile', null, t),
    updateProfile: (t, body) => request('PUT',  '/demand-org/profile', body, t),

    /* Demands */
    postDemand:    (t, body) => request('POST',   '/demand-org/demand',       body, t),
    getDemands:    (t)       => request('GET',    '/demand-org/demands',      null, t),
    cancelDemand:  (t, id)   => request('DELETE', `/demand-org/demand/${id}`, null, t),

    /* Matches */
    getMatches:    (t)       => request('GET',  '/demand-org/matches',            null, t),
    acceptMatch:   (t, id)   => request('PUT',  `/demand-org/matches/${id}/accept`, null, t),
    declineMatch:  (t, id)   => request('PUT',  `/demand-org/matches/${id}/decline`, null, t),

    /* Capacity */
    updateCapacity:(t, body) => request('PUT',  '/demand-org/capacity', body, t),

    /* Insights */
    getInsights:   (t)       => request('GET',  '/demand-org/insights', null, t),

    /* Alerts */
    getAlerts:     (t)       => request('GET',  '/demand-org/alerts',         null, t),
    markAlertRead: (t, id)   => request('PUT',  `/demand-org/alerts/${id}/read`, null, t),
    markAllRead:   (t)       => request('PUT',  '/demand-org/alerts/read-all', null, t),
  }
};

export default api;
