/**
 * REC Campus Mobility — Real Bus Fleet Manager
 * 
 * Source of Truth: Backend REST Database (/api/buses) & Real-Time SSE Stream (/api/transport/stream)
 * Offline Fallback: IndexedDB (offlineStorage)
 * Canonical Bus Identifier: bus.busId (e.g. "rec_bus_10c")
 * 
 * Strictly complies with:
 * - Zero simulated movement, fake GPS, or hardcoded coordinates
 * - Real server-to-client telemetry streaming (SSE)
 * - Server-verified live status (LIVE, LAST_KNOWN, STATIC, INACTIVE)
 * - Fallback to IndexedDB when offline (never labeling cached data as LIVE)
 * - Empty state if database contains zero buses
 */

import { offlineStorage } from './offline_storage.js';

export class BusFleetManager {
  constructor(options = {}) {
    this.onBusUpdated = options.onBusUpdated || (() => {});
    this.onConnectionStateChange = options.onConnectionStateChange || (() => {});
    this.onCalibrationUpdated = options.onCalibrationUpdated || (() => {});
    
    this.buses = [];
    this.isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    this.connectionState = this.isOnline ? 'CONNECTING' : 'OFFLINE';
    this.eventSource = null;
    this.calibration = null;
    this.activeDriverSession = null;

    // Optional same-browser fast channel (never relied upon as the real-time transport)
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('rec_bus_telemetry_channel') : null;
    if (this.channel) {
      this.channel.onmessage = (event) => {
        if (event.data && event.data.bus) {
          this.handleLocalTelemetry(event.data.bus);
        }
      };
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.isOnline = true;
        this.setConnectionState('RECONNECTING');
        this.syncWithBackend();
        this.setupSSE();
      });

