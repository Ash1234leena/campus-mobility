/**
 * REC Campus Mobility — Interactive Offline Transport Map Engine
 * 
 * Provides an ultra-smooth, high-performance pan/zoom canvas
 * for the official bundled REC Thandalam campus map image.
 * 
 * Key Features:
 * - 100% offline resilient
 * - 4-Corner Bilinear Calibration transformation for real GPS -> normalized (0..1) map coordinates
 * - Single-bus marker updating (busId -> marker Map) for zero-latency live telemetry updates
 * - Bus number rendered ABOVE the bus icon
 * - Visual status distinction: LIVE (pulsing green), LAST KNOWN (amber/blue), STATIC (slate)
 * - Admin drag-and-drop placement tool
 */

export class TransportMapEngine {
  constructor(containerElement, options = {}) {
    this.container = containerElement;
    this.onBusSelected = options.onBusSelected || (() => {});
    this.onPositionChanged = options.onPositionChanged || (() => {});

    // Calibration configuration (4 corners)
    this.calibration = options.calibration || {
      topLeft: { latitude: 13.01300, longitude: 80.00000 },
      topRight: { latitude: 13.01300, longitude: 80.00620 },
      bottomLeft: { latitude: 13.00680, longitude: 80.00000 },
      bottomRight: { latitude: 13.00680, longitude: 80.00620 },
      isVerified: true
    };

    // Transform State
    this.scale = 1.0;
    this.minScale = 0.5;
    this.maxScale = 8.0;
    this.panX = 0;
    this.panY = 0;

    // Gesture State
    this.isDragging = false;
    this.startX = 0;
    this.startY = 0;
    this.startPanX = 0;
    this.startPanY = 0;

    // Touch pinch state
    this.initialPinchDistance = null;
    this.initialPinchScale = 1.0;

    // Buses & Marker Map (busId -> marker HTMLElement)
    this.buses = [];
    this.markersMap = new Map();
    this.selectedBusId = null;

    // Admin Placement Mode
    this.adminMode = false;
    this.adminActiveBus = null;
    this.adminMarkerCoords = { x: 0.5, y: 0.5 };

    this.initDOM();
    this.initEvents();
  }

  initDOM() {
    this.container.innerHTML = `
      <div class="tmap-viewport" id="tmap-viewport">
        <div class="tmap-content-layer" id="tmap-content-layer">
          <img 
            id="tmap-base-image" 
            class="tmap-base-image" 
            src="assets/rec_thandalam_bus_map_hd.jpg" 
            alt="Official REC Thandalam Campus Bus Map"
            draggable="false"
          />
          <div class="tmap-markers-layer" id="tmap-markers-layer"></div>
          <div class="tmap-admin-placement-layer" id="tmap-admin-layer" style="display: none;"></div>
        </div>
      </div>

      <!-- Floating Map Zoom Controls -->
      <div class="tmap-floating-controls" role="toolbar" aria-label="Bus Map Controls">
        <button class="tmap-ctrl-btn" id="tmap-btn-zoom-in" title="Zoom In (+)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </button>
        <button class="tmap-ctrl-btn" id="tmap-btn-zoom-out" title="Zoom Out (-)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </button>
        <button class="tmap-ctrl-btn" id="tmap-btn-fit-screen" title="Fit to Screen (⤢)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
        <button class="tmap-ctrl-btn" id="tmap-btn-reset-zoom" title="Reset Zoom (⟲)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
        </button>
      </div>

      <!-- Current Zoom Scale Badge -->
      <div class="tmap-zoom-badge" id="tmap-zoom-badge">100%</div>
    `;

    this.viewport = this.container.querySelector('#tmap-viewport');
    this.contentLayer = this.container.querySelector('#tmap-content-layer');
    this.baseImage = this.container.querySelector('#tmap-base-image');
    this.markersLayer = this.container.querySelector('#tmap-markers-layer');
    this.adminLayer = this.container.querySelector('#tmap-admin-layer');
    this.zoomBadge = this.container.querySelector('#tmap-zoom-badge');

    this.baseImage.addEventListener('load', () => {
      this.fitToScreen();
    });
  }

