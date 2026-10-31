import fs from 'node:fs';
import { CampusRouter } from './router.js';

const campusData = JSON.parse(fs.readFileSync('./rec_campus_data.json', 'utf8'));
const transportDb = JSON.parse(fs.readFileSync('./data/rec_transport_database.json', 'utf8'));

const router = new CampusRouter(campusData);

console.log('========================================================================');
console.log('  REC CAMPUS MOBILITY ROUTE ENGINE TEST SUITE');
console.log('========================================================================\n');

let passCount = 0;
let failCount = 0;

function assert(condition, testName, details = '') {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passCount++;
  } else {
    console.error(`  ❌ FAIL: ${testName} - ${details}`);
    failCount++;
  }
}

function validateRouteQuality(route, expectedOrigin, expectedDest, label) {
  console.log(`\n--- Quality Check: ${label} ---`);
  console.log(`  Provider: ${route.provider}`);
  console.log(`  Distance: ${route.distanceMeters} m, Duration: ${route.durationMinutes} min`);
  console.log(`  Coordinates count: ${route.coordinates.length}`);
  console.log(`  Steps count: ${route.steps ? route.steps.length : 0}`);

  // 1. Minimum 2 coordinates
  assert(route.coordinates && route.coordinates.length >= 2, 'Route contains >= 2 coordinates');

  // 2. Coordinates validity
  const allFinite = route.coordinates.every(c => isFinite(c[0]) && isFinite(c[1]) && c[0] > 12.9 && c[0] < 13.1 && c[1] > 79.9 && c[1] < 80.1);
  assert(allFinite, 'All coordinates are valid and within REC campus bounds');

  // 3. No duplicate consecutive points
  let duplicateCount = 0;
  for (let i = 0; i < route.coordinates.length - 1; i++) {
    const d = CampusRouter.haversineDistance(route.coordinates[i], route.coordinates[i + 1]);
    if (d < 0.5) duplicateCount++;
  }
  assert(duplicateCount === 0, 'Zero duplicate consecutive coordinates (<0.5m)', `Found ${duplicateCount} duplicates`);

  // 4. Consecutive segments form connected path (no sudden teleport jumps > 250m)
  let maxSegDist = 0;
  for (let i = 0; i < route.coordinates.length - 1; i++) {
    const d = CampusRouter.haversineDistance(route.coordinates[i], route.coordinates[i + 1]);
    if (d > maxSegDist) maxSegDist = d;
  }
  assert(maxSegDist < 250, `Connected road segments (max segment: ${Math.round(maxSegDist)}m < 250m)`);

  // 5. Origin and destination proximity
  const originCoord = [expectedOrigin.latitude ?? expectedOrigin[0], expectedOrigin.longitude ?? expectedOrigin[1]];
  const destCoord = [expectedDest.latitude ?? expectedDest[0], expectedDest.longitude ?? expectedDest[1]];

  const distToStart = CampusRouter.haversineDistance(route.coordinates[0], originCoord);
  const distToEnd = CampusRouter.haversineDistance(route.coordinates[route.coordinates.length - 1], destCoord);
  assert(distToStart < 60, `Starts near actual origin (${Math.round(distToStart)}m)`);
  assert(distToEnd < 60, `Ends near actual destination (${Math.round(distToEnd)}m)`);

  // 6. Directness ratio: distance / haversine(start, dest)
  const crowFlies = CampusRouter.haversineDistance(originCoord, destCoord);
  const directnessRatio = crowFlies > 20 ? (route.distanceMeters / crowFlies) : 1;
  console.log(`  Direct distance (as crow flies): ${Math.round(crowFlies)} m`);
  console.log(`  Route directness ratio: ${directnessRatio.toFixed(2)}x`);
  assert(directnessRatio < 1.95, `Direct route without indirect beating around the bush (${directnessRatio.toFixed(2)}x < 1.95x)`);

  // 7. No 180° backtracking loops
  let reversalCount = 0;
  for (let i = 0; i < route.coordinates.length - 2; i++) {
    const b1 = CampusRouter.calculateBearing(route.coordinates[i], route.coordinates[i + 1]);
    const b2 = CampusRouter.calculateBearing(route.coordinates[i + 1], route.coordinates[i + 2]);
    let diff = Math.abs(b2 - b1);
    if (diff > 180) diff = 360 - diff;
    if (diff > 140) reversalCount++;
  }
  assert(reversalCount === 0, `Zero backtracking loops or acute reversals (reversals: ${reversalCount})`);
}

