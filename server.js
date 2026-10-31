import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import admin from 'firebase-admin';
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import {
  notificationService,
  validateAndNormalizeIndianPhone,
  maskPhoneNumber,
  getNotificationConfigStatus
} from './notification_service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3500;
const DB_PATH = path.join(__dirname, 'data', 'rec_transport_database.json');

// --- Firebase Admin Initialization ---
try {
  const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    if (getApps().length === 0) {
      initializeApp({
        credential: cert(serviceAccount)
      });
    }
    console.log('[Server] Firebase Admin SDK initialized successfully');
  } else {
    console.warn('[Server] serviceAccountKey.json not found. Push notifications will be disabled.');
  }
} catch (err) {
  console.error('[Server] Firebase Admin Initialization Error:', err.message);
}

app.use(cors());
app.use(express.json());

// --- Real-Time Telemetry Event Broadcaster (SSE) ---
const sseClients = new Set();
const activeDriverSessions = new Map(); // token -> { busId, busNumber, createdAt }

function broadcastSSE(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

// SSE Keep-alive heartbeat every 15s to keep connections alive across mobile & proxies
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': keepalive\n\n');
    } catch (err) {
      sseClients.delete(client);
    }
  }
}, 15000);

// Helper to safely read database
function readDatabase() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return { buses: [], routes: [], stops: [] };
    }
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading database:', err);
    return { buses: [], routes: [], stops: [] };
  }
}

// Helper to atomically save database
function writeDatabase(data) {
  try {
    data.lastSyncTimestamp = new Date().toISOString();
    const tmpPath = DB_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, DB_PATH);
    return true;
  } catch (err) {
    console.error('Error writing database:', err);
    return false;
  }
}

function findBusIndex(db, identifier) {
  if (!identifier) return -1;
  const raw = String(identifier).toLowerCase().trim();
  const clean = raw.replace(/^(bus[-_]|rec_bus_)/, '');
  return db.buses.findIndex(b => {
    const bId = (b.busId || '').toLowerCase();
    const bNum = (b.busNumber || '').toLowerCase();
    const bClean = bId.replace(/^(bus[-_]|rec_bus_)/, '');
    return bId === raw || bNum === raw || bNum === clean || bClean === clean;
  });
}

/**
 * Calculates Haversine distance in kilometers between two GPS coordinates
 */
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lon1 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Gets or initializes student notification profile
 */
function getStudentProfile(db) {
  if (!db.studentNotificationProfile) {
    db.studentNotificationProfile = {
      name: 'Rithvik S',
      phoneNumber: '+919876543210',
      fcmToken: null,
      busId: 'rec_bus_10c',
      busNumber: '10C',
      pickupPointId: 'stop_main_gate',
      pickupPointName: 'Main Campus Entrance Gate (NH 48)',
      smsEnabled: true,
      lastNotification: null
    };
    writeDatabase(db);
  }
  return db.studentNotificationProfile;
}

/**
 * Evaluates live telemetry for approaching alerts and triggers NOTIFICATION if within window.
 */
