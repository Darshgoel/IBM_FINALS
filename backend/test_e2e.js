/**
 * FoodBridge End-to-End System Test Suite
 * Tests server, authentication, document upload, donor surplus, demand matching,
 * network intelligence endpoints, admin verification, and live notification delivery.
 */

const http = require('http');

const BASE_URL = 'http://localhost:3000';

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const headers = options.headers || {};
    let body = options.body;

    if (body && typeof body === 'object') {
      body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(url, {
      method: options.method || 'GET',
      headers
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch(e) {}
        resolve({ status: res.statusCode, data: parsed, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const results = [];
function record(testName, passed, details = '') {
  results.push({ testName, passed, details });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon} : ${testName} ${details ? '(' + details + ')' : ''}`);
}

async function run() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🌉 FoodBridge Full End-to-End Verification Test Suite');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let adminToken = null;
  let networkToken = null;
  let donorToken = null;
  let donorOrgId = null;
  let ngoToken = null;
  let ngoOrgId = null;
  let testSurplusId = null;
  let testDemandId = null;
  let testMatchId = null;

  try {
    // 1. Health check
    const health = await request('/api/health');
    record('Server Health Check (/api/health)', health.status === 200 && health.data.status === 'ok');

    // 2. Admin Auth
    const adminLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@foodbridge.org', password: 'admin123' }
    });
    record('Admin Authentication', adminLogin.status === 200 && !!adminLogin.data.token, `Role: ${adminLogin.data?.user?.role}`);
    adminToken = adminLogin.data.token;

    // 3. Network Coordinator Auth
    const networkLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { email: 'network@foodbridge.org', password: 'network123' }
    });
    record('Network Coordinator Authentication', networkLogin.status === 200 && !!networkLogin.data.token, `Role: ${networkLogin.data?.user?.role}`);
    networkToken = networkLogin.data.token;

    // 4. Register Donor with Document Upload
    const donorReg = await request('/api/auth/register', {
      method: 'POST',
      body: {
        email: `donor_test_${Date.now()}@test.org`,
        password: 'password123',
        name: 'Chef Test',
        role: 'donor',
        orgName: 'Gourmet Kitchens Test',
        orgType: 'restaurant',
        locationAddress: 'Brigade Road, Bengaluru',
        locationLat: 12.974,
        locationLng: 77.608,
        contactPhone: '+91 99887 76655',
        documentName: 'FSSAI_Lic_Gourmet_Test.pdf',
        documentData: Buffer.from('Dummy PDF certificate content').toString('base64')
      }
    });
    record('Donor Registration with Verification Document Upload', donorReg.status === 201 && donorReg.data.documentUploaded === true);
    donorToken = donorReg.data.token;
    donorOrgId = donorReg.data.user.orgId;

    // 5. Register Demand Org (NGO) with Document Upload
    const ngoReg = await request('/api/auth/register', {
      method: 'POST',
      body: {
        email: `ngo_test_${Date.now()}@test.org`,
        password: 'password123',
        name: 'Care Coordinator',
        role: 'demand_org',
        orgName: 'Shelter Hope Test',
        orgType: 'shelter',
        locationAddress: 'Richmond Town, Bengaluru',
        locationLat: 12.962,
        locationLng: 77.601,
        contactPhone: '+91 91234 56789',
        documentName: 'NGO_Cert_Shelter_Test.pdf',
        documentData: Buffer.from('Dummy NGO Trust Deed content').toString('base64')
      }
    });
    record('Demand-Org Registration with Verification Document Upload', ngoReg.status === 201 && ngoReg.data.documentUploaded === true);
    ngoToken = ngoReg.data.token;
    ngoOrgId = ngoReg.data.user.orgId;

    // 6. Admin Verification Queue: Verify pending list & Approve newly registered donor & NGO
    const pendingList = await request('/api/admin/pending', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const foundPending = pendingList.data?.orgs?.some(o => o.id === donorOrgId && o.documentUrl);
    record('Admin Verification Queue (Document Inspection)', pendingList.status === 200 && foundPending, `Found uploaded document in queue`);

    const approveDonor = await request(`/api/admin/orgs/${donorOrgId}/approve`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { notes: 'FSSAI License verified and validated via test run.' }
    });
    record('Admin Approve Organization (Donor Activation)', approveDonor.status === 200 && approveDonor.data.newStatus === 'active');

    const approveNgo = await request(`/api/admin/orgs/${ngoOrgId}/approve`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { notes: 'NGO registration cert verified.' }
    });
    record('Admin Approve Organization (NGO Activation)', approveNgo.status === 200 && approveNgo.data.newStatus === 'active');

    // 7. Donor Profile & Post Surplus
    const donorProfile = await request('/api/donor/profile', {
      headers: { Authorization: `Bearer ${donorToken}` }
    });
    record('Donor Get Profile', donorProfile.status === 200 && donorProfile.data.org.status === 'active');

    const postSurplus = await request('/api/donor/surplus', {
      method: 'POST',
      headers: { Authorization: `Bearer ${donorToken}` },
      body: {
        foodName: 'Hot Vegetable Pulav & Dal Fry',
        foodType: 'cooked_meals',
        quantity: 50,
        quantityUnit: 'servings',
        pickupAddress: 'Brigade Road Kitchen Gate 1',
        dietaryTags: ['vegetarian'],
        remainingUsableTime: new Date(Date.now() + 3 * 3600000).toISOString()
      }
    });
    record('Donor Post Surplus', postSurplus.status === 201 && !!postSurplus.data.surplusId);
    testSurplusId = postSurplus.data.surplusId;

    const donorSurplusList = await request('/api/donor/surplus', {
      headers: { Authorization: `Bearer ${donorToken}` }
    });
    record('Donor Surplus List Fetch', donorSurplusList.status === 200 && donorSurplusList.data.posts.length > 0);

    const donorImpact = await request('/api/donor/impact', {
      headers: { Authorization: `Bearer ${donorToken}` }
    });
    record('Donor Impact Statistics', donorImpact.status === 200 && typeof donorImpact.data.totalPosts === 'number');

    const donorPredictions = await request('/api/donor/predictions', {
      headers: { Authorization: `Bearer ${donorToken}` }
    });
    record('Donor Predictions Route', donorPredictions.status === 200 && Array.isArray(donorPredictions.data.patterns));

    // 8. Demand-Org Register Demand & Auto-Matching
    const postDemand = await request('/api/demand-org/demand', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ngoToken}` },
      body: {
        foodRequirement: 'Urgent Evening Meals for 50 People',
        quantityNeeded: 50,
        quantityUnit: 'servings',
        urgency: 'immediate',
        requiredBy: new Date(Date.now() + 2 * 3600000).toISOString()
      }
    });
    record('Demand-Org Register Demand', postDemand.status === 201 && !!postDemand.data.demandId);
    testDemandId = postDemand.data.demandId;

    // Check Matches for NGO
    const ngoMatches = await request('/api/demand-org/matches', {
      headers: { Authorization: `Bearer ${ngoToken}` }
    });
    record('Demand-Org Matches Retrieval', ngoMatches.status === 200 && Array.isArray(ngoMatches.data.matches));

    if (ngoMatches.data.matches.length > 0) {
      testMatchId = ngoMatches.data.matches[0].id;
      const acceptMatch = await request(`/api/demand-org/matches/${testMatchId}/accept`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${ngoToken}` }
      });
      record('Demand-Org Accept Match', acceptMatch.status === 200 && acceptMatch.data.success === true);
    }

    const ngoInsights = await request('/api/demand-org/insights', {
      headers: { Authorization: `Bearer ${ngoToken}` }
    });
    record('Demand-Org Insights Fetch', ngoInsights.status === 200 && typeof ngoInsights.data.total === 'number');

    // 9. Network Intelligence: Test all 9 endpoints
    const netOverview = await request('/api/network/overview', {
      headers: { Authorization: `Bearer ${networkToken}` }
    });
    record('Network Overview (/api/network/overview)', netOverview.status === 200 && typeof netOverview.data.activeSurplus === 'number');

    const netSupplyDemand = await request('/api/network/supply-demand', {
      headers: { Authorization: `Bearer ${networkToken}` }
    });
    record('Network Supply & Demand (/api/network/supply-demand)', netSupplyDemand.status === 200 && Array.isArray(netSupplyDemand.data.surplus));

    const netRedist = await request('/api/network/redistributions', {
      headers: { Authorization: `Bearer ${networkToken}` }
    });
    record('Network Redistributions (/api/network/redistributions)', netRedist.status === 200 && Array.isArray(netRedist.data.redistributions));

    const netRebalance = await request('/api/network/rebalancing', {
      headers: { Authorization: `Bearer ${networkToken}` }
    });
    record('Network Rebalancing Zones (/api/network/rebalancing)', netRebalance.status === 200 && Array.isArray(netRebalance.data.zones));

    const netReserve = await request('/api/network/reserve', {
      headers: { Authorization: `Bearer ${networkToken}` }
    });
    record('Network Reserve Allocation (/api/network/reserve)', netReserve.status === 200 && Array.isArray(netReserve.data.reservePoints));

    const netCommunity = await request('/api/network/community', {
      headers: { Authorization: `Bearer ${networkToken}` }
    });
    record('Network Community Intel (/api/network/community)', netCommunity.status === 200 && Array.isArray(netCommunity.data.surplusHotspots));

    const netWasteRisk = await request('/api/network/waste-risk', {
      headers: { Authorization: `Bearer ${networkToken}` }
    });
    record('Network Waste Risk Analysis (/api/network/waste-risk)', netWasteRisk.status === 200 && Array.isArray(netWasteRisk.data.risks));

    const netInterventions = await request('/api/network/interventions', {
      headers: { Authorization: `Bearer ${networkToken}` }
    });
    record('Network Interventions (/api/network/interventions)', netInterventions.status === 200 && Array.isArray(netInterventions.data.interventions));

    const netMetrics = await request('/api/network/metrics', {
      headers: { Authorization: `Bearer ${networkToken}` }
    });
    record('Network Metrics (/api/network/metrics)', netMetrics.status === 200 && Array.isArray(netMetrics.data.weeklyData));

    // 10. Admin: Test Overview, Participants, Flags, Disputes, and Records
    const adminOverview = await request('/api/admin/overview', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    record('Admin Overview (/api/admin/overview)', adminOverview.status === 200 && typeof adminOverview.data.verifiedCount === 'number');

    const adminParticipants = await request('/api/admin/participants', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    record('Admin Participants List (/api/admin/participants)', adminParticipants.status === 200 && adminParticipants.data.orgs.length >= 4);

    const adminFlags = await request('/api/admin/flags', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    record('Admin Safety Flags (/api/admin/flags)', adminFlags.status === 200 && Array.isArray(adminFlags.data.flags));

    if (adminFlags.data.flags.length > 0) {
      const flagId = adminFlags.data.flags[0].id;
      const closeFlag = await request(`/api/admin/flags/${flagId}/close`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      record('Admin Close Safety Flag', closeFlag.status === 200);
    }

    const adminDisputes = await request('/api/admin/disputes', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    record('Admin Disputes (/api/admin/disputes)', adminDisputes.status === 200 && Array.isArray(adminDisputes.data.disputes));

    const adminRecords = await request('/api/admin/records', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    record('Admin Audit Records (/api/admin/records)', adminRecords.status === 200 && adminRecords.data.records.length > 0);

    // 11. Notifications Delivery Receipts Audit
    const deliveries = await request('/api/notifications/deliveries', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    record('Notification Delivery Audit Receipts (/api/notifications/deliveries)', deliveries.status === 200 && Array.isArray(deliveries.data.deliveries));

    // Summary
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`📊 Test Summary: ${passed} / ${total} Tests Passed (${Math.round((passed / total) * 100)}%)`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    process.exit(passed === total ? 0 : 1);
  } catch (err) {
    console.error('\n❌ Unexpected error running tests:', err);
    process.exit(1);
  }
}

run();
