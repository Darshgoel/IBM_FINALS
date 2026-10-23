/**
 * FoodBridge — Food Bank API Client
 * Food banks use the same /api/demand-org endpoints as demand_org accounts.
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
  foodBank: {
    /* Profile */
    getProfile:    (t)       => request('GET',  '/demand-org/profile', null, t),
    updateProfile: (t, body) => request('PUT',  '/demand-org/profile', body, t),

    /* Demands / food requests */
    postDemand:    (t, body) => request('POST',   '/demand-org/demand',         body, t),
    getDemands:    (t)       => request('GET',    '/demand-org/demands',         null, t),
    cancelDemand:  (t, id)   => request('DELETE', `/demand-org/demand/${id}`,    null, t),

    /* Matches */
    getMatches:    (t)       => request('GET',  '/demand-org/matches',              null, t),
    getInventoryMatches:(t)  => request('GET',  '/demand-org/inventory-matches',   null, t),
    acceptMatch:   (t, id)   => request('PUT',  `/demand-org/matches/${id}/accept`,  null, t),
    declineMatch:  (t, id)   => request('PUT',  `/demand-org/matches/${id}/decline`, null, t),

    /* Capacity & storage */
    updateCapacity:(t, body) => request('PUT',  '/demand-org/capacity', body, t),

    /* Inventory */
    getInventory:    (t)         => request('GET',    '/demand-org/inventory',        null, t),
    getInventoryStats:(t)        => request('GET',    '/demand-org/inventory-stats',  null, t),
    addInventory:    (t, body)   => request('POST',   '/demand-org/inventory',        body, t),
    updateInventory: (t, id, body) => request('PUT',  `/demand-org/inventory/${id}`,  body, t),
    deleteInventory: (t, id)     => request('DELETE', `/demand-org/inventory/${id}`,  null, t),

    /* Receipt confirmation */
    confirmReceipt:  (t, matchId, body) => request('POST', `/demand-org/matches/${matchId}/confirm-receipt`, body, t),

    /* Alerts */
    getAlerts:     (t)       => request('GET',  '/demand-org/alerts',           null, t),
    markAlertRead: (t, id)   => request('PUT',  `/demand-org/alerts/${id}/read`, null, t),
    markAllRead:   (t)       => request('PUT',  '/demand-org/alerts/read-all',  null, t)
  }
};

export default api;
