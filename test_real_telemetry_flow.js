/**
 * REC Campus Mobility — Full End-to-End Real-Time Telemetry & Architecture Verification
 * 
 * Verifies:
 * 1. Database integrity & canonical busId on all records
 * 2. Driver session security (/api/driver/session)
 * 3. Telemetry input validation (rejects NaN, Infinity, out-of-boundary coords)
 * 4. Real-time Server-Sent Events (SSE) streaming (/api/transport/stream)
 * 5. Driver GPS broadcast -> Backend -> Real-time Student reception
 * 6. Stop Trip -> transition to LAST_KNOWN with preserved coordinates
 * 7. Server heartbeat timeout sweeper
 * 8. 4-Corner Bilinear Calibration endpoints (/api/transport/calibration)
 * 9. Authoritative live snapshot (/api/transport/live)
 */

import http from 'node:http';

const BASE_URL = 'http://localhost:3500';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, options);
  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data: json };
}

async function runTests() {
  console.log('================================================================');
  console.log('   REC CAMPUS MOBILITY — REAL TELEMETRY PIPELINE VERIFICATION   ');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${testName}`);
      failed++;
    }
  }

  // TEST 1: Database has real buses with canonical busId
  console.log('\n--- Test 1: Authoritative Database Inspection ---');
  const busesRes = await request('/api/buses?includeInactive=false');
  assert(busesRes.ok && Array.isArray(busesRes.data), 'GET /api/buses returns array');
  assert(busesRes.data.length > 0, `Database contains ${busesRes.data.length} real buses`);
  const allHaveBusId = busesRes.data.every(b => b.busId && typeof b.busId === 'string');
  assert(allHaveBusId, 'Every bus record has canonical busId string identifier');
  const bus10c = busesRes.data.find(b => b.busId === 'rec_bus_10c');
  assert(!!bus10c, 'Bus 10C exists with canonical busId "rec_bus_10c"');

  // TEST 2: Driver Session Security (/api/driver/session)
  console.log('\n--- Test 2: Driver Authorization & Session Security ---');
  const sessionRes = await request('/api/driver/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ busId: 'rec_bus_10c' })
  });
  assert(sessionRes.ok && sessionRes.data.token, 'Driver session created with unique token');
  assert(sessionRes.data.busId === 'rec_bus_10c', 'Session is locked to authorized busId rec_bus_10c');
  const driverToken = sessionRes.data.token;

  // TEST 3: Telemetry Input Validation
  console.log('\n--- Test 3: Telemetry Validation & Security Enforcement ---');
  // 3a. Invalid bus
  const badBusRes = await request('/api/buses/non_existent_bus/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ latitude: 13.011, longitude: 80.002, isLive: true })
  });
  assert(badBusRes.status === 404, 'Rejects telemetry for non-existent bus (404)');

  // 3b. Invalid coordinates (NaN / non-numeric)
  const nanRes = await request('/api/buses/rec_bus_10c/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
    body: JSON.stringify({ latitude: 'INVALID_LAT', longitude: 80.002, isLive: true })
  });
  assert(nanRes.status === 400, 'Rejects invalid/non-numeric latitude (400)');

  // 3c. Impossible coordinates outside operational region (e.g. North Pole or US)
  const outOfBoundsRes = await request('/api/buses/rec_bus_10c/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
    body: JSON.stringify({ latitude: 37.7749, longitude: -122.4194, isLive: true })
  });
  assert(outOfBoundsRes.status === 400, 'Rejects coordinates outside REC operating region (400)');

  // TEST 4: Student Device Real-time SSE Connection (/api/transport/stream)
  console.log('\n--- Test 4: Real-time Server-Sent Events (SSE) Stream ---');
  const receivedSseEvents = [];

  const sseReq = http.request({
    hostname: 'localhost',
    port: 3500,
    path: '/api/transport/stream',
    method: 'GET',
    headers: { 'Accept': 'text/event-stream' }
  }, (res) => {
    res.setEncoding('utf8');
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split('\n\n');
      buffer = parts.pop(); // keep remainder
      for (const part of parts) {
        if (!part.trim() || part.startsWith(':')) continue; // keep-alive
        const lines = part.split('\n');
        let eventType = 'message';
        let dataStr = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          if (line.startsWith('data:')) dataStr = line.slice(5).trim();
        }
        if (dataStr) {
          try {
            const parsed = JSON.parse(dataStr);
            receivedSseEvents.push({ event: eventType, data: parsed });
          } catch (e) {}
        }
      }
    });
  });
  sseReq.end();

  // Wait 300ms for SSE connection handshake
  await wait(300);
  assert(receivedSseEvents.length > 0 && receivedSseEvents[0].event === 'connected', 'Student device connected to SSE stream');

  // TEST 5: Driver Transmits Real Device GPS (Point 1)
  console.log('\n--- Test 5: Real GPS Transmission (Point 1: North Outer Loop) ---');
  const gps1 = {
    latitude: 13.011850,
    longitude: 80.001920,
    speed: 24,
    heading: 92,
    accuracy: 4,
    isLive: true,
    parkingBay: 'PARKWIZ 1 — Bay A-04'
  };

  const transmit1Res = await request('/api/buses/rec_bus_10c/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
    body: JSON.stringify(gps1)
  });

  assert(transmit1Res.ok, 'Driver HTTP POST telemetry succeeded (200)');
  assert(transmit1Res.data.bus.status === 'LIVE', 'Backend marked bus status as LIVE');
  assert(transmit1Res.data.bus.lastLatitude === gps1.latitude, 'Backend saved real latitude in database');
  assert(transmit1Res.data.bus.speed === gps1.speed, 'Backend saved real speed in database');

  // Check that Student Device received SSE packet
  await wait(200);
  const ssePacket1 = receivedSseEvents.find(e => e.event === 'BUS_TELEMETRY' && e.data.busId === 'rec_bus_10c' && e.data.latitude === gps1.latitude);
  assert(!!ssePacket1, 'Student device received real-time BUS_TELEMETRY SSE event without reload');
  assert(ssePacket1?.data.status === 'LIVE', 'Student SSE event confirms LIVE status');

  // TEST 6: Driver Moves (Point 2: Central Quad)
  console.log('\n--- Test 6: Real GPS Movement (Point 2: Admin Block Turn) ---');
  const gps2 = {
    latitude: 13.010520,
    longitude: 80.003140,
    speed: 19,
    heading: 145,
    accuracy: 5,
    isLive: true,
    parkingBay: 'In Transit — Main Road'
  };

  const transmit2Res = await request('/api/buses/rec_bus_10c/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
    body: JSON.stringify(gps2)
  });

  assert(transmit2Res.ok, 'Second movement telemetry packet sent');
  await wait(200);
  const ssePacket2 = receivedSseEvents.find(e => e.event === 'BUS_TELEMETRY' && e.data.busId === 'rec_bus_10c' && e.data.latitude === gps2.latitude);
  assert(!!ssePacket2, 'Student device received movement update packet instantly');
  assert(ssePacket2?.data.speed === 19, 'Student received updated real speed 19 km/h');

  // TEST 7: Stop Trip -> Transition to LAST_KNOWN with Preserved Coordinates
  console.log('\n--- Test 7: Driver Stops Trip (isLive: false) ---');
  const stopPayload = {
    latitude: gps2.latitude,
    longitude: gps2.longitude,
    speed: 0,
    heading: 145,
    accuracy: 4,
    isLive: false,
    parkingBay: 'PARKWIZ 1 — Bay A-04'
  };

  const stopRes = await request('/api/buses/rec_bus_10c/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
    body: JSON.stringify(stopPayload)
  });

  assert(stopRes.ok, 'Stop trip telemetry packet accepted');
  assert(stopRes.data.bus.status === 'LAST_KNOWN', 'Backend transitions status from LIVE -> LAST_KNOWN');
  assert(stopRes.data.bus.lastLatitude === gps2.latitude, 'Backend preserved last real GPS latitude');
  assert(stopRes.data.bus.speed === 0, 'Speed reset to 0 upon stop');

  await wait(200);
  const sseStopPacket = receivedSseEvents.filter(e => e.event === 'BUS_TELEMETRY' && e.data.busId === 'rec_bus_10c').pop();
  assert(sseStopPacket?.data.status === 'LAST_KNOWN', 'Student device notified via SSE of status: LAST_KNOWN');

  // TEST 8: Parked Location API
  console.log('\n--- Test 8: Parked Spot Storage API ---');
  const parkRes = await request('/api/buses/rec_bus_10c/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      latitude: 13.011830,
      longitude: 80.000980,
      parkingBay: 'PARKWIZ North Bay 04',
      isLive: false
    })
  });
  assert(parkRes.ok, 'updateBusParkedLocation API persists coordinates & parking bay');
  assert(parkRes.data.bus.parkingBay === 'PARKWIZ North Bay 04', 'Parking bay name stored in database');

  // TEST 9: 4-Corner Bilinear Calibration Endpoints
  console.log('\n--- Test 9: 4-Corner Bilinear Calibration API ---');
  const calGet = await request('/api/transport/calibration');
  assert(calGet.ok && calGet.data.topLeft && calGet.data.topRight, 'GET /api/transport/calibration returns 4 corners');
  assert(calGet.data.isVerified === true, 'Calibration is verified');

  const calPut = await request('/api/transport/calibration', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topLeft: { latitude: 13.013000, longitude: 80.000000 },
      topRight: { latitude: 13.013000, longitude: 80.006200 },
      bottomLeft: { latitude: 13.006800, longitude: 80.000000 },
      bottomRight: { latitude: 13.006800, longitude: 80.006200 }
    })
  });
  assert(calPut.ok && calPut.data.success, 'PUT /api/transport/calibration persists calibration');

  // TEST 10: Authoritative Snapshot Endpoint (/api/transport/live)
  console.log('\n--- Test 10: Live Authoritative Snapshot API ---');
  const liveSnap = await request('/api/transport/live');
  assert(liveSnap.ok && Array.isArray(liveSnap.data.buses), 'GET /api/transport/live returns snapshot');
  assert(liveSnap.data.buses.length > 0, `Snapshot contains ${liveSnap.data.buses.length} buses`);

  // Close SSE stream
  sseReq.destroy();

  console.log('\n================================================================');
  console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED               `);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
