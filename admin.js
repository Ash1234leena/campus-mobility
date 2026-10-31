/**
 * REC Campus Mobility — Verified Location Data Manager (Admin & Maintenance)
 * 
 * Provides an in-app management interface to inspect, update, add, export, and import
 * verified REC campus locations, coordinates, and entrance nodes without changing application code.
 */

export class CampusDataManager {
  constructor(initialData, onDataChanged) {
    this.storageKey = 'rec_verified_campus_data_v2';
    this.onDataChanged = onDataChanged || (() => {});
    this.campusData = this.loadData(initialData);
  }

  loadData(initialData) {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.locations && parsed.locations.length > 0) {
          const gate = parsed.locations.find(l => l.id === 'rec_main_gate');
          if (gate && Math.abs(gate.latitude - 13.0124751) < 0.0002) {
            return parsed;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load campus data from localStorage, using default:', e);
    }
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(initialData));
    } catch (e) {}
    return initialData;
  }

  saveData() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.campusData));
    } catch (e) {
      console.error('Failed to save campus data to localStorage:', e);
    }
    this.onDataChanged(this.campusData);
  }

  getAllLocations() {
    return this.campusData.locations || [];
  }

  getLocationById(id) {
    return this.campusData.locations.find(l => l.id === id);
  }

  updateLocation(id, updatedFields) {
    const locIndex = this.campusData.locations.findIndex(l => l.id === id);
    if (locIndex === -1) return false;

    this.campusData.locations[locIndex] = {
      ...this.campusData.locations[locIndex],
      ...updatedFields,
      updated_at: new Date().toISOString()
    };

    this.saveData();
    return true;
  }

  addLocation(newLoc) {
    const location = {
      id: newLoc.id || `rec_loc_${Date.now()}`,
      name: newLoc.name,
      category: newLoc.category || 'Academic',
      building_code: newLoc.building_code || 'REC-EXT',
      description: newLoc.description || '',
      latitude: parseFloat(newLoc.latitude),
      longitude: parseFloat(newLoc.longitude),
      entrance: {
        latitude: parseFloat(newLoc.entrance_latitude || newLoc.latitude),
        longitude: parseFloat(newLoc.entrance_longitude || newLoc.longitude)
      },
      verified: Boolean(newLoc.verified !== false),
      source: newLoc.source || 'Manual Verified Ground Survey',
      polygon: newLoc.polygon || [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    this.campusData.locations.push(location);
    this.saveData();
    return location;
  }

  deleteLocation(id) {
    const index = this.campusData.locations.findIndex(l => l.id === id);
    if (index === -1) return false;
    this.campusData.locations.splice(index, 1);
    this.saveData();
    return true;
  }

  resetToDefault(defaultData) {
    this.campusData = JSON.parse(JSON.stringify(defaultData));
    localStorage.removeItem(this.storageKey);
    this.saveData();
  }

  exportJSON() {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(this.campusData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `rec_campus_data_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  }

  importJSON(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      if (!parsed.locations || !Array.isArray(parsed.locations)) {
        throw new Error('Invalid campus data schema: missing locations array.');
      }
      this.campusData = parsed;
      this.saveData();
      return { success: true, count: parsed.locations.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}