async function checkStudentNotificationsForBus(db, bus, isLive) {
  try {
    const student = getStudentProfile(db);
    if (!student || student.smsEnabled === false) return;

    // Check if student is assigned to this bus
    const isAssigned =
      (student.busId && (student.busId.toLowerCase() === (bus.busId || '').toLowerCase() || student.busId.toLowerCase() === (bus.busNumber || '').toLowerCase())) ||
      (student.busNumber && student.busNumber.toLowerCase() === (bus.busNumber || '').toLowerCase());

    if (!isAssigned) return;

    // Reset notification state if trip stopped or bus is not live
    if (isLive === false || bus.status !== 'LIVE') {
      notificationService.resetState(bus.busId, student.phoneNumber || student.fcmToken, student.pickupPointName);
      return;
    }

    if (bus.lastLatitude === null || bus.lastLongitude === null) return;

    // Find pickup stop
    let stop = db.stops?.find(s => s.stopId === student.pickupPointId || s.stopName === student.pickupPointName);
    if (!stop && db.stops && db.stops.length > 0) {
      stop = db.stops[0];
    }
    if (!stop || stop.latitude == null || stop.longitude == null) return;

    // Compute approximate distance and ETA in minutes
    const distKm = haversineDistanceKm(bus.lastLatitude, bus.lastLongitude, stop.latitude, stop.longitude);
    const effectiveSpeed = (bus.speed && bus.speed > 5) ? bus.speed : 22; // 22 km/h average transit speed
    const etaMinutes = Number(((distKm / effectiveSpeed) * 60).toFixed(1));

    // Evaluate notification rules & deduplication
    const target = student.fcmToken || student.phoneNumber;
    const isToken = !!student.fcmToken;

    const result = await notificationService.evaluateAndTriggerNotification({
      target,
      busId: bus.busId,
      busNumber: bus.busNumber,
      pickupPoint: stop.stopName,
      etaMinutes,
      studentId: student.name,
      isToken
    });

    if (result.action === 'SENT_10_MIN' || result.action === 'SENT_5_MIN') {
      student.lastNotification = {
        alertType: result.action === 'SENT_10_MIN' ? '10_MIN' : '5_MIN',
        etaMinutes,
        timestamp: new Date().toISOString(),
        pickupPoint: stop.stopName,
        busNumber: bus.busNumber,
        status: result.details.notifResult?.status || (result.details.notifResult?.success ? 'queued' : 'failed'),
        messageSid: result.details.notifResult?.messageSid || null,
        error: result.details.notifResult?.error || null
      };
      writeDatabase(db);

      broadcastSSE('STUDENT_NOTIFICATION_EVENT', {
        action: result.action,
        studentName: student.name,
        busNumber: bus.busNumber,
        pickupPoint: stop.stopName,
        etaMinutes,
        timestamp: new Date().toISOString(),
        notifResult: result.details.notifResult,
        student: {
          ...student,
          maskedPhone: maskPhoneNumber(student.phoneNumber)
        }
      });
    }
  } catch (err) {
    console.error('[Notif Telemetry Hook] Error in notification evaluation:', err.message);
  }
}

// Heartbeat timeout sweeper for server-verified live status (runs every 5 seconds)
setInterval(() => {
  const db = readDatabase();
  let modified = false;
  const now = Date.now();

  for (const bus of db.buses) {
    if (bus.status === 'LIVE') {
      const lastUpdate = bus.lastGpsUpdate ? new Date(bus.lastGpsUpdate).getTime() : 0;
      if (now - lastUpdate > 20000) { // 20s timeout
        bus.status = 'LAST_KNOWN';
        bus.speed = 0;
        bus.updatedAt = new Date().toISOString();
        modified = true;
        broadcastSSE('BUS_STATUS_CHANGED', {
          busId: bus.busId,
          busNumber: bus.busNumber,
          status: 'LAST_KNOWN',
          reason: 'heartbeat_timeout',
          bus: bus
        });
      }
    }
  }

  if (modified) {
    writeDatabase(db);
  }
}, 5000);

// --- REST API Endpoints ---

// GET /api/status
app.get('/api/status', (req, res) => {
  const db = readDatabase();
  const notifStatus = getNotificationConfigStatus();
  res.json({
    online: true,
    system: db.system || 'Rajalakshmi Engineering College (REC) Transport System',
    campus: db.campus || 'REC Thandalam Campus',
    serverTime: new Date().toISOString(),
    totalBuses: db.buses.length,
    activeBuses: db.buses.filter(b => b.isActive).length,
    totalRoutes: db.routes.length,
    totalStops: db.stops ? db.stops.length : 0,
    sseConnectedClients: sseClients.size,
    notificationSystem: {
      firebaseConfigured: notifStatus.firebase.configured,
      twilioConfigured: notifStatus.twilio.configured,
      missingFirebase: notifStatus.firebase.missing,
      missingTwilio: notifStatus.twilio.missing,
      fromId: notifStatus.twilio.fromId
    }
  });
});

