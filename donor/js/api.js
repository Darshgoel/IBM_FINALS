const API_BASE = '/api';

async function request(method, endpoint, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(API_BASE + endpoint, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const api = {
  auth: {
    register: (body)        => request('POST', '/auth/register', body),
    login:    (body)        => request('POST', '/auth/login', body),
    me:       (token)       => request('GET',  '/auth/me', null, token),
  },
  donor: {
    getProfile:   (t)          => request('GET',    '/donor/profile',      null, t),
    updateProfile:(t, body)    => request('PUT',    '/donor/profile',      body, t),
    postSurplus:  (t, body)    => request('POST',   '/donor/surplus',      body, t),
    getSurplus:   (t)          => request('GET',    '/donor/surplus',      null, t),
    getSurplusDetail:(t, id)   => request('GET',    `/donor/surplus/${id}`, null, t),
    cancelSurplus:(t, id)      => request('DELETE', `/donor/surplus/${id}`, null, t),
    getImpact:    (t)          => request('GET',    '/donor/impact',       null, t),
    getAlerts:    (t)          => request('GET',    '/donor/alerts',       null, t),
    markAlertRead:(t, id)      => request('PUT',    `/donor/alerts/${id}/read`, null, t),
  }
};

export default api;
