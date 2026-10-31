# 🚀 Campus Mobility — Quick Start Guide

Welcome! Here is how to run this project on your computer in under 1 minute.

---

## 📋 Prerequisites
Make sure you have **Node.js** (v18 or newer) installed:
- Check with: `node -v`
- If not installed, download from [nodejs.org](https://nodejs.org/)

---

## ⚡ Quick Start (3 Steps)

### Step 1: Install Dependencies
Open your terminal inside this folder and run:
```bash
npm install
```

### Step 2: Start the Server
```bash
npm start
```
*(or `node server.js`)*

### Step 3: Open in Browser
Once running, open these URLs in your web browser:
- 🗺️ **Student / Navigation Map:** [http://localhost:3500](http://localhost:3500)
- 🚌 **Bus Driver GPS Cockpit:** [http://localhost:3500/driver.html](http://localhost:3500/driver.html)

---

## 📱 Mobile / Wi-Fi Access
To test this on your phone while connected to the same Wi-Fi:
1. Find your computer's local IP address (`ipconfig` on Windows, or `ifconfig` / `ipconfig getifaddr en0` on Mac).
2. Open on your phone: `http://<YOUR_COMPUTER_IP>:3500`

---

## 🧪 Running the Tests
To verify all routing and SMS notification deduplication test suites:
```bash
# Telemetry routing flow tests
node test_real_telemetry_flow.js

# SMS alert & deduplication tests
node test_sms_notification_flow.js
```
