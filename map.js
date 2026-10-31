/**
 * REC Campus Mobility — High-Definition 3D WebGL Map Engine (MapLibre GL)
 * 
 * Provides:
 * 1. Ultra-high-resolution 2x Retina Google Earth satellite imagery with deep zoom (up to zoom 22).
 * 2. Ultra-clear, high-contrast, illuminated electric light-blue walking path.
 * 3. Translucent holographic 3D building extrusions that keep campus pathways 100% visible.
 * 4. Interactive 3D perspective tilt & camera rotation like Google Earth.
 */

export class CampusMap {
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    // MapLibre uses [lng, lat]
    this.campusCenter = [
      options.campusCenter ? options.campusCenter[1] : 80.003351,
      options.campusCenter ? options.campusCenter[0] : 13.008351
    ];
    this.defaultZoom = 17.5;
    this.onBuildingSelect = options.onBuildingSelect || (() => {});

    this.map = null;
    this.is3D = true; // Default to 3D Google Earth view
    this.currentLayerMode = 'satellite'; // 'satellite' | 'street'

    // Markers
    this.userMarker = null;
    this.destMarker = null;
    this.parkedBusMarkers = [];

    this.rawLocations = [];
    this.walkwayData = null;
    this.activeRouteCoords = null;
    this.isAutoPanEnabled = false;
    this.animationFrameId = null;
    this.dashOffset = 0;

