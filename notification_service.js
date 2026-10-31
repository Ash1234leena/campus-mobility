import twilio from 'twilio';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Automatically load environment variables from .env
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Validates and normalizes Indian mobile phone numbers to E.164 (+91XXXXXXXXXX) format.
 */
export function validateAndNormalizeIndianPhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') {
    return { isValid: false, error: 'Phone number is required and must be a string' };
  }

  let cleaned = rawPhone.trim().replace(/[\s\-\(\)\.]/g, '');

  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  }

  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = cleaned.substring(1);
  }

  if (cleaned.startsWith('91') && cleaned.length === 12) {
    cleaned = cleaned.substring(2);
  }

  if (!/^\d{10}$/.test(cleaned)) {
    return {
      isValid: false,
      error: `Invalid phone number format: expected 10 digits for Indian mobile numbers, got ${cleaned.length} digits`
    };
  }

  if (!/^[6-9]/.test(cleaned)) {
    return {
      isValid: false,
      error: 'Invalid Indian mobile number: must start with 6, 7, 8, or 9'
    };
  }

  const e164 = `+91${cleaned}`;
  const masked = maskPhoneNumber(e164);

  return { isValid: true, e164, masked };
}

export function maskPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const clean = phone.replace(/\s+/g, '');
  if (clean.length < 8) return '***';
  const prefix = clean.slice(0, 5);
  const suffix = clean.slice(-3);
  return `${prefix}*** **${suffix}`;
}

/**
 * SMS PROVIDER PATTERN
 */

class SmsProvider {
  async send(phoneNumber, body) {
    throw new Error('send() method must be implemented by the provider');
  }
  getConfigStatus() {
    return { configured: false, missing: [], fromNumber: null };
  }
}

class TwilioProvider extends SmsProvider {
  constructor() {
    super();
    this._client = null;
  }

  getConfigStatus() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
    let fromNumber = process.env.TWILIO_PHONE_NUMBER?.trim();

    if (fromNumber && !fromNumber.startsWith("+")) {
      if (fromNumber.length === 10) fromNumber = "+1" + fromNumber;
      else if (fromNumber.length === 11 && fromNumber.startsWith("1")) fromNumber = "+" + fromNumber;
      else if (fromNumber.length === 12 && fromNumber.startsWith("91")) fromNumber = "+" + fromNumber;
    }

    const missing = [];
    if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
    if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
    if (!fromNumber) missing.push('TWILIO_PHONE_NUMBER');

    return {
      configured: missing.length === 0,
      missing,
      fromNumber: fromNumber || null
    };
  }

  async send(phoneNumber, body) {
    const status = this.getConfigStatus();
    if (!status.configured) {
      throw new Error(`Twilio not configured. Missing: ${status.missing.join(', ')}`);
    }

    if (!this._client) {
      this._client = twilio(process.env.TWILIO_ACCOUNT_SID.trim(), process.env.TWILIO_AUTH_TOKEN.trim());
    }

    const response = await this._client.messages.create({
      body: body,
      from: status.fromNumber,
      to: phoneNumber
    });

    return {
      success: true,
      messageSid: response.sid,
      status: response.status
    };
  }
}

class MockProvider extends SmsProvider {
  getConfigStatus() {
    return { configured: true, missing: [], fromNumber: '+91-MOCK-SENDER' };
  }

  async send(phoneNumber, body) {
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log(`[MOCK SMS] To: ${phoneNumber} | Body: ${body}`);
    return {
      success: true,
      messageSid: `mock_sid_${Math.random().toString(36).substring(2, 15)}`,
      status: 'delivered'
    };
  }
}

/**
 * Notification Service Logic
 */
class NotificationService {
  constructor() {
    this.alertStates = new Map();
    this.auditLog = [];

    // FORCE MOCK MODE: This bypasses .env and Twilio entirely for testing
    const providerType = 'mock';

    if (providerType === 'mock') {
      this.provider = new MockProvider();
      console.log('[NotificationService] FORCE-ENABLED: Using MOCK SMS Provider (no real messages sent)');
    } else {
      this.provider = new TwilioProvider();
      console.log('[NotificationService] Using TWILIO SMS Provider');
    }
  }

  getTwilioConfigStatus() {
    return this.provider.getConfigStatus();
  }

