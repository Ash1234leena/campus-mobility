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
 * Indian mobile numbers must be 10 digits starting with 6, 7, 8, or 9.
 * 
 * Supports input formats:
 * - "+919876543210"
 * - "+91 98765 43210"
 * - "9876543210"
 * - "09876543210"
 * - "919876543210"
 * 
 * @param {string} rawPhone
 * @returns {{ isValid: boolean, e164?: string, masked?: string, error?: string }}
 */
export function validateAndNormalizeIndianPhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') {
    return { isValid: false, error: 'Phone number is required and must be a string' };
  }

  // Remove whitespace, dashes, parentheses, dots
  let cleaned = rawPhone.trim().replace(/[\s\-\(\)\.]/g, '');

  // Handle leading "+"
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  }

  // Handle leading "0" trunk prefix
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = cleaned.substring(1);
  }

  // If starts with "91" followed by 10 digits, strip "91"
  if (cleaned.startsWith('91') && cleaned.length === 12) {
    cleaned = cleaned.substring(2);
  }

  // At this point, cleaned should be exactly 10 digits
  if (!/^\d{10}$/.test(cleaned)) {
    return {
      isValid: false,
      error: `Invalid phone number format: expected 10 digits for Indian mobile numbers, got ${cleaned.length} digits`
    };
  }

  // Indian mobile numbers must start with 6, 7, 8, or 9
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

/**
 * Safely masks a phone number for UI display and logs (e.g., +91 98*** **210)
 * @param {string} phone
 * @returns {string}
 */
export function maskPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const clean = phone.replace(/\s+/g, '');
  if (clean.length < 8) return '***';
  const prefix = clean.slice(0, 5); // e.g. "+9198"
  const suffix = clean.slice(-3);   // e.g. "210"
  return `${prefix}*** **${suffix}`;
}

/**
 * Check if Twilio environment credentials are configured
 * @returns {{ configured: boolean, missing: string[], fromNumber: string | null }}
 */
