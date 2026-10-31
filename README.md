# ACIMS Real SMS Notification System (Twilio Integration)

A production-grade, real-time SMS alert engine for the **Rajalakshmi Engineering College (REC) Campus Mobility / ACIMS** project. When a student's assigned transit bus approaches their designated pickup location, the system automatically transmits an **actual SMS** directly to the student's registered mobile number using **Twilio's official API**.

---

## Architecture Overview

```
[ Driver Cockpit (driver.html) ]
             │  (Real Device GPS via POST /api/buses/:id/telemetry)
             ▼
[ Campus Mobility Backend (server.js:3500) ]
   ├── Evaluates Haversine Distance & Transit Speed (km/h)
   ├── Computes Real-Time Pickup ETA (minutes)
   └── notification_service.js (Deduplication State Machine)
             │
             ├── ETA > 10 min ──────► No action (Outside window)
             ├── ETA <= 10 min ─────► Triggers 10-Minute Alert (ONCE)
             ├── ETA 9m, 8m... ─────► SUPPRESSED (Duplicate protection)
             ├── ETA <= 5 min ──────► Triggers 5-Minute Urgent Alert (ONCE)
             ├── ETA 4m, 3m... ─────► SUPPRESSED (Duplicate protection)
             └── Bus moves away ────► Resets state for next scheduled trip
             │
             ▼
[ Twilio Cloud SMS Gateway ]
             │ (Official E.164 Transmission)
             ▼
[ Student Mobile Device (+91XXXXXXXXXX) ]
   "ACIMS Alert: Your bus is approximately 10 minutes away from your pickup point. Please be ready."
   "ACIMS Alert: Your bus is approximately 5 minutes away. Please proceed to your pickup point."
```

---

## 1. How to Create a Twilio Account