  logAudit(entry) {
    this.auditLog.unshift({
      id: `sms_log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...entry
    });
    if (this.auditLog.length > 50) this.auditLog.pop();
  }

  getAuditLog() {
    return [...this.auditLog];
  }

  async sendBusApproachingSMS({
    phoneNumber,
    busNumber = 'Campus Bus',
    pickupPoint = 'Pickup Point',
    etaMinutes = null,
    alertType = 'CUSTOM',
    customMessage = null
  }) {
    const validation = validateAndNormalizeIndianPhone(phoneNumber);
    if (!validation.isValid) {
      const err = validation.error;
      this.logAudit({ busNumber, pickupPoint, etaMinutes, alertType, maskedPhone: maskPhoneNumber(phoneNumber), success: false, error: err });
      return { success: false, error: err, maskedPhone: maskPhoneNumber(phoneNumber) };
    }

    const recipientE164 = validation.e164;
    const maskedRecipient = validation.masked;

    let messageBody = '';
    if (customMessage) {
      messageBody = customMessage;
    } else if (alertType === '10_MIN' || (etaMinutes !== null && etaMinutes <= 10 && etaMinutes > 5)) {
      messageBody = `ACIMS Alert: Your bus is approximately 10 minutes away from your pickup point. Please be ready.`;
    } else if (alertType === '5_MIN' || (etaMinutes !== null && etaMinutes <= 5)) {
      messageBody = `ACIMS Alert: Your bus is approximately 5 minutes away. Please proceed to your pickup point.`;
    } else if (etaMinutes !== null) {
      messageBody = `ACIMS Alert: Bus ${busNumber} is approximately ${Math.round(etaMinutes)} minutes away from ${pickupPoint}. Please be ready.`;
    } else {
      messageBody = `ACIMS Alert: Bus ${busNumber} approaching ${pickupPoint}.`;
    }

    try {
      const result = await this.provider.send(recipientE164, messageBody);

      const finalResult = {
        success: result.success,
        messageSid: result.messageSid,
        status: result.status,
        maskedPhone: maskedRecipient,
        messageBody,
        etaMinutes,
        alertType
      };

      this.logAudit({ ...finalResult, error: null });
      return finalResult;
    } catch (err) {
      const safeErrorMessage = err.message || 'Unknown SMS Provider error';
      this.logAudit({ busNumber, pickupPoint, etaMinutes, alertType, maskedPhone: maskedRecipient, messageBody, success: false, error: safeErrorMessage });
      return { success: false, error: safeErrorMessage, maskedPhone: maskedRecipient, alertType, etaMinutes };
    }
  }

  getStateKey(busId, studentIdOrPhone, pickupPoint) {
    const b = (busId || 'default_bus').toLowerCase().trim();
    const s = (studentIdOrPhone || 'default_student').trim();
    const p = (pickupPoint || 'default_stop').toLowerCase().trim();
    return `${b}:${s}:${p}`;
  }

  async evaluateAndTriggerNotification({
    phoneNumber,
    busId,
    busNumber,
    pickupPoint,
    etaMinutes,
    studentId = null
  }) {
    if (etaMinutes === null || etaMinutes === undefined || isNaN(etaMinutes)) {
      return { action: 'NO_ACTION', details: { reason: 'ETA is invalid or unavailable' } };
    }

    const stateKey = this.getStateKey(busId, studentId || phoneNumber, pickupPoint);
    let state = this.alertStates.get(stateKey);

    if (!state) {
      state = { tenMinuteSentAt: null, fiveMinuteSentAt: null, lastEta: etaMinutes, updatedAt: Date.now() };
      this.alertStates.set(stateKey, state);
    }

    if (etaMinutes > 20 && (state.tenMinuteSentAt || state.fiveMinuteSentAt)) {
      state.tenMinuteSentAt = null;
      state.fiveMinuteSentAt = null;
      state.lastEta = etaMinutes;
      state.updatedAt = Date.now();
      return { action: 'RESET', details: { reason: 'Bus moved away or new trip commenced' } };
    }

    state.lastEta = etaMinutes;
    state.updatedAt = Date.now();

    if (etaMinutes <= 10 && etaMinutes > 5) {
      if (!state.tenMinuteSentAt) {
        state.tenMinuteSentAt = Date.now();
        const sendResult = await this.sendBusApproachingSMS({ phoneNumber, busNumber, pickupPoint, etaMinutes: 10, alertType: '10_MIN' });
        return { action: 'SENT_10_MIN', details: { etaMinutes, smsResult: sendResult } };
      } else {
        return { action: 'SUPPRESSED_10_MIN', details: { etaMinutes, reason: 'Duplicate 10-min alert suppressed' } };
      }
    }

    if (etaMinutes <= 5 && etaMinutes >= 0) {
      if (!state.fiveMinuteSentAt) {
        state.fiveMinuteSentAt = Date.now();
        const sendResult = await this.sendBusApproachingSMS({ phoneNumber, busNumber, pickupPoint, etaMinutes: 5, alertType: '5_MIN' });
        return { action: 'SENT_5_MIN', details: { etaMinutes, smsResult: sendResult } };
      } else {
        return { action: 'SUPPRESSED_5_MIN', details: { etaMinutes, reason: 'Duplicate 5-min alert suppressed' } };
      }
    }

    return { action: 'NO_ACTION', details: { etaMinutes, reason: etaMinutes > 10 ? 'Bus is more than 10 minutes away.' : 'Bus passed pickup point.' } };
  }

  resetState(busId, studentIdOrPhone, pickupPoint) {
    const stateKey = this.getStateKey(busId, studentIdOrPhone, pickupPoint);
    this.alertStates.delete(stateKey);
  }

  clearAllStates() {
    this.alertStates.clear();
  }

  getState(busId, studentIdOrPhone, pickupPoint) {
    const stateKey = this.getStateKey(busId, studentIdOrPhone, pickupPoint);
    return this.alertStates.get(stateKey) || null;
  }

  async simulateEtaProgression({
    phoneNumber,
    busNumber = '10C',
    busId = 'rec_bus_10c',
    pickupPoint = 'Main Campus Entrance Gate (NH 48)',
    sendRealSMS = false,
    etaSequence = [12, 10, 9, 5, 4]
  }) {
    this.resetState(busId, phoneNumber, pickupPoint);
    const simulationResults = [];

    for (const eta of etaSequence) {
      if (sendRealSMS) {
        const step = await this.evaluateAndTriggerNotification({ phoneNumber, busId, busNumber, pickupPoint, etaMinutes: eta });
        simulationResults.push({ eta, action: step.action, smsSent: step.action === 'SENT_10_MIN' || step.action === 'SENT_5_MIN', details: step.details });
      } else {
        const stateKey = this.getStateKey(busId, phoneNumber, pickupPoint);
        let state = this.alertStates.get(stateKey);
        if (!state) {
          state = { tenMinuteSentAt: null, fiveMinuteSentAt: null, lastEta: eta };
          this.alertStates.set(stateKey, state);
        }

        let action = 'NO_ACTION';
        let smsSent = false;
        let details = {};

        if (eta > 10) {
          action = 'NO_ACTION';
          details = { message: `ETA ${eta} min > 10 min window.` };
        } else if (eta <= 10 && eta > 5) {
          if (!state.tenMinuteSentAt) {
            state.tenMinuteSentAt = Date.now();
            action = 'SENT_10_MIN';
            smsSent = true;
            details = { message: `10-minute alert triggered.` };
          } else {
            action = 'SUPPRESSED_10_MIN';
            smsSent = false;
            details = { message: `Duplicate 10-minute alert suppressed.` };
          }
        } else if (eta <= 5 && eta >= 0) {
          if (!state.fiveMinuteSentAt) {
            state.fiveMinuteSentAt = Date.now();
            action = 'SENT_5_MIN';
            smsSent = true;
            details = { message: `5-minute alert triggered.` };
          } else {
            action = 'SUPPRESSED_5_MIN';
            smsSent = false;
            details = { message: `Duplicate 5-minute alert suppressed.` };
          }
        }
        simulationResults.push({ eta, action, smsSent, details });
      }
    }
    return simulationResults;
  }
}

export const notificationService = new NotificationService();
export function getTwilioConfigStatus() {
  return notificationService.getTwilioConfigStatus();
}
export default notificationService;