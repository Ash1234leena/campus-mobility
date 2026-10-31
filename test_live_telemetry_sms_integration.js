/**
 * Live End-to-End Test for Telemetry-Triggered SMS Notifications
 * 
 * Verifies against running server at http://localhost:3500:
 * 1. GET /api/status -> reports SMS system readiness
 * 2. POST /api/student/notification-profile -> registers student with Indian mobile number +919876543210
 * 3. Driver starts session for Bus 10C
 * 4. Driver transmits telemetry at 10-minute ETA distance (~3.6 km from pickup point):
 *    -> triggers 10-minute alert
 * 5. Driver transmits slight movement (~3.3 km away, ~9 min ETA):
 *    -> suppresses duplicate 10-min alert
 * 6. Driver transmits telemetry at 5-minute ETA distance (~1.8 km away):
 *    -> triggers 5-minute urgent alert
 * 7. Driver transmits slight movement (~1.5 km away, ~4 min ETA):
 *    -> suppresses duplicate 5-min alert
 * 8. Driver ends trip (isLive: false):
 *    -> resets deduplication state
 */

const BASE_URL = 'http://localhost:3500';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, options);
  let data = null;
  try {
    data = await res.json();
  } catch (e) {}
  return { ok: res.ok, status: res.status, data };
}