  initEvents() {
    // 1. Mouse Drag & Pan
    this.viewport.addEventListener('mousedown', (e) => {
      if (e.target.closest('.tmap-admin-pin') || e.target.closest('.tmap-bus-marker')) return;
      this.isDragging = true;
      this.startX = e.clientX;
      this.startY = e.clientY;
      this.startPanX = this.panX;
      this.startPanY = this.panY;
      this.viewport.classList.add('is-grabbing');
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.startX;
      const dy = e.clientY - this.startY;
      this.panX = this.startPanX + dx;
      this.panY = this.startPanY + dy;
      this.applyTransform();
    });

    window.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.viewport.classList.remove('is-grabbing');
      }
    });

    // 2. Mouse Wheel Zoom centered at cursor
    this.viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.viewport.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      const delta = e.deltaY < 0 ? 1.15 : 0.87;
      this.zoomAtPoint(cursorX, cursorY, delta);
    }, { passive: false });

    // 3. Touch Gestures (Pinch-to-zoom & Touch-drag)
    this.viewport.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        if (e.target.closest('.tmap-admin-pin')) return;
        this.isDragging = true;
        this.startX = e.touches[0].clientX;
        this.startY = e.touches[0].clientY;
        this.startPanX = this.panX;
        this.startPanY = this.panY;
      } else if (e.touches.length === 2) {
        this.isDragging = false;
        this.initialPinchDistance = this.getTouchDistance(e.touches);
        this.initialPinchScale = this.scale;
      }
    }, { passive: false });

    this.viewport.addEventListener('touchmove', (e) => {
      if (this.isDragging && e.touches.length === 1) {
        e.preventDefault();
        const dx = e.touches[0].clientX - this.startX;
        const dy = e.touches[0].clientY - this.startY;
        this.panX = this.startPanX + dx;
        this.panY = this.startPanY + dy;
        this.applyTransform();
      } else if (e.touches.length === 2 && this.initialPinchDistance) {
        e.preventDefault();
        const dist = this.getTouchDistance(e.touches);
        const factor = dist / this.initialPinchDistance;
        const targetScale = Math.max(this.minScale, Math.min(this.maxScale, this.initialPinchScale * factor));
        
        const rect = this.viewport.getBoundingClientRect();
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;

        this.zoomAtPoint(midX, midY, targetScale / this.scale);
      }
    }, { passive: false });

    this.viewport.addEventListener('touchend', (e) => {
      if (e.touches.length === 0) {
        this.isDragging = false;
        this.initialPinchDistance = null;
      } else if (e.touches.length === 1) {
        this.isDragging = true;
        this.startX = e.touches[0].clientX;
        this.startY = e.touches[0].clientY;
        this.startPanX = this.panX;
        this.startPanY = this.panY;
        this.initialPinchDistance = null;
      }
    });

    // 4. Zoom Buttons
    this.container.querySelector('#tmap-btn-zoom-in')?.addEventListener('click', () => {
      const rect = this.viewport.getBoundingClientRect();
      this.zoomAtPoint(rect.width / 2, rect.height / 2, 1.25);
    });

    this.container.querySelector('#tmap-btn-zoom-out')?.addEventListener('click', () => {
      const rect = this.viewport.getBoundingClientRect();
      this.zoomAtPoint(rect.width / 2, rect.height / 2, 0.8);
    });

    this.container.querySelector('#tmap-btn-fit-screen')?.addEventListener('click', () => {
      this.fitToScreen();
    });

    this.container.querySelector('#tmap-btn-reset-zoom')?.addEventListener('click', () => {
      this.resetZoom();
    });
  }

  getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  zoomAtPoint(x, y, factor) {
    const prevScale = this.scale;
    const nextScale = Math.max(this.minScale, Math.min(this.maxScale, prevScale * factor));
    if (nextScale === prevScale) return;

    this.panX = x - (x - this.panX) * (nextScale / prevScale);
    this.panY = y - (y - this.panY) * (nextScale / prevScale);
    this.scale = nextScale;

    this.applyTransform();
  }

  applyTransform() {
    this.contentLayer.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
    if (this.zoomBadge) {
      this.zoomBadge.textContent = `${Math.round(this.scale * 100)}%`;
    }
  }

  fitToScreen() {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const imgW = this.baseImage.naturalWidth || 1600;
    const imgH = this.baseImage.naturalHeight || 1153;

    if (!vw || !vh) return;

    const scaleX = (vw * 0.94) / imgW;
    const scaleY = (vh * 0.94) / imgH;
    this.scale = Math.min(scaleX, scaleY);
    this.panX = (vw - imgW * this.scale) / 2;
    this.panY = (vh - imgH * this.scale) / 2;

    this.applyTransform();
  }

  resetZoom() {
    this.scale = 1.0;
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const imgW = this.baseImage.naturalWidth || 1600;
    const imgH = this.baseImage.naturalHeight || 1153;

    this.panX = (vw - imgW) / 2;
    this.panY = (vh - imgH) / 2;
    this.applyTransform();
  }

  setCalibration(calibration) {
    if (calibration) {
      this.calibration = calibration;
      this.renderMarkers();
    }
  }

  /**
   * Transforms real GPS (lat, lon) to normalized (x, y) map space [0..1]
   * using persistent 4-Corner Bilinear Calibration (Requirement 11)
   */
  gpsToMapNormalized(lat, lon) {
    const cal = this.calibration;
    if (!cal || !cal.topLeft || !cal.topRight || !cal.bottomLeft || !cal.bottomRight) {
      return null;
    }

    const { topLeft: tl, topRight: tr, bottomLeft: bl, bottomRight: br } = cal;

    // Check boundary with generous buffer (15%) for in-transit buses near campus
    const minLat = Math.min(bl.latitude, br.latitude);
    const maxLat = Math.max(tl.latitude, tr.latitude);
    const minLon = Math.min(tl.longitude, bl.longitude);
    const maxLon = Math.max(tr.longitude, br.longitude);

    const latSpan = maxLat - minLat;
    const lonSpan = maxLon - minLon;
    const latBuffer = latSpan * 0.15;
    const lonBuffer = lonSpan * 0.15;

    if (lat < minLat - latBuffer || lat > maxLat + latBuffer ||
        lon < minLon - lonBuffer || lon > maxLon + lonBuffer) {
      return null; // outside campus boundary
    }

    // Bilinear interpolation inversion:
    // Initial normalized estimates:
    let u = (lon - minLon) / lonSpan;
    let v = (maxLat - lat) / latSpan;

    // 2-step Newton refinement for non-parallel corner quadrilaterals:
    for (let iter = 0; iter < 2; iter++) {
      u = Math.max(0, Math.min(1, u));
      v = Math.max(0, Math.min(1, v));

      const curLat = (1 - u) * (1 - v) * tl.latitude +
                     u * (1 - v) * tr.latitude +
                     (1 - u) * v * bl.latitude +
                     u * v * br.latitude;

      const curLon = (1 - u) * (1 - v) * tl.longitude +
                     u * (1 - v) * tr.longitude +
                     (1 - u) * v * bl.longitude +
                     u * v * br.longitude;

      const dLat = lat - curLat;
      const dLon = lon - curLon;

      u += dLon / lonSpan;
      v -= dLat / latSpan;
    }

    return {
      x: Math.max(0.01, Math.min(0.99, u)),
      y: Math.max(0.01, Math.min(0.99, v))
    };
  }

  /**
   * Resolves authoritative coordinates for a bus:
   * 1. REAL LIVE GPS (status === 'LIVE' & lastLatitude valid)
   * 2. LAST KNOWN REAL GPS (status === 'LAST_KNOWN' & lastLatitude valid)
   * 3. VERIFIED STATIC POSITION (mapX, mapY valid)
   */
  resolveBusPosition(bus) {
    if (bus.lastLatitude !== null && bus.lastLatitude !== undefined &&
        bus.lastLongitude !== null && bus.lastLongitude !== undefined) {
      const projected = this.gpsToMapNormalized(bus.lastLatitude, bus.lastLongitude);
      if (projected) {
        return {
          x: projected.x,
          y: projected.y,
          positionType: bus.status === 'LIVE' ? 'LIVE GPS' : 'LAST KNOWN GPS',
          isGps: true
        };
      }
    }

    // Fall back to verified administrator-configured static map position
    if (bus.mapX !== null && bus.mapX !== undefined && bus.mapY !== null && bus.mapY !== undefined) {
      return {
        x: Number(bus.mapX),
        y: Number(bus.mapY),
        positionType: 'VERIFIED STATIC BAY',
        isGps: false
      };
    }

    return null;
  }

  /**
   * Set buses to render on the offline map
   */
  setBuses(buses, options = {}) {
    this.buses = buses.filter(b => options.includeInactive || b.isActive !== false);
    this.renderMarkers();
  }

  /**
   * Full re-render of all markers
   */
  renderMarkers() {
    this.markersLayer.innerHTML = '';
    this.markersMap.clear();

    for (const bus of this.buses) {
      this.updateSingleBus(bus);
    }
  }

  /**
   * Real-time Single Bus Marker Update (Requirement 20)
   * Updates ONLY the affected bus marker's position, status, and icon
   * without clearing or re-rendering other markers.
   */
  updateSingleBus(bus) {
    if (!bus || !bus.busId) return;

    // Update in internal list
    const idx = this.buses.findIndex(b => b.busId === bus.busId);
    if (idx !== -1) {
      this.buses[idx] = bus;
    } else if (bus.isActive !== false) {
      this.buses.push(bus);
    }

    // If bus is deactivated or deleted, remove marker
    if (bus.isActive === false) {
      this.removeBusMarker(bus.busId);
      return;
    }

    const pos = this.resolveBusPosition(bus);
    if (!pos) {
      // No verified position exists; do NOT render fake marker
      this.removeBusMarker(bus.busId);
      return;
    }

    const isSelected = this.selectedBusId === bus.busId;
    const statusClass = (bus.status || 'STATIC').toLowerCase().replace('_', '-');
    let markerEl = this.markersMap.get(bus.busId);

    if (!markerEl) {
      // Create new marker element
      markerEl = document.createElement('div');
      markerEl.dataset.busId = bus.busId;
      markerEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectBus(bus.busId, true);
      });
      this.markersLayer.appendChild(markerEl);
      this.markersMap.set(bus.busId, markerEl);
    }

    // Update position directly to real coordinates (NO simulation, NO fake animation)
    markerEl.className = `tmap-bus-marker ${statusClass} ${isSelected ? 'is-selected' : ''}`;
    markerEl.style.left = `${pos.x * 100}%`;
    markerEl.style.top = `${pos.y * 100}%`;

    // Render BUS NUMBER ABOVE ICON (Requirement 10 & 24)
    markerEl.innerHTML = `
      <div class="tmap-bus-pill-above">
        <span class="tmap-bus-number">${this.escapeHtml(bus.busNumber)}</span>
        <span class="tmap-status-dot ${statusClass}"></span>
      </div>
      <div class="tmap-bus-icon-wrap ${statusClass}">
        <span class="tmap-bus-icon">🚌</span>
        ${bus.status === 'LIVE' ? '<span class="tmap-pulse-halo"></span>' : ''}
      </div>
    `;
  }

  removeBusMarker(busId) {
    const marker = this.markersMap.get(busId);
    if (marker) {
      marker.remove();
      this.markersMap.delete(busId);
    }
  }

  selectBus(busId, triggerCallback = true) {
    this.selectedBusId = busId;
    for (const [id, marker] of this.markersMap.entries()) {
      if (id === busId) {
        marker.classList.add('is-selected');
      } else {
        marker.classList.remove('is-selected');
      }
    }

    const bus = this.buses.find(b => b.busId === busId);
    if (bus && triggerCallback) {
      this.onBusSelected(bus);
    }
  }

  zoomToBus(busId, targetScale = 2.4) {
    const bus = this.buses.find(b => b.busId === busId);
    if (!bus) return;

    const pos = this.resolveBusPosition(bus);
    if (!pos) return;

    this.selectBus(busId, true);

    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const imgW = this.baseImage.naturalWidth || 1600;
    const imgH = this.baseImage.naturalHeight || 1153;

    this.scale = targetScale;
    this.panX = vw / 2 - (pos.x * imgW * this.scale);
    this.panY = vh / 2 - (pos.y * imgH * this.scale);

    this.applyTransform();
  }

  // --- Administrator Bus Map Positioning Mode ---

  enableAdminPlacementMode(bus, initialCoords = null) {
    this.adminMode = true;
    this.adminActiveBus = bus;
    this.adminLayer.style.display = 'block';

    const coords = initialCoords || {
      x: bus.mapX !== null && bus.mapX !== undefined ? Number(bus.mapX) : 0.45,
      y: bus.mapY !== null && bus.mapY !== undefined ? Number(bus.mapY) : 0.45
    };

    this.updateAdminMarkerPosition(coords.x, coords.y);
    this.zoomToAdminTarget();
  }

  disableAdminPlacementMode() {
    this.adminMode = false;
    this.adminActiveBus = null;
    this.adminLayer.style.display = 'none';
    this.adminLayer.innerHTML = '';
  }

  updateAdminMarkerPosition(x, y) {
    const clampedX = Math.max(0.01, Math.min(0.99, x));
    const clampedY = Math.max(0.01, Math.min(0.99, y));
    this.adminMarkerCoords = { x: clampedX, y: clampedY };

    const busNum = this.adminActiveBus ? this.adminActiveBus.busNumber : '';

    this.adminLayer.innerHTML = `
      <div 
        class="tmap-admin-pin" 
        style="left: ${clampedX * 100}%; top: ${clampedY * 100}%;"
        title="Drag to set bus position"
      >
        <div class="tmap-admin-pin-above">
          <span class="tmap-admin-bus-label">${this.escapeHtml(busNum)}</span>
          <span class="tmap-admin-coords-label">X: ${clampedX.toFixed(4)}, Y: ${clampedY.toFixed(4)}</span>
        </div>
        <div class="tmap-admin-pin-body">
          <span style="font-size: 20px;">🚌</span>
          <div class="tmap-admin-crosshair"></div>
        </div>
      </div>
    `;

    const pinEl = this.adminLayer.querySelector('.tmap-admin-pin');
    this.setupAdminPinDrag(pinEl);

    this.onPositionChanged({
      busId: this.adminActiveBus ? this.adminActiveBus.busId : null,
      busNumber: busNum,
      mapX: clampedX,
      mapY: clampedY
    });
  }

  setupAdminPinDrag(pinEl) {
    let draggingPin = false;

    const onStart = () => {
      draggingPin = true;
      pinEl.classList.add('is-dragging');
    };

    const onMove = (clientX, clientY) => {
      if (!draggingPin) return;
      const rect = this.contentLayer.getBoundingClientRect();
      const newX = (clientX - rect.left) / rect.width;
      const newY = (clientY - rect.top) / rect.height;
      this.updateAdminMarkerPosition(newX, newY);
    };

    const onEnd = () => {
      if (draggingPin) {
        draggingPin = false;
        pinEl.classList.remove('is-dragging');
      }
    };

    pinEl.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      onStart();
    });

    window.addEventListener('mousemove', (e) => {
      if (draggingPin) {
        e.preventDefault();
        onMove(e.clientX, e.clientY);
      }
    });

    window.addEventListener('mouseup', onEnd);

    pinEl.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      if (e.touches.length === 1) {
        onStart();
      }
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (draggingPin && e.touches.length === 1) {
        e.preventDefault();
        onMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: false });

    window.addEventListener('touchend', onEnd);
  }

  zoomToAdminTarget() {
    const coords = this.adminMarkerCoords;
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const imgW = this.baseImage.naturalWidth || 1600;
    const imgH = this.baseImage.naturalHeight || 1153;

    this.scale = 2.0;
    this.panX = vw / 2 - (coords.x * imgW * this.scale);
    this.panY = vh / 2 - (coords.y * imgH * this.scale);
    this.applyTransform();
  }

  getAdminCoords() {
    return this.adminMarkerCoords;
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