1. Go to **[twilio.com/try-twilio](https://www.twilio.com/try-twilio)** and sign up for a free account.
2. Verify your email address and personal mobile number.
3. Answer the onboarding questionnaire:
   - Which Twilio product are you using? **SMS**
   - What are you building? **Alerts & Notifications**
   - Which language? **Node.js**
4. Once completed, you will land on the **Twilio Console Dashboard**.

---

## 2. How to Obtain the Required Credentials

From your **[Twilio Console Dashboard](https://console.twilio.com/)**:

1. Under the **Account Info** section on the main dashboard, locate:
   - **Account SID**: A 34-character string starting with `AC` (e.g., `ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`).
   - **Auth Token**: Click **Show** to reveal the secret authentication token.
2. Under **Phone Numbers**:
   - Click **Get a Twilio Phone Number** (or navigate to **Phone Numbers** > **Manage** > **Active numbers**).
   - Twilio will allocate you a trial number formatted in E.164 (e.g., `+18005550199`).
   - Copy this number into your records.

---

## 3. How to Configure Environment Variables (`.env`)

In the project root directory, create a `.env` file (copied from `.env.example`):

```bash
cp .env.example .env
```

Open `.env` in an editor and enter your Twilio credentials:

```env
# Twilio SMS Credentials
TWILIO_ACCOUNT_SID=ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TWILIO_AUTH_TOKEN=your_real_auth_token_here
TWILIO_PHONE_NUMBER=+1234567890

# Server Port (default 3500)
PORT=3500
```

> ⚠️ **Security Rules**:
> - Never hardcode credentials in JavaScript or TypeScript files.
> - Never commit `.env` to Git (it is already included in `.gitignore`).

---

## 4. How to Verify Recipient Phone Numbers (Twilio Trial Accounts)

If you are using a **free Twilio trial account**, Twilio only allows sending SMS messages to **pre-verified phone numbers** to prevent spam:

1. Open the Twilio Console:
   👉 **[Twilio Verified Caller IDs](https://console.twilio.com/us1/develop/phone-numbers/manage/verified)**
2. Click **Add a new Caller ID** (+ button).
3. Select country **India (+91)** and type your 10-digit mobile number (e.g., `9876543210`).
4. Choose **Verify via SMS** or **Voice call**.
5. Enter the 6-digit OTP code received on your phone.
6. Once verified, Twilio will immediately permit live SMS transmission to this number.

*(Note: Upgraded Twilio production accounts can send SMS to any valid mobile number without manual verification).*

---

## 5. How to Run the Backend

Install dependencies:

```bash
npm install
```

Start the campus mobility server:

```bash
node server.js
```

You should see the startup confirmation:

```
[REC Transport Server] Running at http://localhost:3500
[REC Transport Server] REST API available at http://localhost:3500/api/buses
[REC Transport Server] Real-time SSE stream at http://localhost:3500/api/transport/stream
[SMS Service] Twilio SMS active. Sender: +1XXXXXXXXXX
```

Open the web application in your browser:
👉 **`http://localhost:3500`**

---

## 6. How to Test Sending a Real SMS

### Option A: Command-Line Test (Direct CLI Dispatch)

Run the included test script with your Indian mobile number:

```bash
node send_real_test_sms.js 9876543210
```

Or with full E.164 format and custom bus/stop details:

```bash
node send_real_test_sms.js +919876543210 10C "Main Campus Entrance Gate (NH 48)"
```

The script validates the phone number format, contacts Twilio API, and prints the real provider response:
- **Twilio Message SID** (e.g., `SM1234567890abcdef...`)
- **Status** (`queued`, `sent`, `delivered`)
- **Masked recipient number** (`+9198*** **210`)

### Option B: In-App User Interface

1. Open `http://localhost:3500` in your browser.
2. Click the **🔔 SMS Alerts** icon in the top-right toolbar.
3. In the modal, locate the **⚡ Real Twilio SMS Test Dispatch** section.
4. Enter your mobile number and click **🚀 Send Real SMS**.
5. The UI displays the live Twilio confirmation badge and message SID in real-time.

---

## 7. How the ETA Notification Logic Works

The notification engine is driven by live driver telemetry and route geography:

1. **Student Registration**:
   - Name: `Rithvik S`
   - Mobile Number: `+919876543210`
   - Assigned Bus: `Bus 10C` (`rec_bus_10c`)
   - Selected Pickup Point: `Main Campus Entrance Gate (NH 48)` (Coordinates: `13.0124751, 80.0003439`)

2. **Real-time GPS Tracking**:
   - The driver transmits real GPS packets via the driver cockpit (`driver.html`) to `POST /api/buses/rec_bus_10c/telemetry`.
   - The server calculates the Haversine distance between the bus's live coordinates and the student's pickup point.
   - Using the bus speed (or average transit speed 22 km/h), the server computes the arrival ETA in minutes:
     $$\text{ETA (min)} = \left(\frac{\text{Distance (km)}}{\text{Speed (km/h)}}\right) \times 60$$

3. **Deduplication State Machine**:
   | Bus ETA | Trigger Condition | Action Taken |
   | :--- | :--- | :--- |
   | **12 min** | ETA > 10 min | No SMS sent |
   | **10 min** | $5 < \text{ETA} \le 10$ and not previously sent | **Sends 10-Minute SMS** (`SENT_10_MIN`) |
   | **9 min** | $5 < \text{ETA} \le 10$ but already sent | **Suppressed duplicate** (`SUPPRESSED_10_MIN`) |
   | **8 min** | $5 < \text{ETA} \le 10$ but already sent | **Suppressed duplicate** (`SUPPRESSED_10_MIN`) |
   | **5 min** | $\text{ETA} \le 5$ and not previously sent | **Sends 5-Minute Urgent SMS** (`SENT_5_MIN`) |
   | **4 min** | $\text{ETA} \le 5$ but already sent | **Suppressed duplicate** (`SUPPRESSED_5_MIN`) |
   | **Trip Finish** | Bus moves away ($>20$ min) or driver stops trip | **Resets state** for the next scheduled trip |

---

## 8. What Happens When SMS Sending Fails

The failure handling complies with strict safety and reliability guidelines:

- **No System Crash**: If the Twilio API is unreachable, times out, or returns an error, the error is caught safely in a `try/catch` block. The telemetry broadcast and bus tracking continue without interruption.
- **Credential Protection**: Server logs sanitize all outputs. Auth tokens and account SIDs are never logged in stack traces.
- **Student Privacy**: Phone numbers are masked in logs and client UI (`+91 98*** **210`).
- **Honest Status Reporting**: The system never fakes "delivered" status. If Twilio returns `failed` or credentials are unset, the status displays `FAILED` with the corresponding provider error code.
- **Common Twilio Error Codes**:
  - `21608`: Unverified trial number (Verify the phone number in Twilio Console).
  - `21211`: Invalid phone number (Check Indian 10-digit number format).
  - `20003`: Authentication error (Verify Account SID and Auth Token in `.env`).
  - `21614`: Twilio phone number not capable of SMS (Ensure Twilio number has SMS enabled).

---

## 9. Verification & Automated Test Suites

Run the offline unit and deduplication test suite:

```bash
node test_sms_notification_flow.js
```
*(Tests 24 conditions: Indian phone normalization, masking, 12m->10m->9m->5m->4m deduplication, and trip reset).*

Run the live telemetry end-to-end integration test against the running server:

```bash
node test_live_telemetry_sms_integration.js
```
*(Tests 13 conditions: Driver session, real GPS transmission, live ETA calculation, and telemetry-triggered SMS dispatch).*

Run the existing telemetry regression test suite:

```bash
node test_real_telemetry_flow.js
```
*(All 31 original telemetry flow tests pass with zero regressions).*