      window.addEventListener('offline', () => {
        this.isOnline = false;
        this.setConnectionState('OFFLINE');
        if (this.eventSource) {
          this.eventSource.close();
          this.eventSource = null;
        }
        // When going offline, ensure cached buses do not falsely report LIVE
        this.demoteLiveBusesToOffline();
      });
    }

    // Initialize data load and SSE stream
    this.initLoadPromise = this.initialLoad();
    this.setupSSE();
  }

  setConnectionState(state) {
    if (this.connectionState !== state) {
      this.connectionState = state;
      this.onConnectionStateChange(state);
    }
  }

  /**
   * Initializes bus fleet from backend database; falls back to IndexedDB if unavailable.
   */
  async initialLoad() {
    // 1. Try loading authoritative database from backend
    try {
      const res = await fetch('/api/buses?includeInactive=false');
      if (res.ok) {
        const data = await res.json();
        this.buses = Array.isArray(data) ? data : [];
        // Asynchronously sync to IndexedDB for offline resilience
        offlineStorage.syncWithBackend().catch(err => console.warn('[BusFleetManager] Cache sync notice:', err));
        this.setConnectionState('CONNECTED');
        this.onBusUpdated(null);
        return this.buses;
      }
    } catch (e) {
      console.warn('[BusFleetManager] Backend unreachable during init, falling back to IndexedDB:', e.message);
    }

    // 2. Fall back to offline IndexedDB
    try {
      const cached = await offlineStorage.getAllBuses(true);
      if (cached && cached.length > 0) {
        // Demote any previously-live buses so cached data is never labeled LIVE offline
        this.buses = cached.map(b => {
          const clone = { ...b };
          if (clone.status === 'LIVE') {
            clone.status = clone.lastLatitude !== null ? 'LAST_KNOWN' : 'STATIC';
            clone.speed = 0;
          }
          return clone;
        });
        this.setConnectionState('OFFLINE');
        this.onBusUpdated(null);
        return this.buses;
      }
    } catch (err) {
      console.warn('[BusFleetManager] IndexedDB fallback read error:', err);
    }

    // 3. Database is completely empty
    this.buses = [];
    this.setConnectionState(this.isOnline ? 'CONNECTED' : 'OFFLINE');
    this.onBusUpdated(null);
    return [];
  }

  /**
   * Demotes all LIVE buses to LAST_KNOWN when going offline so cached data never claims to be LIVE
   */
  demoteLiveBusesToOffline() {
    let changed = false;
    for (const b of this.buses) {
      if (b.status === 'LIVE') {
        b.status = b.lastLatitude !== null ? 'LAST_KNOWN' : 'STATIC';
        b.speed = 0;
        changed = true;
      }
    }
    if (changed) {
      this.onBusUpdated(null);
    }
  }

  /**
   * Connects to Server-Sent Events (SSE) stream for real-time live bus updates
   */
  setupSSE() {
    if (typeof EventSource === 'undefined') {
      console.warn('[BusFleetManager] EventSource not supported in this environment');
      return;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    try {
      this.eventSource = new EventSource('/api/transport/stream');

      this.eventSource.addEventListener('connected', () => {
        this.setConnectionState('CONNECTED');
      });

      this.eventSource.addEventListener('BUS_TELEMETRY', (e) => {
        try {
          const data = JSON.parse(e.data);
          this.handleIncomingTelemetry(data);
        } catch (err) {
          console.error('[BusFleetManager] Error parsing BUS_TELEMETRY SSE:', err);
        }
      });

      this.eventSource.addEventListener('BUS_STATUS_CHANGED', (e) => {
        try {
          const data = JSON.parse(e.data);
          this.handleStatusChange(data);
        } catch (err) {
          console.error('[BusFleetManager] Error parsing BUS_STATUS_CHANGED SSE:', err);
        }
      });

      this.eventSource.addEventListener('BUS_POSITION_UPDATED', (e) => {
        try {
          const bus = JSON.parse(e.data);
          this.handleBusPositionUpdated(bus);
        } catch (err) {
          console.error('[BusFleetManager] Error parsing BUS_POSITION_UPDATED SSE:', err);
        }
      });

      this.eventSource.addEventListener('BUS_CREATED', (e) => {
        try {
          const bus = JSON.parse(e.data);
          this.handleBusUpsert(bus);
        } catch (err) {}
      });

      this.eventSource.addEventListener('BUS_UPDATED', (e) => {
        try {
          const bus = JSON.parse(e.data);
          this.handleBusUpsert(bus);
        } catch (err) {}
      });

      this.eventSource.addEventListener('BUS_DELETED', (e) => {
        try {
          const { busId } = JSON.parse(e.data);
          this.handleBusDeleted(busId);
        } catch (err) {}
      });

      this.eventSource.addEventListener('CALIBRATION_UPDATED', (e) => {
        try {
          const cal = JSON.parse(e.data);
          this.calibration = cal;
          this.onCalibrationUpdated(cal);
        } catch (err) {}
      });

      this.eventSource.onerror = () => {
        this.setConnectionState('RECONNECTING');
      };
    } catch (err) {
      console.warn('[BusFleetManager] SSE initialization error:', err);
    }
  }

  handleIncomingTelemetry(data) {
    if (!data || !data.busId) return;
    const busId = data.busId;
    const idx = this.buses.findIndex(b => b.busId === busId);

    if (idx !== -1) {
      const bus = this.buses[idx];
      bus.lastLatitude = data.latitude !== undefined ? data.latitude : bus.lastLatitude;
      bus.lastLongitude = data.longitude !== undefined ? data.longitude : bus.lastLongitude;
      bus.speed = data.speed !== undefined ? data.speed : bus.speed;
      bus.heading = data.heading !== undefined ? data.heading : bus.heading;
      bus.accuracy = data.accuracy !== undefined ? data.accuracy : bus.accuracy;
      bus.status = data.status || 'LIVE';
      bus.lastGpsUpdate = data.lastGpsUpdate || new Date().toISOString();
      if (data.parkingBay) bus.parkingBay = data.parkingBay;

      this.setConnectionState('LIVE');
      offlineStorage.putItem('buses', bus);
      this.onBusUpdated(bus);
    } else if (data.bus) {
      this.buses.push(data.bus);
      offlineStorage.putItem('buses', data.bus);
      this.onBusUpdated(data.bus);
    }
  }

  handleStatusChange(data) {
    if (!data || !data.busId) return;
    const bus = this.getBusById(data.busId);
    if (bus) {
      bus.status = data.status;
      if (data.status !== 'LIVE') {
        bus.speed = 0;
      }
      offlineStorage.putItem('buses', bus);
      this.onBusUpdated(bus);
    }
  }

  handleBusPositionUpdated(updatedBus) {
    if (!updatedBus || !updatedBus.busId) return;
    const idx = this.buses.findIndex(b => b.busId === updatedBus.busId);
    if (idx !== -1) {
      this.buses[idx] = { ...this.buses[idx], ...updatedBus };
      offlineStorage.putItem('buses', this.buses[idx]);
      this.onBusUpdated(this.buses[idx]);
    }
  }

  handleBusUpsert(bus) {
    if (!bus || !bus.busId) return;
    const idx = this.buses.findIndex(b => b.busId === bus.busId);
    if (idx !== -1) {
      this.buses[idx] = bus;
    } else {
      this.buses.push(bus);
    }
    offlineStorage.putItem('buses', bus);
    this.onBusUpdated(bus);
  }

  handleBusDeleted(busId) {
    const idx = this.buses.findIndex(b => b.busId === busId);
    if (idx !== -1) {
      this.buses.splice(idx, 1);
      offlineStorage.deleteItem('buses', busId);
      this.onBusUpdated(null);
    }
  }

  handleLocalTelemetry(bus) {
    if (!bus || !bus.busId) return;
    const idx = this.buses.findIndex(b => b.busId === bus.busId);
    if (idx !== -1) {
      this.buses[idx] = { ...this.buses[idx], ...bus };
      this.onBusUpdated(this.buses[idx]);
    }
  }

  async syncWithBackend() {
    try {
      const res = await fetch('/api/buses?includeInactive=false');
      if (res.ok) {
        const data = await res.json();
        this.buses = Array.isArray(data) ? data : [];
        await offlineStorage.putAll('buses', this.buses);
        this.setConnectionState('CONNECTED');
        this.onBusUpdated(null);
        return this.buses;
      }
    } catch (err) {
      console.warn('[BusFleetManager] Backend sync failed:', err.message);
    }
    return this.buses;
  }

  getBuses() {
    return this.buses;
  }

  /**
   * Finds a bus using canonical busId with case-insensitive fallback to busNumber
   */
  getBusById(id) {
    if (!id) return null;
    const str = String(id).toLowerCase().trim();
    return this.buses.find(b => 
      (b.busId && b.busId.toLowerCase() === str) ||
      (b.busNumber && b.busNumber.toLowerCase() === str) ||
      (b.id && String(b.id).toLowerCase() === str)
    ) || null;
  }

  /**
   * Driver Session Authorization (Requirement 15)
   * Authenticates and authorizes driver to broadcast for a specific bus
   */
  async createDriverSession(busId) {
    const res = await fetch('/api/driver/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ busId })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Driver authorization failed' }));
      throw new Error(err.error || 'Authorization failed');
    }
    const session = await res.json();
    this.activeDriverSession = session;
    return session;
  }

  /**
   * Real GPS Broadcasting to Backend (Requirement 3)
   * Posts telemetry to POST /api/buses/:busId/telemetry
   * 
   * @param {Object} payload { busId, latitude, longitude, speed, heading, accuracy, isLive, timestamp, parkingBay, token }
   */
  async broadcastTelemetry(payload) {
    const busId = payload.busId;
    if (!busId) {
      throw new Error('Canonical busId is required for broadcastTelemetry');
    }

    const headers = { 'Content-Type': 'application/json' };
    const token = payload.token || (this.activeDriverSession ? this.activeDriverSession.token : null);
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const body = {
      latitude: payload.latitude,
      longitude: payload.longitude,
      speed: payload.speed !== undefined ? payload.speed : 0,
      heading: payload.heading !== undefined ? payload.heading : 0,
      accuracy: payload.accuracy !== undefined ? payload.accuracy : 0,
      isLive: payload.isLive === true,
      parkingBay: payload.parkingBay,
      timestamp: payload.timestamp || new Date().toISOString()
    };

    try {
      const res = await fetch(`/api/buses/${encodeURIComponent(busId)}/telemetry`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      if (res.ok) {
        const result = await res.json();
        if (result.bus) {
          const idx = this.buses.findIndex(b => b.busId === busId);
          if (idx !== -1) {
            this.buses[idx] = result.bus;
            offlineStorage.putItem('buses', result.bus);
          }
          this.broadcastLocalChannel(result.bus);
          this.onBusUpdated(result.bus);
        }
        return result;
      } else {
        const err = await res.json().catch(() => ({ error: 'Telemetry broadcast rejected' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn('[BusFleetManager] Telemetry broadcast network error:', err);
      throw err;
    }
  }

  /**
   * Driver saves parked spot (Requirement 7)
   * Signature strictly: updateBusParkedLocation(busId, latitude, longitude, parkingBay)
   */
  async updateBusParkedLocation(busId, latitude, longitude, parkingBay) {
    if (!busId) throw new Error('busId is required');

    const lat = Number(latitude);
    const lon = Number(longitude);

    if (isNaN(lat) || !isFinite(lat) || isNaN(lon) || !isFinite(lon)) {
      throw new Error('Valid numeric latitude and longitude required to save parked location');
    }

    const bay = typeof parkingBay === 'string' ? parkingBay.trim() : '';

    return await this.broadcastTelemetry({
      busId,
      latitude: lat,
      longitude: lon,
      parkingBay: bay,
      isLive: false,
      speed: 0,
      heading: 0,
      accuracy: 5
    });
  }

  /**
   * Updates normalized mapX / mapY coordinate placement (Admin tool)
   */
  async updateBusMapPosition(busId, mapX, mapY, parkingBay = '') {
    const payload = { mapX, mapY, parkingBay };

    try {
      const res = await fetch(`/api/buses/${encodeURIComponent(busId)}/position`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const updated = await res.json();
        const idx = this.buses.findIndex(b => b.busId === busId);
        if (idx !== -1) {
          this.buses[idx].mapX = updated.mapX;
          this.buses[idx].mapY = updated.mapY;
          if (updated.parkingBay) this.buses[idx].parkingBay = updated.parkingBay;
          offlineStorage.putItem('buses', this.buses[idx]);
        }
        this.onBusUpdated(this.buses[idx]);
        this.broadcastLocalChannel(this.buses[idx]);
        return updated;
      }
    } catch (err) {
      console.warn('[BusFleetManager] Position PATCH failed:', err);
    }

    // Local fallback
    const idx = this.buses.findIndex(b => b.busId === busId);
    if (idx !== -1) {
      this.buses[idx].mapX = mapX;
      this.buses[idx].mapY = mapY;
      if (parkingBay) this.buses[idx].parkingBay = parkingBay;
      offlineStorage.putItem('buses', this.buses[idx]);
      this.onBusUpdated(this.buses[idx]);
    }
    return { success: true, localOnly: true };
  }

  /**
   * Formats a bus record as a destination location for campus search and Dijkstra navigation
   * Without fake fallback coordinates
   */
  formatBusAsLocation(b) {
    if (!b) return null;
    const rawLat = (b.lastLatitude !== null && b.lastLatitude !== undefined) ? b.lastLatitude : (b.latitude || null);
    const rawLon = (b.lastLongitude !== null && b.lastLongitude !== undefined) ? b.lastLongitude : (b.longitude || null);
    const lat = (rawLat !== null && !isNaN(Number(rawLat))) ? Number(rawLat) : null;
    const lon = (rawLon !== null && !isNaN(Number(rawLon))) ? Number(rawLon) : null;

    return {
      id: b.busId,
      name: `Bus #${b.busNumber} — ${b.routeName || b.route || 'REC Transit'}`,
      building_code: `BUS-${b.busNumber}`,
      category: 'Buses',
      description: `🅿️ ${b.parkingBay || 'Campus Bay'} • Driver: ${b.driver || b.driverName || 'Not configured'} (${b.driverContact || b.driverPhone || 'Not configured'}) • Status: ${b.status || 'STATIC'}`,
      latitude: lat,
      longitude: lon,
      lastLatitude: lat,
      lastLongitude: lon,
      connector_node_id: b.stopLocationId ? (b.stopLocationId === 'GATE-01' ? 'node_3881789997' : 'node_12063346492') : 'node_12063346492',
      isBus: true,
      busId: b.busId,
      busNumber: b.busNumber,
      isLive: b.status === 'LIVE',
      speed: b.speed || 0,
      route: b.routeName || b.route || 'Not configured',
      parking_bay: b.parkingBay || 'Campus Bay',
      parkingBay: b.parkingBay || 'Campus Bay',
      driver_name: b.driver || b.driverName || 'Not configured',
      driver_phone: b.driverContact || b.driverPhone || 'Not configured',
      last_gps_timestamp: b.lastGpsUpdate || 'Static Location',
      mapX: b.mapX,
      mapY: b.mapY,
      status: b.status || 'STATIC'
    };
  }

  getAllBusesAsLocations() {
    return this.buses
      .filter(b => b.isActive !== false)
      .map(b => this.formatBusAsLocation(b))
      .filter(Boolean);
  }

  async saveBus(busData) {
    const isNew = !busData.busId || !this.getBusById(busData.busId);
    const url = isNew ? '/api/buses' : `/api/buses/${encodeURIComponent(busData.busId)}`;
    const method = isNew ? 'POST' : 'PUT';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(busData)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || 'Failed to save bus');
    }

    const saved = await res.json();
    await this.syncWithBackend();
    return saved;
  }

  async deleteBus(busId, hard = false) {
    const res = await fetch(`/api/buses/${encodeURIComponent(busId)}?hard=${hard ? 'true' : 'false'}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      throw new Error('Failed to delete bus');
    }
    await this.syncWithBackend();
    return true;
  }

  async getCalibration() {
    try {
      const res = await fetch('/api/transport/calibration');
      if (res.ok) {
        this.calibration = await res.json();
        return this.calibration;
      }
    } catch (err) {
      console.warn('[BusFleetManager] Calibration fetch error:', err);
    }
    return this.calibration;
  }

  async saveCalibration(calibrationData) {
    const res = await fetch('/api/transport/calibration', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(calibrationData)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to update calibration' }));
      throw new Error(err.error || 'Calibration save failed');
    }
    const data = await res.json();
    this.calibration = data.calibration;
    this.onCalibrationUpdated(this.calibration);
    return this.calibration;
  }

  broadcastLocalChannel(bus) {
    if (this.channel) {
      try {
        this.channel.postMessage({
          type: 'BUS_UPDATED',
          bus: bus,
          timestamp: Date.now()
        });
      } catch (e) {}
    }
  }
}
