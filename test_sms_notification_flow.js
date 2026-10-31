/**
 * Comprehensive Test Suite for ACIMS SMS Notification System
 * 
 * Verifies:
 * 1. Indian Mobile Number Validation & E.164 Normalization (+91 format)
 * 2. Phone Number Masking (avoid leaking numbers in logs/UI)
 * 3. Approaching Notification State Machine & Duplicate Protection:
 *    - 12 min -> No SMS
 *    - 10 min -> 10-Minute SMS Sent
 *    -  9 min -> No SMS (Suppressed duplicate)
 *    -  8 min -> No SMS (Suppressed duplicate)
 *    -  5 min -> 5-Minute Urgent SMS Sent
 *    -  4 min -> No SMS (Suppressed duplicate)
 * 4. Trip Reset (Bus completes trip / moves away > 20 min -> resets state)
 * 5. Twilio API credentials check and safe error handling
 */

import {
  validateAndNormalizeIndianPhone,
  maskPhoneNumber,
  getTwilioConfigStatus,
  notificationService
} from './notification_service.js';

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

async function runTestSuite() {
  console.log('================================================================');
  console.log('       ACIMS REAL SMS NOTIFICATION SYSTEM — TEST SUITE          ');
  console.log('================================================================\n');

  // -------------------------------------------------------------
  // TEST 1: Indian Phone Number Validation & E.164 Normalization
  // -------------------------------------------------------------
  console.log('--- TEST 1: Indian Phone Number Validation ---');

  // 1a. Standard 10-digit number starting with 9
  const res1 = validateAndNormalizeIndianPhone('9876543210');
  assert(res1.isValid && res1.e164 === '+919876543210', 'Accepts 10-digit number starting with 9 (normalizes to +919876543210)');

  // 1b. Number with spaces and dashes
  const res2 = validateAndNormalizeIndianPhone('+91 98401-10010');
  assert(res2.isValid && res2.e164 === '+919840110010', 'Handles spaces and hyphens (+91 98401-10010 -> +919840110010)');

  // 1c. Leading trunk zero
  const res3 = validateAndNormalizeIndianPhone('09123456789');
  assert(res3.isValid && res3.e164 === '+919123456789', 'Strips leading 0 trunk code (09123456789 -> +919123456789)');

  // 1d. Leading 91 without plus
  const res4 = validateAndNormalizeIndianPhone('919876543210');
  assert(res4.isValid && res4.e164 === '+919876543210', 'Handles 91 prefix without plus (919876543210 -> +919876543210)');

  // 1e. Rejects non-Indian mobile starting with 1, 2, 3, 4, 5
  const res5 = validateAndNormalizeIndianPhone('1234567890');
  assert(!res5.isValid, 'Rejects invalid mobile numbers not starting with 6, 7, 8, or 9');

  // 1f. Rejects invalid length
  const res6 = validateAndNormalizeIndianPhone('98765');
  assert(!res6.isValid, 'Rejects numbers with less than 10 digits');

  // 1g. Rejects letters or garbage
  const res7 = validateAndNormalizeIndianPhone('invalid-phone');
  assert(!res7.isValid, 'Rejects non-numeric strings');

  // -------------------------------------------------------------
  // TEST 2: Safe Phone Number Masking
  // -------------------------------------------------------------
  console.log('\n--- TEST 2: Phone Number Masking (Log/Frontend Privacy) ---');
  const masked1 = maskPhoneNumber('+919876543210');
  assert(masked1 === '+9198*** **210', `Masks phone number properly (+91 98*** **210): got "${masked1}"`);
  assert(!masked1.includes('76543'), 'Sensitive middle digits are completely redacted');

  // -------------------------------------------------------------
  // TEST 3: Duplicate Protection State Machine (12m -> 10m -> 9m -> 5m -> 4m)
  // -------------------------------------------------------------
  console.log('\n--- TEST 3: ETA Progression & Duplicate Protection ---');
  const testPhone = '+919876543210';
  const testBusId = 'test_bus_10c';
  const testBusNum = '10C';
  const testStop = 'Main Campus Entrance Gate (NH 48)';

  // Reset any state before starting test
  notificationService.resetState(testBusId, testPhone, testStop);

  // Step 1: 12 minutes away -> NO SMS
  console.log('Step 1: Bus is 12 minutes away');
  const step1 = await notificationService.evaluateAndTriggerNotification({
    phoneNumber: testPhone,
    busId: testBusId,
    busNumber: testBusNum,
    pickupPoint: testStop,
    etaMinutes: 12
  });
  assert(step1.action === 'NO_ACTION', '12 min: No SMS triggered (bus is > 10 min away)');

  // Step 2: 10 minutes away -> 10-MIN SMS triggered
  console.log('Step 2: Bus approaches, now 10 minutes away');
  const step2 = await notificationService.evaluateAndTriggerNotification({
    phoneNumber: testPhone,
    busId: testBusId,
    busNumber: testBusNum,
    pickupPoint: testStop,
    etaMinutes: 10
  });
  assert(step2.action === 'SENT_10_MIN', '10 min: 10-minute alert triggered');

  // Step 3: 9 minutes away -> NO duplicate SMS
  console.log('Step 3: Bus moves closer, now 9 minutes away');
  const step3 = await notificationService.evaluateAndTriggerNotification({
    phoneNumber: testPhone,
    busId: testBusId,
    busNumber: testBusNum,
    pickupPoint: testStop,
    etaMinutes: 9
  });
  assert(step3.action === 'SUPPRESSED_10_MIN', '9 min: Duplicate 10-min SMS suppressed');

  // Step 4: 8 minutes away -> NO duplicate SMS
  console.log('Step 4: Bus moves closer, now 8 minutes away');
  const step4 = await notificationService.evaluateAndTriggerNotification({
    phoneNumber: testPhone,
    busId: testBusId,
    busNumber: testBusNum,
    pickupPoint: testStop,
    etaMinutes: 8
  });
  assert(step4.action === 'SUPPRESSED_10_MIN', '8 min: Duplicate 10-min SMS suppressed');

  // Step 5: 5 minutes away -> 5-MIN Urgent SMS triggered
  console.log('Step 5: Bus approaches within 5 minutes');
  const step5 = await notificationService.evaluateAndTriggerNotification({
    phoneNumber: testPhone,
    busId: testBusId,
    busNumber: testBusNum,
    pickupPoint: testStop,
    etaMinutes: 5
  });
  assert(step5.action === 'SENT_5_MIN', '5 min: 5-minute urgent alert triggered');

  // Step 6: 4 minutes away -> NO duplicate SMS
  console.log('Step 6: Bus moves closer, now 4 minutes away');
  const step6 = await notificationService.evaluateAndTriggerNotification({
    phoneNumber: testPhone,
    busId: testBusId,
    busNumber: testBusNum,
    pickupPoint: testStop,
    etaMinutes: 4
  });
  assert(step6.action === 'SUPPRESSED_5_MIN', '4 min: Duplicate 5-min SMS suppressed');

  // -------------------------------------------------------------
  // TEST 4: Trip Reset Logic (New trip commences)
  // -------------------------------------------------------------
  console.log('\n--- TEST 4: Trip Reset Logic ---');
  console.log('Step 7: Bus completes trip and moves away (> 20 min away for next scheduled shift)');
  const step7 = await notificationService.evaluateAndTriggerNotification({
    phoneNumber: testPhone,
    busId: testBusId,
    busNumber: testBusNum,
    pickupPoint: testStop,
    etaMinutes: 25
  });
  assert(step7.action === 'RESET', 'Notification state automatically reset when bus moves away (> 20 min)');

  console.log('Step 8: Next trip approaches, bus is 10 minutes away again');
  const step8 = await notificationService.evaluateAndTriggerNotification({
    phoneNumber: testPhone,
    busId: testBusId,
    busNumber: testBusNum,
    pickupPoint: testStop,
    etaMinutes: 10
  });
  assert(step8.action === 'SENT_10_MIN', 'Fresh 10-min alert triggered for the new trip');

  // -------------------------------------------------------------
  // TEST 5: Simulation Helper Verification
  // -------------------------------------------------------------
  console.log('\n--- TEST 5: simulateEtaProgression Helper ---');
  const simResults = await notificationService.simulateEtaProgression({
    phoneNumber: testPhone,
    busNumber: testBusNum,
    busId: 'sim_bus',
    pickupPoint: testStop,
    sendRealSMS: false,
    etaSequence: [12, 10, 9, 5, 4]
  });

  assert(simResults.length === 5, 'Simulation returned exactly 5 progression steps');
  assert(simResults[0].action === 'NO_ACTION' && !simResults[0].smsSent, 'Sim Step 1 (12 min): NO_ACTION');
  assert(simResults[1].action === 'SENT_10_MIN' && simResults[1].smsSent, 'Sim Step 2 (10 min): SENT_10_MIN');
  assert(simResults[2].action === 'SUPPRESSED_10_MIN' && !simResults[2].smsSent, 'Sim Step 3 (9 min): SUPPRESSED_10_MIN');
  assert(simResults[3].action === 'SENT_5_MIN' && simResults[3].smsSent, 'Sim Step 4 (5 min): SENT_5_MIN');
  assert(simResults[4].action === 'SUPPRESSED_5_MIN' && !simResults[4].smsSent, 'Sim Step 5 (4 min): SUPPRESSED_5_MIN');

  // -------------------------------------------------------------
  // TEST 6: Twilio Credentials & Safe Error Handling
  // -------------------------------------------------------------
  console.log('\n--- TEST 6: Twilio Environment & Safe Dispatch ---');
  const config = getTwilioConfigStatus();
  console.log(`Twilio Configured: ${config.configured ? 'YES (Live Credentials Set)' : 'NO (Pending .env configuration)'}`);
  if (!config.configured) {
    console.log(`Missing variables: ${config.missing.join(', ')}`);
  }

  // Attempt sending test SMS and verify safe error reporting (never throwing uncaught exceptions or leaking secrets)
  const testSend = await notificationService.sendBusApproachingSMS({
    phoneNumber: '+919876543210',
    busNumber: '10C',
    pickupPoint: 'Main Gate',
    alertType: 'TEST',
    customMessage: 'Test SMS Verification'
  });

  if (config.configured) {
    assert(testSend.success || testSend.error, 'Real Twilio dispatch responded cleanly without throwing exception');
  } else {
    assert(!testSend.success && testSend.missingEnv && testSend.error.includes('Twilio credentials missing'), 'Safe error returned without crashing when credentials are not yet configured');
  }

  console.log('\n================================================================');
  console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED               `);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
