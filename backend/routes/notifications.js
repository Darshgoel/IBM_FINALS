const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { addSseClient, getDeliveries, dispatchNotification } = require('../services/notifications');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/notifications/stream?token=<jwt>
 * SSE endpoint for live push notifications to dashboards
 */
router.get('/stream', (req, res) => {
  const token = req.query.token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  let user = null;

  if (token) {
    try {
      user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      // Allow anonymous connection or proceed with null
    }
  }

  // Required SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write(': connected to FoodBridge notification stream\n\n');

  const clientId = uuidv4();
  addSseClient(clientId, res, user);
});

/**
 * GET /api/notifications/deliveries
 * Audit notification delivery receipts (Email & Push logs)
 */
router.get('/deliveries', authenticate, (req, res) => {
  try {
    const isOps = ['admin', 'network_admin', 'network_intelligence'].includes(req.user.role);
    const orgId = isOps ? req.query.orgId || null : req.user.orgId;
    const deliveries = getDeliveries(orgId, 50);
    res.json({ deliveries });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch deliveries' });
  }
});

/**
 * POST /api/notifications/test
 * Send a test broadcast / notification
 */
router.post('/test', authenticate, (req, res) => {
  try {
    const { title, message, type } = req.body;
    const result = dispatchNotification({
      orgId: req.user.orgId,
      userId: req.user.id,
      role: req.user.role,
      type: type || 'system',
      title: title || '🔔 Test Notification',
      message: message || 'This is a live notification test from FoodBridge network.',
      data: { test: true }
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to dispatch test notification' });
  }
});

module.exports = router;