// GET /api/transport/stream (Server-Sent Events for real-time live telemetry)
app.get('/api/transport/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write(`event: connected\\ndata: ${JSON.stringify({ time: new Date().toISOString(), system: 'REC Transport Live Telemetry Stream' })}\\n\\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// GET /api/transport/live (Authoritative current live bus snapshot)
app.get('/api/transport/live', (req, res) => {
  const db = readDatabase();
  const liveBuses = db.buses
    .filter(b => b.isActive !== false)
    .map(b => ({
      busId: b.busId,
      busNumber: b.busNumber,
      status: b.status,
      lastLatitude: b.lastLatitude,
      lastLongitude: b.lastLongitude,
      speed: b.speed || 0,
      heading: b.heading || 0,
      accuracy: b.accuracy || 0,
      lastGpsUpdate: b.lastGpsUpdate,
      parkingBay: b.parkingBay,
      mapX: b.mapX,
      mapY: b.mapY
    }));
  res.json({ count: liveBuses.length, buses: liveBuses, timestamp: new Date().toISOString() });
});

// POST /api/driver/session (Authenticate and authorize driver for a specific bus)
app.post('/api/driver/session', (req, res) => {
  const db = readDatabase();
  const { busId } = req.body;
  if (!busId) {
    return res.status(400).json({ error: 'busId is required to start driver session' });
  }

  const idx = findBusIndex(db, busId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Bus not found' });
  }

  const bus = db.buses[idx];
  if (bus.isActive === false) {
    return res.status(403).json({ error: 'Cannot start session for inactive bus' });
  }

  const token = crypto.randomUUID();
  activeDriverSessions.set(token, {
    busId: bus.busId,
    busNumber: bus.busNumber,
    createdAt: Date.now()
  });

  res.json({
    success: true,
    token: token,
    busId: bus.busId,
    busNumber: bus.busNumber,
    driver: bus.driver,
    route: bus.routeName || bus.route
  });
});

// GET /api/transport/calibration
app.get('/api/transport/calibration', (req, res) => {
  const db = readDatabase();
  res.json(db.calibration || {
    topLeft: { latitude: 13.013000, longitude: 80.000000 },
    topRight: { latitude: 13.013000, longitude: 80.006200 },
    bottomLeft: { latitude: 13.006800, longitude: 80.000000 },
    bottomRight: { latitude: 13.006800, longitude: 80.006200 },
    isVerified: true
  });
});

// PUT /api/transport/calibration
app.put('/api/transport/calibration', (req, res) => {
  const db = readDatabase();
  const { topLeft, topRight, bottomLeft, bottomRight } = req.body;
  if (!topLeft || !topRight || !bottomLeft || !bottomRight) {
    return res.status(400).json({ error: 'All 4 corner points (topLeft, topRight, bottomLeft, bottomRight) are required' });
  }

  db.calibration = {
    topLeft,
    topRight,
    bottomLeft,
    bottomRight,
    isVerified: true,
    lastCalibratedAt: new Date().toISOString()
  };

  writeDatabase(db);
  broadcastSSE('CALIBRATION_UPDATED', db.calibration);
  res.json({ success: true, calibration: db.calibration });
});

// GET /api/buses
app.get('/api/buses', (req, res) => {
  const db = readDatabase();
  const includeInactive = req.query.includeInactive === 'true';
  const statusFilter = req.query.status ? req.query.status.toUpperCase() : null;
  const searchQuery = req.query.search ? req.query.search.trim().toLowerCase() : null;
  const routeFilter = req.query.route ? req.query.route.trim().toLowerCase() : null;
  const campusFilter = req.query.campus ? req.query.campus.trim().toLowerCase() : null;

  let results = db.buses;

  if (!includeInactive) {
    results = results.filter(b => b.isActive !== false);
  }

  if (statusFilter && statusFilter !== 'ALL') {
    results = results.filter(b => (b.status || '').toUpperCase() === statusFilter);
  }

  if (campusFilter) {
    results = results.filter(b => (b.campus || '').toLowerCase().includes(campusFilter));
  }

  if (routeFilter) {
    results = results.filter(b =>
      (b.routeId && b.routeId.toLowerCase().includes(routeFilter)) ||
      (b.routeName && b.routeName.toLowerCase().includes(routeFilter))
    );
  }

  if (searchQuery) {
    results = results.filter(b =>
      (b.busNumber && b.busNumber.toLowerCase().includes(searchQuery)) ||
      (b.routeName && b.routeName.toLowerCase().includes(searchQuery)) ||
      (b.registrationNumber && b.registrationNumber.toLowerCase().includes(searchQuery)) ||
      (b.parkingBay && b.parkingBay.toLowerCase().includes(searchQuery))
    );
  }

  res.json(results);
});

// GET /api/buses/:id
app.get('/api/buses/:id', (req, res) => {
  const db = readDatabase();
  const idx = findBusIndex(db, req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Bus not found' });
  }
  res.json(db.buses[idx]);
});

// POST /api/buses (Create bus)
app.post('/api/buses', (req, res) => {
  const db = readDatabase();
  const b = req.body;
  if (!b.busNumber) {
    return res.status(400).json({ error: 'busNumber is required' });
  }

  const existing = db.buses.find(item => item.busNumber.toLowerCase() === b.busNumber.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: `Bus ${b.busNumber} already exists in database` });
  }

  const now = new Date().toISOString();
  const newBus = {
    busId: b.busId || `rec_bus_${b.busNumber.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    busNumber: b.busNumber,
    registrationNumber: b.registrationNumber || '',
    campus: b.campus || 'REC Thandalam Campus',
    routeId: b.routeId || `route_${b.busNumber.toLowerCase()}`,
    routeName: b.routeName || `Route ${b.busNumber}`,
    busType: b.busType || 'Standard Transit',
    capacity: Number(b.capacity) || 55,
    driver: b.driver || '',
    driverContact: b.driverContact || '',
    conductor: b.conductor || '',
    conductorContact: b.conductorContact || '',
    morningTrip: b.morningTrip || '',
    returnTrip: b.returnTrip || '',
    boardingPoints: b.boardingPoints || '',
    departureTime: b.departureTime || '',
    arrivalTime: b.arrivalTime || '',
    status: b.status || 'STATIC',
    isActive: b.isActive !== undefined ? Boolean(b.isActive) : true,
    mapX: b.mapX !== undefined ? Number(b.mapX) : null,
    mapY: b.mapY !== undefined ? Number(b.mapY) : null,
    parkingBay: b.parkingBay || '',
    lastLatitude: b.lastLatitude !== undefined ? b.lastLatitude : null,
    lastLongitude: b.lastLongitude !== undefined ? b.lastLongitude : null,
    lastGpsUpdate: b.lastGpsUpdate || null,
    stopLocationId: b.stopLocationId || 'GATE-01',
    createdAt: now,
    updatedAt: now
  };

  db.buses.push(newBus);
  writeDatabase(db);
  broadcastSSE('BUS_CREATED', newBus);
  res.status(201).json(newBus);
});

// PUT /api/buses/:id (Update bus)
app.put('/api/buses/:id', (req, res) => {
  const db = readDatabase();
  const idx = findBusIndex(db, req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Bus not found' });
  }

  const existing = db.buses[idx];
  const updated = {
    ...existing,
    ...req.body,
    busId: existing.busId, // preserve canonical ID
    updatedAt: new Date().toISOString()
  };

  db.buses[idx] = updated;
  writeDatabase(db);
  broadcastSSE('BUS_UPDATED', updated);
  res.json(updated);
});

// PATCH /api/buses/:id/position (Persist normalized X/Y coordinates)
app.patch('/api/buses/:id/position', (req, res) => {
  const db = readDatabase();
  const idx = findBusIndex(db, req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Bus not found' });
  }

  const { mapX, mapY, parkingBay } = req.body;
  if (mapX === undefined || mapY === undefined) {
    return res.status(400).json({ error: 'mapX and mapY normalized coordinates required (0.0 to 1.0)' });
  }

  const parsedX = Math.max(0.0, Math.min(1.0, parseFloat(mapX)));
  const parsedY = Math.max(0.0, Math.min(1.0, parseFloat(mapY)));

  db.buses[idx].mapX = parsedX;
  db.buses[idx].mapY = parsedY;
  if (parkingBay) db.buses[idx].parkingBay = parkingBay;
  db.buses[idx].updatedAt = new Date().toISOString();

  writeDatabase(db);
  broadcastSSE('BUS_POSITION_UPDATED', db.buses[idx]);

  res.json({
    success: true,
    busId: db.buses[idx].busId,
    busNumber: db.buses[idx].busNumber,
    mapX: parsedX,
    mapY: parsedY,
    parkingBay: db.buses[idx].parkingBay
  });
});

// POST /api/buses/:id/telemetry (Real GPS Telemetry from Driver Cockpit)
app.post('/api/buses/:id/telemetry', (req, res) => {
  const db = readDatabase();
  const idx = findBusIndex(db, req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Bus not found' });
  }

  const bus = db.buses[idx];
  if (bus.isActive === false) {
    return res.status(403).json({ error: 'Cannot transmit telemetry for inactive bus' });
  }

  // Driver session token check if provided
  const authHeader = req.headers.authorization;
  const token = req.headers['x-driver-token'] || (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.body.token);
  if (token && activeDriverSessions.has(token)) {
    const session = activeDriverSessions.get(token);
    if (session.busId !== bus.busId) {
      return res.status(403).json({ error: 'Driver session is not authorized for this bus' });
    }
  }

  const { latitude, longitude, speed, heading, accuracy, isLive, parkingBay } = req.body;
  const now = new Date().toISOString();

  // Validate coordinates
  if (latitude !== undefined && longitude !== undefined && latitude !== null && longitude !== null) {
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lon) || !isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({ error: 'Invalid coordinates: latitude and longitude must be finite numbers' });
    }

    // Acceptable REC transport operating region: Tamil Nadu / Chennai / Kanchipuram / Thiruvallur
    if (lat < 12.0 || lat > 14.5 || lon < 78.5 || lon > 81.5) {
      return res.status(400).json({ error: 'Coordinates outside REC transport operational region (12.0-14.5° N, 78.5-81.5° E)' });
    }

    db.buses[idx].lastLatitude = lat;
    db.buses[idx].lastLongitude = lon;
    db.buses[idx].lastGpsUpdate = now;
  }

  if (speed !== undefined && speed !== null) {
    const sp = Number(speed);
    if (!isNaN(sp) && isFinite(sp) && sp >= 0 && sp <= 150) {
      db.buses[idx].speed = sp;
    }
  }

  if (heading !== undefined && heading !== null) {
    const hd = Number(heading);
    if (!isNaN(hd) && isFinite(hd) && hd >= 0 && hd <= 360) {
      db.buses[idx].heading = hd;
    }
  }

  if (accuracy !== undefined && accuracy !== null) {
    const acc = Number(accuracy);
    if (!isNaN(acc) && isFinite(acc) && acc > 0) {
      db.buses[idx].accuracy = acc;
    }
  }

  if (parkingBay && typeof parkingBay === 'string') {
    db.buses[idx].parkingBay = parkingBay.trim();
  }

  // Server-verified status hierarchy:
  // LIVE if active broadcast and valid GPS, LAST_KNOWN when broadcast ended, STATIC if no GPS history
  if (isLive === true && db.buses[idx].lastLatitude !== null) {
    db.buses[idx].status = 'LIVE';
  } else if (isLive === false) {
    db.buses[idx].status = db.buses[idx].lastLatitude !== null ? 'LAST_KNOWN' : 'STATIC';
    db.buses[idx].speed = 0;
  }

  db.buses[idx].updatedAt = now;
  writeDatabase(db);

  // Broadcast real-time live telemetry to connected students
  broadcastSSE('BUS_TELEMETRY', {
    busId: db.buses[idx].busId,
    busNumber: db.buses[idx].busNumber,
    status: db.buses[idx].status,
    latitude: db.buses[idx].lastLatitude,
    longitude: db.buses[idx].lastLongitude,
    speed: db.buses[idx].speed || 0,
    heading: db.buses[idx].heading || 0,
    accuracy: db.buses[idx].accuracy || 0,
    lastGpsUpdate: db.buses[idx].lastGpsUpdate,
    parkingBay: db.buses[idx].parkingBay,
    bus: db.buses[idx]
  });

  // Evaluate student approaching alerts and trigger NOTIFICATION if applicable
  checkStudentNotificationsForBus(db, db.buses[idx], isLive).catch(err => {
    console.error('[Telemetry] Error in student notification check:', err.message);
  });

  res.json({ success: true, bus: db.buses[idx] });
});

// DELETE /api/buses/:id (Deactivate or remove)
app.delete('/api/buses/:id', (req, res) => {
  const db = readDatabase();
  const idx = findBusIndex(db, req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Bus not found' });
  }

  const bus = db.buses[idx];

  // Support hard delete with ?hard=true, otherwise soft delete (isActive = false)
  if (req.query.hard === 'true') {
    const deleted = db.buses.splice(idx, 1)[0];
    writeDatabase(db);
    broadcastSSE('BUS_DELETED', { busId: deleted.busId, busNumber: deleted.busNumber });
    return res.json({ success: true, message: `Bus ${deleted.busNumber} deleted`, bus: deleted });
  } else {
    db.buses[idx].isActive = false;
    db.buses[idx].status = 'INACTIVE';
    db.buses[idx].updatedAt = new Date().toISOString();
    writeDatabase(db);
    broadcastSSE('BUS_STATUS_CHANGED', { busId: bus.busId, busNumber: bus.busNumber, status: 'INACTIVE', bus: db.buses[idx] });
    return res.json({ success: true, message: `Bus ${db.buses[idx].busNumber} deactivated`, bus: db.buses[idx] });
  }
});

// GET /api/routes
app.get('/api/routes', (req, res) => {
  const db = readDatabase();
  res.json(db.routes || []);
});

// GET /api/stops
app.get('/api/stops', (req, res) => {
  const db = readDatabase();
  res.json(db.stops || []);
});

// =========================================================================
// NOTIFICATION SYSTEM ENDPOINTS
// =========================================================================

// GET /api/notifications/config (Returns notification configuration status)
app.get('/api/notifications/config', (req, res) => {
  const status = getNotificationConfigStatus();
  res.json({
    firebaseConfigured: status.firebase.configured,
    twilioConfigured: status.twilio.configured,
    missingFirebase: status.firebase.missing,
    missingTwilio: status.twilio.missing,
    fromNumber: status.twilio.fromId ? maskPhoneNumber(status.twilio.fromId) : null
  });
});

// GET /api/student/notification-profile (Returns current student's notification preferences)
app.get('/api/student/notification-profile', (req, res) => {
  const db = readDatabase();
  const profile = getStudentProfile(db);
  const notifStatus = getNotificationConfigStatus();
  res.json({
    ...profile,
    maskedPhone: maskPhoneNumber(profile.phoneNumber),
    firebaseConfigured: notifStatus.firebase.configured,
    twilioConfigured: notifStatus.twilio.configured,
    fromNumber: notifStatus.twilio.fromId ? maskPhoneNumber(notifStatus.twilio.fromId) : null
  });
});

// POST /api/student/notification-profile (Updates student's notification preferences)
app.post('/api/student/notification-profile', (req, res) => {
  const db = readDatabase();
  const { name, phoneNumber, busId, busNumber, pickupPointId, pickupPointName, smsEnabled } = req.body;

  let validatedPhone = null;
  if (phoneNumber) {
    const val = validateAndNormalizeIndianPhone(phoneNumber);
    if (!val.isValid) {
      return res.status(400).json({ error: val.error });
    }
    validatedPhone = val.e164;
  }

  const current = getStudentProfile(db);
  if (name !== undefined) current.name = String(name).trim();
  if (validatedPhone) current.phoneNumber = validatedPhone;
  if (busId !== undefined) current.busId = busId;
  if (busNumber !== undefined) current.busNumber = busNumber;
  if (pickupPointId !== undefined) current.pickupPointId = pickupPointId;
  if (pickupPointName !== undefined) current.pickupPointName = pickupPointName;
  if (smsEnabled !== undefined) current.smsEnabled = Boolean(smsEnabled);

  writeDatabase(db);
  broadcastSSE('STUDENT_PROFILE_UPDATED', {
    ...current,
    maskedPhone: maskPhoneNumber(current.phoneNumber)
  });

  res.json({
    success: true,
    profile: {
      ...current,
      maskedPhone: maskPhoneNumber(current.phoneNumber)
    }
  });
});

// POST /api/student/register-fcm-token (Saves FCM device token to student profile)
app.post('/api/student/register-fcm-token', (req, res) => {
  const db = readDatabase();
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'fcmToken is required' });

  const profile = getStudentProfile(db);
  profile.fcmToken = token;
  writeDatabase(db);

  res.json({ success: true, message: 'FCM token registered successfully' });
});

// POST /api/sms/test (Sends a real test notification)
app.post('/api/sms/test', async (req, res) => {
  const { phoneNumber, busNumber, pickupPoint, isToken, token } = req.body;
  const target = token || phoneNumber;
  if (!target) {
    return res.status(400).json({ error: 'Target (phone or token) is required' });
  }

  // AUTO-DETECT: If target is long, it's a token, not a phone number
  const detectedIsToken = isToken || !!token || (target.length > 20);

  const result = await notificationService.sendBusApproachingNotif({
    target,
    busNumber: busNumber || '10C',
    pickupPoint: pickupPoint || 'Main Campus Entrance Gate (NH 48)',
    alertType: 'TEST',
    customMessage: `ACIMS Alert: Real test notification verified for Bus ${busNumber || '10C'} approaching ${pickupPoint || 'Main Campus Entrance Gate (NH 48)'}. Notification service is active.`,
    isToken: detectedIsToken
  });

  res.json(result);
});

// POST /api/sms/simulate-eta (Runs the 12 -> 10 -> 9 -> 5 -> 4 ETA progression test)
app.post('/api/sms/simulate-eta', async (req, res) => {
  const db = readDatabase();
  const profile = getStudentProfile(db);
  const { phoneNumber, busNumber, pickupPoint, sendRealNotif, etaSequence, isToken, token } = req.body;

  const target = token || phoneNumber || profile.phoneNumber || profile.fcmToken;
  if (!target) {
    return res.status(400).json({ error: 'Target is required for simulation' });
  }

  const results = await notificationService.simulateEtaProgression({
    target,
    busNumber: busNumber || profile.busNumber || '10C',
    busId: profile.busId || 'rec_bus_10c',
    pickupPoint: pickupPoint || profile.pickupPointName || 'Main Campus Entrance Gate (NH 48)',
    sendRealNotif: Boolean(sendRealNotif),
    etaSequence: Array.isArray(etaSequence) ? etaSequence : [12, 10, 9, 5, 4],
    isToken: isToken || !!token
  });

  res.json({
    success: true,
    simulation: results
  });
});

// GET /api/notifications/logs (Returns audit log of all notification activity)
app.get('/api/notifications/logs', (req, res) => {
  res.json({
    logs: notificationService.getAuditLog()
  });
});

// POST /api/notifications/reset (Resets notification deduplication state)
app.post('/api/notifications/reset', (req, res) => {
  notificationService.clearAllStates();
  res.json({ success: true, message: 'All notification deduplication states reset.' });
});

// Static assets serving
app.use(express.static(__dirname));

// Serve index.html as fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[REC Transport Server] Running at http://localhost:${PORT}`);
  console.log(`[REC Transport Server] REST API available at http://localhost:${PORT}/api/buses`);
  console.log(`[REC Transport Server] Real-time SSE stream at http://localhost:${PORT}/api/transport/stream`);
  const notifStatus = getNotificationConfigStatus();
  if (notifStatus.firebase.configured) {
    console.log(`[Notification Service] Firebase Push active.`);
  } else {
    console.log(`[Notification Service] Firebase not configured: ${notifStatus.firebase.missing.join(', ')}`);
  }
});
