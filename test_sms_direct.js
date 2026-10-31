import 'dotenv/config';
import twilio from 'twilio';

async function testSms() {
  console.log('--- 🚀 Starting Direct SMS Test ---');

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.error('❌ ERROR: Missing credentials in .env file!');
    console.log('Please ensure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER are set.');
    process.exit(1);
  }

  // REPLACE THIS with the number you verified in the Twilio Console
  const testNumber = '+917603834339'; // <--- CHANGE THIS TO YOUR VERIFIED NUMBER

  if (testNumber === '+91XXXXXXXXXX') {
    console.error('❌ ERROR: You must edit test_sms_direct.js and replace "+91XXXXXXXXXX" with your actual phone number.');
    process.exit(1);
  }

  try {
    const client = twilio(accountSid, authToken);
    console.log(`Sending test message to ${testNumber}...`);

    const message = await client.messages.create({
      body: 'Hello from ACIMS! This is a direct connection test. If you see this, your Twilio setup is working correctly. ✅',
      from: fromNumber,
      to: testNumber
    });

    console.log('✅ SUCCESS!');
    console.log(`Message SID: ${message.sid}`);
    console.log('Check your phone now!');
  } catch (error) {
    console.error('❌ FAILED!');
    if (error.code === 21608) {
      console.error('ERROR 21608: The number is not a Verified Caller ID. You MUST add it to the "Verified Caller IDs" section in your Twilio Console.');
    } else {
      console.error(`Error Message: ${error.message}`);
    }
  }
}

testSms();