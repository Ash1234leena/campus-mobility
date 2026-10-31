#!/usr/bin/env node
/**
 * ACIMS Campus Mobility — Real Twilio SMS Test Dispatcher
 * 
 * Usage:
 *   node send_real_test_sms.js [phoneNumber] [busNumber] [pickupPoint]
 * 
 * Example:
 *   node send_real_test_sms.js +919876543210 10C "Main Campus Entrance Gate (NH 48)"
 */

import 'dotenv/config';
import {
  notificationService,
  validateAndNormalizeIndianPhone,
  getTwilioConfigStatus
} from './notification_service.js';

async function main() {
  const args = process.argv.slice(2);
  const targetPhone = args[0] || process.env.TEST_PHONE_NUMBER;
  const busNumber = args[1] || '10C';
  const pickupPoint = args[2] || 'Main Campus Entrance Gate (NH 48)';

  console.log('================================================================');
  console.log('       ACIMS REAL TWILIO SMS DISPATCH VERIFICATION              ');
  console.log('================================================================\n');

  // 1. Check Twilio Configuration
  const config = getTwilioConfigStatus();
  console.log('1. Checking Twilio Configuration in Environment (.env):');
  if (!config.configured) {
    console.error('   ❌ Twilio is NOT fully configured in .env!');
    console.error(`   Missing required variables: ${config.missing.join(', ')}`);
    console.error('\n   To send a REAL SMS, please add your Twilio credentials to .env:');
    console.error('     TWILIO_ACCOUNT_SID=ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    console.error('     TWILIO_AUTH_TOKEN=your_auth_token');
    console.error('     TWILIO_PHONE_NUMBER=+1XXXXXXXXXX\n');
    console.error('   Note: Never hardcode credentials in source code. Use .env file.\n');
  } else {
    console.log('   ✓ Twilio Account SID: Configured');
    console.log('   ✓ Twilio Auth Token:  Configured');
    console.log(`   ✓ Twilio Sender No:   ${config.fromNumber}`);
  }

  // 2. Validate Phone Number
  if (!targetPhone) {
    console.error('\n❌ No phone number provided!');
    console.error('   Usage: node send_real_test_sms.js <your_indian_mobile_number>');
    console.error('   Example: node send_real_test_sms.js 9876543210');
    console.error('   Example: node send_real_test_sms.js +919876543210\n');
    process.exit(1);
  }

  console.log(`\n2. Validating Recipient Phone Number: "${targetPhone}"`);
  const validation = validateAndNormalizeIndianPhone(targetPhone);
  if (!validation.isValid) {
    console.error(`   ❌ Phone validation failed: ${validation.error}`);
    console.error('   Indian mobile numbers must be 10 digits starting with 6, 7, 8, or 9.\n');
    process.exit(1);
  }

  console.log(`   ✓ Valid Indian mobile number: ${validation.e164}`);
  console.log(`   ✓ Masked for display:         ${validation.masked}`);

  // 3. Dispatch Real SMS
  console.log('\n3. Transmitting Real SMS via Twilio Official API...');
  const result = await notificationService.sendBusApproachingSMS({
    phoneNumber: validation.e164,
    busNumber,
    pickupPoint,
    alertType: 'TEST',
    customMessage: `ACIMS Alert: Real verified test SMS from Campus Mobility. Bus ${busNumber} approaching ${pickupPoint}. System online.`
  });

  if (result.success) {
    console.log('\n================================================================');
    console.log('   🎉 REAL SMS DISPATCHED SUCCESSFULLY VIA TWILIO!              ');
    console.log('================================================================');
    console.log(`   Recipient:       ${result.maskedPhone}`);
    console.log(`   Twilio SID:      ${result.messageSid}`);
    console.log(`   Provider Status: ${result.status}`);
    console.log(`   Timestamp:       ${result.dateCreated || new Date().toISOString()}`);
    console.log(`   Message Text:    "${result.messageBody}"`);
    console.log('================================================================\n');
  } else {
    console.log('\n================================================================');
    console.log('   ⚠️  SMS DISPATCH ATTEMPT LOGGED (SAFE ERROR)                 ');
    console.log('================================================================');
    console.log(`   Recipient:       ${result.maskedPhone}`);
    console.log(`   Provider Error:  ${result.error}`);
    if (result.code) {
      console.log(`   Twilio Code:     ${result.code}`);
      if (result.code === 21608) {
        console.log('\n   💡 TWILIO TRIAL ACCOUNT TIP (Error 21608):');
        console.log('   In Twilio trial accounts, you must verify recipient phone numbers');
        console.log('   in the Twilio Console before sending:');
        console.log('   👉 https://console.twilio.com/us1/develop/phone-numbers/manage/verified');
      }
    }
    console.log('================================================================\n');
  }
}

main().catch(err => {
  console.error('Fatal dispatch error:', err);
  process.exit(1);
});
