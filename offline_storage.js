/**
 * REC Campus Mobility — Persistent Offline Storage Engine (IndexedDB)
 * 
 * Provides production-grade offline caching for:
 * - REC campus map image blob
 * - Active verified buses
 * - Routes and bus stops
 * - Static bus positions and last-known GPS coordinates
 * 
 * In accordance with engineering requirements:
 * - Backend database is the source of truth.
 * - IndexedDB is the read-only offline fallback.
 * - localStorage is NOT used as the primary database.
 */

const DB_NAME = 'RECTransportOfflineDB';
const DB_VERSION = 1;

class TransportOfflineStorage {
  constructor() {
    this.db = null;
    this.isOnline = navigator.onLine;
    this.initPromise = this.init();

    window.addEventListener('online', () => {
      this.isOnline = true;
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
    });
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('buses')) {
          db.createObjectStore('buses', { keyPath: 'busId' });
        }
        if (!db.objectStoreNames.contains('routes')) {
          db.createObjectStore('routes', { keyPath: 'routeNumber' });
        }
        if (!db.objectStoreNames.contains('stops')) {
          db.createObjectStore('stops', { keyPath: 'stopId' });
        }
        if (!db.objectStoreNames.contains('assets')) {
          db.createObjectStore('assets', { keyPath: 'key' });
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      request.onerror = (e) => {
        console.error('[IndexedDB] Init error:', e.target.error);
        reject(e.target.error);
      };
    });
  }

  async syncWithBackend(baseUrl = '') {
    await this.initPromise;
    try {
      // 1. Fetch Buses
      const busRes = await fetch(`${baseUrl}/api/buses?includeInactive=true`);
      if (busRes.ok) {
        const buses = await busRes.json();
        await this.putAll('buses', buses);
      }

      // 2. Fetch Routes
      const routeRes = await fetch(`${baseUrl}/api/routes`);
      if (routeRes.ok) {
        const routes = await routeRes.json();
        await this.putAll('routes', routes);
      }

      // 3. Fetch Stops
      const stopRes = await fetch(`${baseUrl}/api/stops`);
      if (stopRes.ok) {
        const stops = await stopRes.json();
        await this.putAll('stops', stops);
      }

      // 4. Cache Map Image Blob
      await this.cacheMapAsset('assets/rec_thandalam_bus_map_hd.jpg');

      // Update sync meta
      await this.putItem('assets', {
        key: 'last_sync',
        timestamp: new Date().toISOString()
      });

      return { success: true };
    } catch (err) {
      console.warn('[OfflineStorage] Sync failed, operating from cached IndexedDB:', err);
      return { success: false, error: err };
    }
  }

  async cacheMapAsset(url) {
    try {
      const existing = await this.getItem('assets', 'map_image_blob');
      if (existing && existing.blob) return;

      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        await this.putItem('assets', {
          key: 'map_image_blob',
          blob: blob,
          url: url,
          cachedAt: new Date().toISOString()
        });
      }
    } catch (err) {
      console.warn('[OfflineStorage] Could not pre-cache map image blob:', err);
    }
  }

  async getMapImageBlobUrl(fallbackUrl = 'assets/rec_thandalam_bus_map_hd.jpg') {
    await this.initPromise;
    try {
      const item = await this.getItem('assets', 'map_image_blob');
      if (item && item.blob) {
        return URL.createObjectURL(item.blob);
      }
    } catch (err) {}
    return fallbackUrl;
  }

  async getAllBuses(activeOnly = true) {
    await this.initPromise;
    const all = await this.getAll('buses');
    if (activeOnly) {
      return all.filter(b => b.isActive !== false);
    }
    return all;
  }

  async getBusById(id) {
    await this.initPromise;
    const lower = id.toLowerCase();
    const all = await this.getAll('buses');
    return all.find(b => b.busId.toLowerCase() === lower || b.busNumber.toLowerCase() === lower);
  }

  async getAllRoutes() {
    await this.initPromise;
    return await this.getAll('routes');
  }

  async getAllStops() {
    await this.initPromise;
    return await this.getAll('stops');
  }

  // --- IndexedDB Generic Helpers ---

  putItem(storeName, item) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(item);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  getItem(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([storeName], 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  getAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([storeName], 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  putAll(storeName, items) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      for (const item of items) {
        store.put(item);
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
}

export const offlineStorage = new TransportOfflineStorage();