    this.initMap();
  }

  /**
   * Initializes MapLibre GL 3D Map
   */
  initMap() {
    if (typeof maplibregl === 'undefined') {
      console.error('MapLibre GL is not loaded!');
      return;
    }

    const style = this.generateMapStyle('satellite');

    this.map = new maplibregl.Map({
      container: this.containerId,
      style: style,
      center: this.campusCenter,
      zoom: this.defaultZoom,
      minZoom: 15,
      maxZoom: 20.8, // Deep high-res zoom down to walkways without Google black tile cutoff
      pitch: 52,     // 3D Perspective angle like Google Earth
      bearing: -10,  // Clean alignment along REC campus axis
      maxPitch: 75,
      attributionControl: false
    });

    // Navigation Controls (Compass and Zoom)
    this.map.addControl(new maplibregl.NavigationControl({
      showCompass: true,
      showZoom: true,
      visualizePitch: true
    }), 'bottom-right');

    // Drag listener to disable auto-follow if user manually moves camera
    this.map.on('dragstart', () => {
      this.isAutoPanEnabled = false;
    });

    // When map style loads, initialize layers
    this.map.on('load', () => {
      this.initVectorLayers();
      if (this.rawLocations.length > 0) {
        this.renderBuildings(this.rawLocations);
      }
      if (this.walkwayData) {
        this.renderWalkwayNetwork(this.walkwayData);
      }
      if (this.activeRouteCoords) {
        this.drawNavigationRoute(this.activeRouteCoords);
      }
    });
  }

  /**
   * Generates crisp 2x Retina map styles: Google Earth Satellite or Campus Streets
   */
  generateMapStyle(mode) {
    if (mode === 'satellite') {
      return {
        version: 8,
        sources: {
          'satellite-tiles': {
            type: 'raster',
            tiles: [
              // Google Earth Hybrid Satellite at 2x Retina resolution with high-DPI scaling & English labels
              'https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&scale=2&hl=en',
              'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&scale=2&hl=en',
              'https://mt2.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&scale=2&hl=en',
              'https://mt3.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&scale=2&hl=en'
            ],
            tileSize: 256, // 512px data in 256px viewport = 4x pixel density Retina crispness
            maxzoom: 20    // Native tiles stop at zoom 20; MapLibre overscales crisp Retina imagery beyond z20 without black tiles
          }
        },
        layers: [
          {
            id: 'satellite-bg',
            type: 'background',
            paint: {
              'background-color': '#071018'
            }
          },
          {
            id: 'satellite-layer',
            type: 'raster',
            source: 'satellite-tiles',
            minzoom: 0,
            maxzoom: 22,
            paint: {
              'raster-fade-duration': 60
            }
          }
        ]
      };
    } else {
      // Clean Campus Map (OpenStreetMap HOT, watermark-free)
      return {
        version: 8,
        sources: {
          'osm-tiles': {
            type: 'raster',
            tiles: [
              'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
              'https://b.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png'
            ],
            tileSize: 256,
            maxzoom: 19
          }
        },
        layers: [
          {
            id: 'osm-layer',
            type: 'raster',
            source: 'osm-tiles',
            minzoom: 0,
            maxzoom: 22
          }
        ]
      };
    }
  }

  /**
   * Switches map layer mode: 'satellite' (Google Earth 3D) | 'street' (Campus Map)
   */
  switchTileLayer(layerMode) {
    if (layerMode === this.currentLayerMode) return;
    this.currentLayerMode = layerMode;

    const newStyle = this.generateMapStyle(layerMode);
    this.map.setStyle(newStyle);

    this.map.once('style.load', () => {
      this.initVectorLayers();
      if (this.rawLocations.length > 0) {
        this.renderBuildings(this.rawLocations);
      }
      if (this.walkwayData) {
        this.renderWalkwayNetwork(this.walkwayData);
      }
      if (this.activeRouteCoords) {
        this.drawNavigationRoute(this.activeRouteCoords);
      }
    });
  }

  /**
   * Toggles between 3D Google Earth perspective (pitch 55°) and 2D Top-Down (pitch 0°)
   */
  toggle3D() {
    this.is3D = !this.is3D;
    this.map.easeTo({
      pitch: this.is3D ? 55 : 0,
      bearing: this.is3D ? -10 : 0,
      duration: 900
    });
    return this.is3D;
  }

  /**
   * Sets up 3D building extrusions, walkway networks, and ULTRA-CLEAR navigation polyline layers
   */
  initVectorLayers() {
    // 1. Campus Walkways Source (Clear turquoise dashed pathways)
    if (!this.map.getSource('campus-walkways')) {
      this.map.addSource('campus-walkways', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      this.map.addLayer({
        id: 'campus-walkways-line',
        type: 'line',
        source: 'campus-walkways',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#38bdf8',
          'line-width': 2.8,
          'line-dasharray': [3, 4],
          'line-opacity': 0.75
        }
      });
    }

    // 2. 3D Building Extrusions (Translucent holographic glass so walkways & satellite roofs stay crystal clear!)
    if (!this.map.getSource('campus-buildings')) {
      this.map.addSource('campus-buildings', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      // Translucent 3D Extrusion
      this.map.addLayer({
        id: 'campus-buildings-3d',
        type: 'fill-extrusion',
        source: 'campus-buildings',
        paint: {
          'fill-extrusion-color': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            '#00e5ff',
            '#0ea5e9'
          ],
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': 0,
          // Subtle opacity so satellite ground and paths are NOT blocked
          'fill-extrusion-opacity': 0.22
        }
      });

      // Crisp Building Outline on Ground
      this.map.addLayer({
        id: 'campus-buildings-outline',
        type: 'line',
        source: 'campus-buildings',
        paint: {
          'line-color': '#38bdf8',
          'line-width': 1.8,
          'line-opacity': 0.8
        }
      });

      // Click on 3D building to select destination
      this.map.on('click', 'campus-buildings-3d', (e) => {
        if (e.features && e.features.length > 0) {
          const bldgId = e.features[0].properties.id;
          const loc = this.rawLocations.find(l => l.id === bldgId);
          if (loc) {
            this.onBuildingSelect(loc);
          }
        }
      });

      this.map.on('mouseenter', 'campus-buildings-3d', () => {
        this.map.getCanvas().style.cursor = 'pointer';
      });
      this.map.on('mouseleave', 'campus-buildings-3d', () => {
        this.map.getCanvas().style.cursor = '';
      });
    }

    // 3. ULTRA-CLEAR LIGHT-BLUE NAVIGATION ROUTE LAYERS
    // Added AFTER (on top of) buildings so the route is 100% visible and NEVER obscured!
    if (!this.map.getSource('nav-route')) {
      this.map.addSource('nav-route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
    }

    if (!this.map.getSource('nav-route-points')) {
      this.map.addSource('nav-route-points', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
    }

    // Layer 1: High-Contrast Dark Foundation Casing (Guarantees contrast over light concrete & green grass)
    if (!this.map.getLayer('nav-route-casing')) {
      this.map.addLayer({
        id: 'nav-route-casing',
        type: 'line',
        source: 'nav-route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#001326',
          'line-width': 14,
          'line-opacity': 0.95
        }
      });
    }

    // Layer 2: Neon Cyan Glow Halo (#00b4d8)
    if (!this.map.getLayer('nav-route-glow')) {
      this.map.addLayer({
        id: 'nav-route-glow',
        type: 'line',
        source: 'nav-route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#00b4d8',
          'line-width': 9.5,
          'line-opacity': 0.85
        }
      });
    }

    // Layer 3: Vibrant Electric Cyan Core (#00ffff — Maximum visibility light blue)
    if (!this.map.getLayer('nav-route-core')) {
      this.map.addLayer({
        id: 'nav-route-core',
        type: 'line',
        source: 'nav-route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#00ffff', // Ultra-bright neon light-blue
          'line-width': 5.5,
          'line-opacity': 1.0
        }
      });
    }

    // Layer 4: Crisp Center White Beam Flow (#ffffff)
    if (!this.map.getLayer('nav-route-center')) {
      this.map.addLayer({
        id: 'nav-route-center',
        type: 'line',
        source: 'nav-route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': 2.2,
          'line-opacity': 1.0
        }
      });
    }

    // Layer 5: Glowing Turn Nodes / Waypoints
    if (!this.map.getLayer('nav-route-waypoints')) {
      this.map.addLayer({
        id: 'nav-route-waypoints',
        type: 'circle',
        source: 'nav-route-points',
        paint: {
          'circle-radius': 5,
          'circle-color': '#00ffff',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 1.0
        }
      });
    }
  }

  /**
   * Renders the 26 verified REC buildings with 3D extrusions
   */
  renderBuildings(locations) {
    this.rawLocations = locations;
    if (!this.map || !this.map.getSource('campus-buildings')) return;

    const features = [];
    for (const loc of locations) {
      if (loc.polygon && loc.polygon.length >= 3) {
        const ring = loc.polygon.map(pt => [pt[1], pt[0]]);
        if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
          ring.push([ring[0][0], ring[0][1]]);
        }

        features.push({
          type: 'Feature',
          properties: {
            id: loc.id,
            name: loc.name,
            category: loc.category,
            building_code: loc.building_code,
            height: loc.height || 10
          },
          geometry: {
            type: 'Polygon',
            coordinates: [ring]
          }
        });
      }
    }

    this.map.getSource('campus-buildings').setData({
      type: 'FeatureCollection',
      features: features
    });
  }

  /**
   * Renders verified campus walkway network
   */
  renderWalkwayNetwork(walkwayNetwork) {
    this.walkwayData = walkwayNetwork;
    if (!this.map || !this.map.getSource('campus-walkways')) return;

    const nodeMap = new Map();
    for (const n of walkwayNetwork.nodes) {
      nodeMap.set(n.id, [n.lon, n.lat]);
    }

    const features = [];
    for (const edge of walkwayNetwork.edges) {
      const p1 = nodeMap.get(edge.from);
      const p2 = nodeMap.get(edge.to);
      if (p1 && p2) {
        features.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [p1, p2]
          }
        });
      }
    }

    this.map.getSource('campus-walkways').setData({
      type: 'FeatureCollection',
      features: features
    });
  }

  /**
   * Updates real-time user GPS beacon in 3D space
   */
  updateUserLocation(locationData) {
    const lngLat = [locationData.longitude, locationData.latitude];

    if (!this.userMarker) {
      const el = document.createElement('div');
      el.className = 'rec-user-beacon-container';
      el.innerHTML = `
        <div class="user-pulse-ring"></div>
        <div class="user-beacon-core"></div>
        <div class="user-heading-arrow" id="user-heading-arrow"></div>
      `;

      this.userMarker = new maplibregl.Marker({
        element: el,
        anchor: 'center'
      })
        .setLngLat(lngLat)
        .addTo(this.map);
    } else {
      this.userMarker.setLngLat(lngLat);
    }

    // Update heading rotation
    const arrowEl = document.getElementById('user-heading-arrow');
    if (arrowEl && locationData.heading !== null) {
      arrowEl.style.transform = `rotate(${locationData.heading}deg)`;
      arrowEl.style.display = 'block';
    } else if (arrowEl) {
      arrowEl.style.display = 'none';
    }

    // Auto-pan user in 3D if active navigation is following
    if (this.isAutoPanEnabled) {
      this.map.easeTo({
        center: lngLat,
        duration: 800
      });
    }
  }

  /**
   * Places destination pin in 3D space (with dedicated styling for college buses)
   */
  setDestinationMarker(destination) {
    if (this.destMarker) {
      this.destMarker.remove();
      this.destMarker = null;
    }

    if (!destination) return;

    const rawLat = (destination.lastLatitude !== null && destination.lastLatitude !== undefined) ? destination.lastLatitude : destination.latitude;
    const rawLon = (destination.lastLongitude !== null && destination.lastLongitude !== undefined) ? destination.lastLongitude : destination.longitude;

    if (rawLat === null || rawLat === undefined || rawLon === null || rawLon === undefined) {
      return;
    }

    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (isNaN(lat) || isNaN(lon) || !isFinite(lat) || !isFinite(lon)) {
      return;
    }

    const lngLat = [lon, lat];

    const el = document.createElement('div');
    if (destination.isBus) {
      const isLive = Boolean(destination.isLive || destination.status === 'LIVE');
      el.className = 'rec-bus-pin-container' + (isLive ? ' is-live' : '');
      const bay = destination.parking_bay || destination.parkingBay || 'Campus Bay';
      el.innerHTML = `
        <div class="bus-pin-beacon ${isLive ? 'beacon-live' : 'beacon-parked'}"></div>
        <div class="bus-pin-body ${isLive ? 'body-live' : 'body-parked'}">
          <span class="bus-pin-emoji">🚌</span>
          <span class="bus-pin-number">#${destination.busNumber}</span>
          ${isLive ? `<span class="bus-live-badge-pulse">LIVE</span>` : '<span class="bus-parked-badge-tag">PARKED</span>'}
        </div>
        <div class="bus-pin-label">${destination.name} ${isLive ? `(${Math.round(destination.speed || 0)} km/h)` : `(${bay})`}</div>
      `;
    } else {
      el.className = 'rec-dest-pin-container';
      el.innerHTML = `
        <div class="dest-pin-beacon"></div>
        <div class="dest-pin-body">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
            <circle cx="12" cy="10" r="3"></circle>
          </svg>
        </div>
      `;
    }

    this.destMarker = new maplibregl.Marker({
      element: el,
      anchor: 'bottom'
    })
      .setLngLat(lngLat)
      .addTo(this.map);
  }

  /**
   * Renders college buses on the map with real-time live vs parked visual state
   */
  renderParkedBusMarkers(buses, onSelect) {
    if (this.parkedBusMarkers) {
      this.parkedBusMarkers.forEach(m => m.remove());
    }
    this.parkedBusMarkers = [];

    if (!buses || buses.length === 0) return;

    for (const bus of buses) {
      // Resolve latitude and longitude safely from real telemetry / database fields
      const rawLat = (bus.lastLatitude !== null && bus.lastLatitude !== undefined) ? bus.lastLatitude : bus.latitude;
      const rawLon = (bus.lastLongitude !== null && bus.lastLongitude !== undefined) ? bus.lastLongitude : bus.longitude;

      if (rawLat === null || rawLat === undefined || rawLon === null || rawLon === undefined) {
        // Skip buses that have not reported real GPS or parked coordinates yet
        continue;
      }

      const lat = Number(rawLat);
      const lon = Number(rawLon);
      if (isNaN(lat) || isNaN(lon) || !isFinite(lat) || !isFinite(lon)) {
        continue;
      }

      const isLive = Boolean(bus.isLive || bus.status === 'LIVE');
      const el = document.createElement('div');
      el.className = isLive ? 'parked-bus-badge live-bus-badge' : 'parked-bus-badge';
      const speed = Math.round(bus.speed || 0);
      const driverName = bus.driver || bus.driverName || 'REC Driver';
      const bay = bus.parkingBay || bus.parking_bay || 'Campus Parking';
      const timeStr = bus.lastGpsUpdate || bus.lastGpsTimestamp || bus.last_gps_timestamp || 'Active';

      el.title = isLive 
        ? `${bus.name || ('Bus #' + bus.busNumber)} — LIVE GPS BROADCAST (${speed} km/h)\nDriver: ${driverName}`
        : `${bus.name || ('Bus #' + bus.busNumber)} — ${bay}\nSaved GPS: ${timeStr}`;
      
      el.innerHTML = isLive
        ? `<span class="live-beacon-dot"></span><span>🚌 ${bus.busNumber}</span><span class="live-speed-tag">${speed}km/h</span>`
        : `<span>🚌 ${bus.busNumber}</span>`;

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onSelect) onSelect(bus);
      });

      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([lon, lat])
        .addTo(this.map);
      this.parkedBusMarkers.push(marker);
    }
  }

  /**
   * Draws the ULTRA-CLEAR LIGHT-BLUE NAVIGATION PATH in 3D WebGL
   * 
   * Strict Requirement:
   * - Light blue (#00ffff / #00b4d8)
   * - Ultra clear against high-res Google Earth satellite background
   * - Highlighted turn waypoints along the walking path
   * - Rendered above all buildings
   */
  drawNavigationRoute(coordinates) {
    this.activeRouteCoords = coordinates;

    if (!coordinates || coordinates.length < 2) return;

    // Convert [[lat, lon], ...] to [[lng, lat], ...]
    const lngLats = coordinates.map(c => [c[1], c[0]]);

    // 1. Update the LineString
    if (this.map.getSource('nav-route')) {
      this.map.getSource('nav-route').setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: lngLats
          }
        }]
      });
    }

    // 2. Update Turn Waypoints (points at every turn of the route)
    if (this.map.getSource('nav-route-points')) {
      const pointFeatures = lngLats.map((pt, idx) => ({
        type: 'Feature',
        properties: { index: idx },
        geometry: {
          type: 'Point',
          coordinates: pt
        }
      }));

      this.map.getSource('nav-route-points').setData({
        type: 'FeatureCollection',
        features: pointFeatures
      });
    }

    // Smoothly fly camera to show entire route with 3D perspective
    this.focusRoute();
  }

  /**
   * Smoothly frames the entire walking route with Google Earth 3D perspective
   */
  focusRoute() {
    if (!this.activeRouteCoords || this.activeRouteCoords.length < 2) return;
    const lngLats = this.activeRouteCoords.map(c => [c[1], c[0]]);
    const bounds = new maplibregl.LngLatBounds();
    for (const pt of lngLats) {
      bounds.extend(pt);
    }

    this.map.fitBounds(bounds, {
      padding: { top: 120, bottom: 120, left: 70, right: 70 },
      pitch: this.is3D ? 52 : 0,
      maxZoom: 19.8,
      duration: 1100
    });
  }

  /**
   * Clears the active route, waypoints, and destination marker
   */
  clearRoute() {
    this.activeRouteCoords = null;
    if (this.map && this.map.getSource('nav-route')) {
      this.map.getSource('nav-route').setData({
        type: 'FeatureCollection',
        features: []
      });
    }
    if (this.map && this.map.getSource('nav-route-points')) {
      this.map.getSource('nav-route-points').setData({
        type: 'FeatureCollection',
        features: []
      });
    }
    if (this.destMarker) {
      this.destMarker.remove();
      this.destMarker = null;
    }
  }

  /**
   * Toggles visibility of walkway lines
   */
  toggleWalkways(visible) {
    if (this.map && this.map.getLayer('campus-walkways-line')) {
      this.map.setLayoutProperty('campus-walkways-line', 'visibility', visible ? 'visible' : 'none');
    }
  }

  /**
   * Recenters map on user position in 3D perspective (or frames route if GPS acquiring)
   */
  recenterOnUser() {
    if (this.userMarker) {
      this.isAutoPanEnabled = true;
      this.map.flyTo({
        center: this.userMarker.getLngLat(),
        zoom: 18.5,
        pitch: this.is3D ? 58 : 0,
        duration: 1000
      });
    } else if (this.activeRouteCoords && this.activeRouteCoords.length >= 2) {
      this.focusRoute();
    } else {
      this.recenterCampus();
    }
  }

  /**
   * Recenters map on Rajalakshmi Engineering College campus
   */
  recenterCampus() {
    this.map.flyTo({
      center: this.campusCenter,
      zoom: this.defaultZoom,
      pitch: this.is3D ? 52 : 0,
      bearing: -10,
      duration: 1000
    });
  }
}