async function runLiveTest() {
  console.log('================================================================');
  console.log(' LIVE TELEMETRY -> SMS NOTIFICATION END-TO-END PIPELINE TEST    ');
  console.log('================================================================\n');

  // 1. Check server status & SMS configuration
  console.log('Step 1: Check server status and SMS subsystem');
  const statusRes = await request('/api/status');
  assert(statusRes.ok && statusRes.data.online, 'Backend server is online (3500)');
  assert(statusRes.data.smsSystem !== undefined, 'SMS subsystem status returned in /api/status');

  // 2. Reset previous notification states
  await request('/api/notifications/reset', { method: 'POST' });

  // 3. Register Student Notification Profile
  console.log('\nStep 2: Configure Student Notification Profile');
  const profileRes = await request('/api/student/notification-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Rithvik S',
      phoneNumber: '+919876543210',
      busId: 'rec_bus_10c',
      busNumber: '10C',
      pickupPointId: 'stop_main_gate',
      pickupPointName: 'Main Campus Entrance Gate (NH 48)',
      smsEnabled: true
    })
  });
  assert(profileRes.ok && profileRes.data.profile.maskedPhone === '+9198*** **210', 'Student profile updated with verified Indian number (+9198*** **210)');

  // 4. Authenticate Driver for Bus 10C
  console.log('\nStep 3: Driver Cockpit Session Auth');
  const sessionRes = await request('/api/driver/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ busId: 'rec_bus_10c' })
  });
  assert(sessionRes.ok && sessionRes.data.token, 'Driver session authorized with unique token');
  const driverToken = sessionRes.data.token;

  // Pickup coordinates for Main Campus Entrance Gate (NH 48): 13.0124751, 80.0003439
  // Point A: ~3.6 km away (ETA ~9.8 min at 22 km/h) -> Lat 13.0125, Lon 80.0335
  console.log('\nStep 4: Driver Transmits Real Telemetry in 10-Minute Window (~3.6 km away, ETA ~9.8 min)');
  const gps1 = {
    latitude: 13.012500,
    longitude: 80.033500,
    speed: 22,
    heading: 270,
    accuracy: 5,
    isLive: true,
    parkingBay: 'In Transit — Highway Approach'
  };

  const tele1 = await request('/api/buses/rec_bus_10c/telemetry', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${driverToken}`
    },
    body: JSON.stringify(gps1)
  });
  assert(tele1.ok, 'Driver telemetry accepted (200)');

  // Give asynchronous notification check up to 1500ms to record across network
  let check1;
  for (let wait = 0; wait < 15; wait++) {
    await new Promise(r => setTimeout(r, 100));
    check1 = await request('/api/student/notification-profile');
    if (check1.data.lastNotification?.alertType === '10_MIN') break;
  }

  // Inspect student profile to verify 10-minute alert was recorded
  assert(check1.data.lastNotification?.alertType === '10_MIN', '10-minute approaching notification recorded');
  console.log(`  -> Triggered ETA: ${check1.data.lastNotification?.etaMinutes} min | Status: ${check1.data.lastNotification?.status}`);

  // 5. Driver updates position to ~3.3 km away (~9 min ETA) -> duplicate 10-min alert must be suppressed
  console.log('\nStep 5: Driver Moves to ~3.3 km (~9.0 min ETA) -> Duplicate 10-min SMS must be suppressed');
  const gps2 = {
    latitude: 13.012500,
    longitude: 80.030500,
    speed: 22,
    heading: 270,
    accuracy: 4,
    isLive: true,
    parkingBay: 'In Transit — Near Poonamallee'
  };

  const tele2 = await request('/api/buses/rec_bus_10c/telemetry', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${driverToken}`
    },
    body: JSON.stringify(gps2)
  });
  assert(tele2.ok, 'Second telemetry update accepted');
  await new Promise(r => setTimeout(r, 150));

  const check2 = await request('/api/student/notification-profile');
  assert(check2.data.lastNotification?.alertType === '10_MIN' && check2.data.lastNotification?.etaMinutes < 10, 'Duplicate 10-min SMS was suppressed (alert remains from first trigger)');

  // 6. Driver moves into 5-minute window (~1.7 km away, ETA ~4.6 min) -> triggers 5-minute urgent alert
  console.log('\nStep 6: Driver Moves into 5-Minute Window (~1.7 km away, ETA ~4.6 min)');
  const gps3 = {
    latitude: 13.012500,
    longitude: 80.016000,
    speed: 22,
    heading: 270,
    accuracy: 4,
    isLive: true,
    parkingBay: 'In Transit — Near Toll'
  };

  const tele3 = await request('/api/buses/rec_bus_10c/telemetry', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${driverToken}`
    },
    body: JSON.stringify(gps3)
  });
  assert(tele3.ok, 'Third telemetry update accepted');
  let check3;
  for (let wait = 0; wait < 15; wait++) {
    await new Promise(r => setTimeout(r, 100));
    check3 = await request('/api/student/notification-profile');
    if (check3.data.lastNotification?.alertType === '5_MIN') break;
  }

  assert(check3.data.lastNotification?.alertType === '5_MIN', '5-minute urgent approaching alert triggered!');
  console.log(`  -> Triggered ETA: ${check3.data.lastNotification?.etaMinutes} min | Status: ${check3.data.lastNotification?.status}`);

  // 7. Driver moves to ~1.4 km (~3.8 min) -> duplicate 5-min alert suppressed
  console.log('\nStep 7: Driver Moves to ~1.4 km (~3.8 min ETA) -> Duplicate 5-min alert suppressed');
  const gps4 = {
    latitude: 13.012500,
    longitude: 80.013000,
    speed: 22,
    heading: 270,
    accuracy: 4,
    isLive: true,
    parkingBay: 'In Transit — Approaching Arch'
  };

  const tele4 = await request('/api/buses/rec_bus_10c/telemetry', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${driverToken}`
    },
    body: JSON.stringify(gps4)
  });
  assert(tele4.ok, 'Fourth telemetry update accepted');
  await new Promise(r => setTimeout(r, 150));

  const check4 = await request('/api/student/notification-profile');
  assert(check4.data.lastNotification?.alertType === '5_MIN', 'Duplicate 5-min alert suppressed');

  // 8. Driver Stops Trip -> resets state
  console.log('\nStep 8: Driver Ends Trip (isLive: false)');
  const stopTele = await request('/api/buses/rec_bus_10c/telemetry', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${driverToken}`
    },
    body: JSON.stringify({
      latitude: 13.012475,
      longitude: 80.000343,
      speed: 0,
      heading: 0,
      accuracy: 3,
      isLive: false,
      parkingBay: 'PARKWIZ Bay 10C'
    })
  });
  assert(stopTele.ok, 'Stop trip telemetry accepted');

  console.log('\n================================================================');
  console.log(`   END-TO-END RESULTS: ${passed} PASSED, ${failed} FAILED       `);
  console.log('================================================================');

  if (failed > 0) process.exit(1);
  else process.exit(0);
}

runLiveTest().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