async function runTests() {
  // Test 1: PARKWIZ 1 -> Indoor Auditorium (The problematic detour route)
  const pw1 = campusData.locations.find(l => l.id === 'rec_parkwiz_1');
  const aud = campusData.locations.find(l => l.id === 'rec_indoor_auditorium');
  const r1 = await router.calculateRoute(pw1, aud);
  validateRouteQuality(r1, pw1, aud, 'PARKWIZ 1 -> Indoor Auditorium');
  assert(r1.distanceMeters < 820, `PARKWIZ 1 -> Auditorium distance is optimal (${r1.distanceMeters}m < 820m, was 951m with detour)`);

  // Test 2: Mid-Road GPS position (Midpoint along main avenue) -> Admin Block
  const midRoadOrigin = { latitude: 13.0118, longitude: 80.0007, name: 'Main Road Midpoint' };
  const admin = campusData.locations.find(l => l.id === 'rec_admin_block');
  const r2 = await router.calculateRoute(midRoadOrigin, admin);
  validateRouteQuality(r2, midRoadOrigin, admin, 'Mid-Road GPS Start -> Admin Block');

  // Test 3: Main Gate -> Academic Block
  const gate = campusData.locations.find(l => l.id === 'rec_main_gate');
  const acad = campusData.locations.find(l => l.id === 'rec_academic_block');
  const r3 = await router.calculateRoute(gate, acad);
  validateRouteQuality(r3, gate, acad, 'Main Gate -> Academic Block');

  // Test 4: Academic Block -> Boy's Hostel 1
  const bh1 = campusData.locations.find(l => l.id === 'rec_boys_hostel_1');
  const r4 = await router.calculateRoute(acad, bh1);
  validateRouteQuality(r4, acad, bh1, 'Academic Block -> Boy\'s Hostel 1');

  // Test 5: College Bus Destination: User at Central Library -> Moving Bus #10C
  const lib = campusData.locations.find(l => l.id === 'rec_central_library');
  const bus10c = transportDb.buses.find(b => b.busId === 'rec_bus_10c');
  const busDest = {
    isBus: true,
    busNumber: bus10c.busNumber,
    name: `Bus #${bus10c.busNumber} — ${bus10c.routeName}`,
    latitude: bus10c.lastLatitude,
    longitude: bus10c.lastLongitude,
    category: 'Buses'
  };
  const r5 = await router.calculateRoute(lib, busDest, { profile: 'driving', busAccessible: true });
  validateRouteQuality(r5, lib, busDest, 'Central Library -> Moving Bus #10C');

  // Test 6: Multi-Stop Sequential Bus Route (Preserving order across stops)
  console.log('\n--- Test 6: Multi-Stop Bus Transit Route ---');
  const busStops = [
    { latitude: 13.0124751, longitude: 80.0003439, name: 'Stop 1: Main Campus Entrance Gate' },
    { latitude: 13.0112322, longitude: 80.0010702, name: 'Stop 2: PARKWIZ 1 Parking Zone' },
    { latitude: 13.011205, longitude: 80.0011243, name: 'Stop 3: PARKWIZ 2 Parking Zone' },
    { latitude: 13.0079197, longitude: 80.0024037, name: 'Stop 4: Academic Block Bay' },
    { latitude: 13.0088743, longitude: 80.005524, name: 'Stop 5: Central Library & J Block Bay' }
  ];
  const r6 = await router.calculateMultiStopRoute(busStops, { profile: 'driving', busAccessible: true });
  console.log(`  Multi-Stop Route Provider: ${r6.provider}`);
  console.log(`  Total Stops: ${r6.stopsCount}, Distance: ${r6.distanceMeters} m, Duration: ${r6.durationMinutes} min`);
  console.log(`  Coordinates count: ${r6.coordinates.length}, Steps count: ${r6.steps.length}`);
  assert(r6.coordinates && r6.coordinates.length > 10, 'Multi-stop route generated connected coordinates');
  assert(r6.steps.length >= 4, 'Multi-stop route generated step milestones for all stops');
  assert(r6.distanceMeters > 500 && r6.distanceMeters < 1800, `Plausible multi-stop transit distance (${r6.distanceMeters}m)`);

  // Test 7: Fail-safe Offline A* Road Graph Fallback
  console.log('\n--- Test 7: Offline A* Road Graph Fallback (Simulated Network Offline) ---');
  const offlineRouter = new CampusRouter(campusData);
  offlineRouter.fetchOSRMRoute = async () => null; // force offline
  const r7 = await offlineRouter.calculateRoute(pw1, aud);
  validateRouteQuality(r7, pw1, aud, 'Offline A* Graph: PARKWIZ 1 -> Auditorium');
  assert(r7.provider.includes('A*'), 'Uses verified local A* road graph when offline');

  console.log('\n========================================================================');
  console.log(`  TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('========================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