export function getTwilioConfigStatus() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  let fromNumber = process.env.TWILIO_PHONE_NUMBER?.trim();
  if (fromNumber && !fromNumber.startsWith("+")) {
    if (fromNumber.length === 10) {
      fromNumber = "+1" + fromNumber;
    } else if (fromNumber.length === 11 && fromNumber.startsWith("1")) {
      fromNumber = "+" + fromNumber;
    } else if (fromNumber.length === 12 && fromNumber.startsWith("91")) {
      fromNumber = "+" + fromNumber;
    }
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

/**
 * In-memory notification state machine & audit log
 */
class NotificationService {
  constructor() {
    // Key: `${busId}:${studentIdentifier}:${pickupPoint}`
    // Value: { tenMinuteSentAt: number | null, fiveMinuteSentAt: number | null, lastEta: number | null, tripCompleted: boolean }
    this.alertStates = new Map();

    // Audit log of recent notifications (capped at 50)
    this.auditLog = [];

    // Cached Twilio client
    this._client = null;
  }

  getTwilioClient() {
    const { configured, missing } = getTwilioConfigStatus();
    if (!configured) {
      throw new Error(`Twilio is not configured. Missing required environment variables: ${missing.join(', ')}`);
    }

    if (!this._client) {
      this._client = twilio(process.env.TWILIO_ACCOUNT_SID.trim(), process.env.TWILIO_AUTH_TOKEN.trim());
    }
    return this._client;
  }

  /**
   * Log an event to the recent audit log with capped size
   */
  logAudit(entry) {
    this.auditLog.unshift({
      id: `sms_log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...entry
    });
    if (this.auditLog.length > 50) {
      this.auditLog.pop();
    }
  }

  getAuditLog() {
    return [...this.auditLog];
  }

  /**
   * Sends a REAL SMS to a student's verified phone number using Twilio.
   * 
   * Example SMS copy:
   * 10 min alert: "ACIMS Alert: Your bus is approximately 10 minutes away from your pickup point. Please be ready."
   * 5 min alert:  "ACIMS Alert: Your bus is approximately 5 minutes away. Please proceed to your pickup point."
   * 
   * @param {Object} params
   * @param {string} params.phoneNumber - Student's phone number
   * @param {string} [params.busNumber] - Assigned bus number (e.g. "10C")
   * @param {string} [params.pickupPoint] - Name of pickup location
   * @param {number} [params.etaMinutes] - Estimated arrival time in minutes
   * @param {'10_MIN' | '5_MIN' | 'TEST' | 'CUSTOM'} [params.alertType='CUSTOM']
   * @param {string} [params.customMessage] - Optional override message
   * @returns {Promise<{ success: boolean, messageSid?: string, status?: string, error?: string, code?: number, maskedPhone: string }>}
   */
  async sendBusApproachingSMS({
    phoneNumber,
    busNumber = 'Campus Bus',
    pickupPoint = 'Pickup Point',
    etaMinutes = null,
    alertType = 'CUSTOM',
    customMessage = null
  }) {
    // 1. Phone number validation
    const validation = validateAndNormalizeIndianPhone(phoneNumber);
    if (!validation.isValid) {
      const err = validation.error;
      this.logAudit({
        busNumber,
        pickupPoint,
        etaMinutes,
        alertType,
        maskedPhone: maskPhoneNumber(phoneNumber),
        success: false,
        error: err
      });
      return { success: false, error: err, maskedPhone: maskPhoneNumber(phoneNumber) };
    }

    const recipientE164 = validation.e164;
    const maskedRecipient = validation.masked;

    // 2. Format official SMS content according to ACIMS standard
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

    // 3. Check Twilio configuration
    const configStatus = getTwilioConfigStatus();
    if (!configStatus.configured) {
      const errMsg = `Twilio credentials missing in server environment: ${configStatus.missing.join(', ')}`;
      console.error(`[SMS Service] Error: ${errMsg}`);
      this.logAudit({
        busNumber,
        pickupPoint,
        etaMinutes,
        alertType,
        maskedPhone: maskedRecipient,
        messageBody,
        success: false,
        error: errMsg
      });
      return {
        success: false,
        error: errMsg,
        maskedPhone: maskedRecipient,
        missingEnv: configStatus.missing
      };
    }

    // 4. Send actual SMS via Twilio API
    try {
      const client = this.getTwilioClient();
      const fromNumber = configStatus.fromNumber;

      const twilioResponse = await client.messages.create({
        body: messageBody,
        from: fromNumber,
        to: recipientE164
      });

      console.log(`[SMS Service] Real SMS sent to ${maskedRecipient}: SID=${twilioResponse.sid}, status=${twilioResponse.status}`);

      const result = {
        success: true,
        messageSid: twilioResponse.sid,
        status: twilioResponse.status,
        dateCreated: twilioResponse.dateCreated,
        maskedPhone: maskedRecipient,
        messageBody,
        etaMinutes,
        alertType
      };

      this.logAudit({
        ...result,
        error: null
      });

      return result;
    } catch (err) {
      // Safe error logging: never log raw auth tokens or credentials
      const safeErrorMessage = err.message || 'Unknown Twilio error';
      const errorCode = err.code || null;
      console.error(`[SMS Service] Twilio dispatch failed for ${maskedRecipient}: code=${errorCode}, message=${safeErrorMessage}`);

      const failureResult = {
        success: false,
        error: safeErrorMessage,
        code: errorCode,
        maskedPhone: maskedRecipient,
        alertType,
        etaMinutes
      };

      this.logAudit({
        busNumber,
        pickupPoint,
        etaMinutes,
        alertType,
        maskedPhone: maskedRecipient,
        messageBody,
        success: false,
        error: safeErrorMessage,
        code: errorCode
      });

      return failureResult;
    }
  }

  /**
   * Generates a unique deduplication key for a student and bus pickup
   */
  getStateKey(busId, studentIdOrPhone, pickupPoint) {
    const b = (busId || 'default_bus').toLowerCase().trim();
    const s = (studentIdOrPhone || 'default_student').trim();
    const p = (pickupPoint || 'default_stop').toLowerCase().trim();
    return `${b}:${s}:${p}`;
  }

  /**
   * Evaluates incoming bus ETA against deduplication rules and triggers REAL SMS when approaching.
   * 
   * Deduplication rules:
   * - ETA > 10 min: NO SMS sent
   * - ETA <= 10 min (and > 5 min): Send 10-minute SMS ONCE. Repeated GPS updates (9m, 8m, etc.) are suppressed.
   * - ETA <= 5 min: Send 5-minute SMS ONCE. Repeated GPS updates (4m, etc.) are suppressed.
   * - If bus moves away (> 20 min or trip finishes): Reset notification state for the next trip.
   * 
   * @param {Object} params
   * @param {string} params.phoneNumber - Student's phone number
   * @param {string} params.busId - Identifier of bus
   * @param {string} params.busNumber - Display number of bus (e.g. "10C")
   * @param {string} params.pickupPoint - Pickup point name
   * @param {number} params.etaMinutes - Current calculated ETA in minutes
   * @param {string} [params.studentId] - Optional student identifier
   * @returns {Promise<{ action: 'NO_ACTION' | 'SENT_10_MIN' | 'SUPPRESSED_10_MIN' | 'SENT_5_MIN' | 'SUPPRESSED_5_MIN' | 'RESET', details: Object }>}
   */
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
      state = {
        tenMinuteSentAt: null,
        fiveMinuteSentAt: null,
        lastEta: etaMinutes,
        updatedAt: Date.now()
      };
      this.alertStates.set(stateKey, state);
    }

    // Trip reset condition: if ETA increases above 20 minutes after being in approach window,
    // or if bus has cleared the pickup and completed trip, reset state
    if (etaMinutes > 20 && (state.tenMinuteSentAt || state.fiveMinuteSentAt)) {
      state.tenMinuteSentAt = null;
      state.fiveMinuteSentAt = null;
      state.lastEta = etaMinutes;
      state.updatedAt = Date.now();
      return { action: 'RESET', details: { reason: 'Bus moved away or new trip commenced; notification state reset' } };
    }

    state.lastEta = etaMinutes;
    state.updatedAt = Date.now();

    // 1. Condition: 5 < ETA <= 10 minutes -> 10-minute alert
    if (etaMinutes <= 10 && etaMinutes > 5) {
      if (!state.tenMinuteSentAt) {
        state.tenMinuteSentAt = Date.now();
        const sendResult = await this.sendBusApproachingSMS({
          phoneNumber,
          busNumber,
          pickupPoint,
          etaMinutes: 10,
          alertType: '10_MIN'
        });
        return {
          action: 'SENT_10_MIN',
          details: {
            etaMinutes,
            smsResult: sendResult
          }
        };
      } else {
        // Suppress duplicate 10-minute alert (e.g. at 9 min, 8 min)
        return {
          action: 'SUPPRESSED_10_MIN',
          details: {
            etaMinutes,
            firstSentAt: new Date(state.tenMinuteSentAt).toISOString(),
            reason: '10-minute alert already sent for this approach. Suppressing duplicate.'
          }
        };
      }
    }

    // 2. Condition: ETA <= 5 minutes -> 5-minute urgent alert
    if (etaMinutes <= 5 && etaMinutes >= 0) {
      if (!state.fiveMinuteSentAt) {
        state.fiveMinuteSentAt = Date.now();
        const sendResult = await this.sendBusApproachingSMS({
          phoneNumber,
          busNumber,
          pickupPoint,
          etaMinutes: 5,
          alertType: '5_MIN'
        });
        return {
          action: 'SENT_5_MIN',
          details: {
            etaMinutes,
            smsResult: sendResult
          }
        };
      } else {
        // Suppress duplicate 5-minute alert (e.g. at 4 min, 3 min)
        return {
          action: 'SUPPRESSED_5_MIN',
          details: {
            etaMinutes,
            firstSentAt: new Date(state.fiveMinuteSentAt).toISOString(),
            reason: '5-minute alert already sent for this approach. Suppressing duplicate.'
          }
        };
      }
    }

    return {
      action: 'NO_ACTION',
      details: {
        etaMinutes,
        reason: etaMinutes > 10 ? 'Bus is more than 10 minutes away.' : 'Bus passed pickup point.'
      }
    };
  }

  /**
   * Resets notification state for a bus/student/pickup point (e.g., when a trip finishes)
   */
  resetState(busId, studentIdOrPhone, pickupPoint) {
    const stateKey = this.getStateKey(busId, studentIdOrPhone, pickupPoint);
    this.alertStates.delete(stateKey);
  }

  /**
   * Clear all notification states
   */
  clearAllStates() {
    this.alertStates.clear();
  }

  /**
   * Returns current notification state for a bus/student
   */
  getState(busId, studentIdOrPhone, pickupPoint) {
    const stateKey = this.getStateKey(busId, studentIdOrPhone, pickupPoint);
    return this.alertStates.get(stateKey) || null;
  }

  /**
   * Simulates ETA progression sequence [12, 10, 9, 5, 4] to verify notification rules & deduplication.
   * If sendRealSMS is true, triggers actual SMS through Twilio for triggered steps.
   * 
   * @param {Object} params
   * @param {string} params.phoneNumber - Recipient phone number
   * @param {string} [params.busNumber="10C"]
   * @param {string} [params.pickupPoint="Main Campus Entrance Gate"]
   * @param {boolean} [params.sendRealSMS=false] - Whether to call Twilio or simulate ETA conditions
   * @param {number[]} [params.etaSequence=[12, 10, 9, 5, 4]]
   * @returns {Promise<Array<{ eta: number, action: string, smsSent: boolean, details: Object }>>}
   */
  async simulateEtaProgression({
    phoneNumber,
    busNumber = '10C',
    busId = 'rec_bus_10c',
    pickupPoint = 'Main Campus Entrance Gate (NH 48)',
    sendRealSMS = false,
    etaSequence = [12, 10, 9, 5, 4]
  }) {
    // Reset state before starting simulation sequence
    this.resetState(busId, phoneNumber, pickupPoint);

    const simulationResults = [];

    for (const eta of etaSequence) {
      if (sendRealSMS) {
        // Run with actual Twilio SMS dispatch
        const step = await this.evaluateAndTriggerNotification({
          phoneNumber,
          busId,
          busNumber,
          pickupPoint,
          etaMinutes: eta
        });
        simulationResults.push({
          eta,
          action: step.action,
          smsSent: step.action === 'SENT_10_MIN' || step.action === 'SENT_5_MIN',
          details: step.details
        });
      } else {
        // Run ETA deduplication logic without calling external SMS provider
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
          details = { message: `ETA ${eta} min > 10 min window. No SMS triggered.` };
        } else if (eta <= 10 && eta > 5) {
          if (!state.tenMinuteSentAt) {
            state.tenMinuteSentAt = Date.now();
            action = 'SENT_10_MIN';
            smsSent = true;
            details = { message: `10-minute alert triggered for ETA=${eta} min.` };
          } else {
            action = 'SUPPRESSED_10_MIN';
            smsSent = false;
            details = { message: `Duplicate 10-minute alert suppressed for ETA=${eta} min.` };
          }
        } else if (eta <= 5 && eta >= 0) {
          if (!state.fiveMinuteSentAt) {
            state.fiveMinuteSentAt = Date.now();
            action = 'SENT_5_MIN';
            smsSent = true;
            details = { message: `5-minute alert triggered for ETA=${eta} min.` };
          } else {
            action = 'SUPPRESSED_5_MIN';
            smsSent = false;
            details = { message: `Duplicate 5-minute alert suppressed for ETA=${eta} min.` };
          }
        }

        simulationResults.push({ eta, action, smsSent, details });
      }
    }

    return simulationResults;
  }
}

// Export singleton instance
export const notificationService = new NotificationService();
export default notificationService;
