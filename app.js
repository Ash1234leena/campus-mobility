/**
 * REC Campus Mobility System — Main Application Controller
 * Rajalakshmi Engineering College (REC) In-Campus Real Navigation
 */

import { CampusRouter } from './router.js';
import { LocationManager } from './geolocation.js';
import { CampusMap } from './map.js';
import { CampusDataManager } from './admin.js';
import { BusFleetManager } from './bus_manager.js';
import { TransportMapEngine } from './transport_map_engine.js';
import { offlineStorage } from './offline_storage.js';

class CampusApp {
  constructor() {
    this.campusData = null;
    this.mapEngine = null;
    this.routerEngine = null;
    this.locationManager = null;
    this.dataManager = null;
    this.busManager = null;

    // Transport Map Engine Instances
    this.transportMapEngine = null;
    this.adminMapEngine = null;
    this.currentView = 'campus'; // 'campus' | 'transport'
    this.transportFilter = 'ALL';
    this.selectedRouteFilter = '';
    this.isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    this.adminEditingBusId = null;

    this.selectedDestination = null;
    this.currentActiveRoute = null;
    this.activeCategory = 'All';
    this.isWalkwaysVisible = true;

    this.dom = {};
  }

  async init() {
    this.cacheDomElements();
    this.setupEventListeners();

    try {
      // 1. Load verified REC campus data
      const response = await fetch('./rec_campus_data.json');
      if (!response.ok) throw new Error('Failed to load campus database');
      const rawCampusData = await response.json();

      // 2. Initialize Data Manager (persisted edits / admin maintenance)
      this.dataManager = new CampusDataManager(rawCampusData, (updatedData) => {
        this.onCampusDataUpdated(updatedData);
      });
      this.campusData = this.dataManager.campusData;

      // 3. Initialize Interactive Map
      this.mapEngine = new CampusMap('map', {
        campusCenter: [
          this.campusData.campus_info.center.latitude,
          this.campusData.campus_info.center.longitude
        ],
        defaultZoom: this.campusData.campus_info.default_zoom,
        onBuildingSelect: (loc) => this.selectDestination(loc)
      });

      // 4. Initialize Parked Bus Fleet Manager (Persists locations even with GPS turned off)
      this.busManager = new BusFleetManager({
        onBusUpdated: (bus) => this.onBusLocationUpdated(bus),
        onConnectionStateChange: (state) => this.onConnectionStateChange(state),
        onCalibrationUpdated: (cal) => {
          if (this.transportMapEngine) this.transportMapEngine.setCalibration(cal);
          this.populateCalibrationFields(cal);
        }
      });

      // Await authoritative backend database load before rendering markers
      await this.busManager.initLoadPromise;

      // Render building footprints and walkways
      this.mapEngine.renderBuildings(this.campusData.locations);
      this.mapEngine.renderWalkwayNetwork(this.campusData.walkway_network);

      // Render Parked Buses in PARKWIZ parking bays
      try {
        this.mapEngine.renderParkedBusMarkers(this.busManager.buses, (bus) => {
          this.selectDestination(this.busManager.formatBusAsLocation(bus));
        });
      } catch (busRenderErr) {
        console.warn('Initial bus marker render notice:', busRenderErr);
      }
      this.populateBusSelectOptions();
      this.renderBusModalList();

      // 4. Initialize Pedestrian Router
      this.routerEngine = new CampusRouter(this.campusData);

      // 5. Initialize Real GPS Hardware Tracker
      this.locationManager = new LocationManager({
        campusCenter: [
          this.campusData.campus_info.center.latitude,
          this.campusData.campus_info.center.longitude
        ],
        onLocationUpdate: (loc) => this.handleLocationUpdate(loc),
        onAccuracyWarning: (warn) => this.handleAccuracyWarning(warn),
        onPermissionDenied: (msg) => this.handlePermissionDenied(msg),
        onPositionUnavailable: (msg) => this.handlePositionUnavailable(msg),
        onOffRoute: (data) => this.handleOffRoute(data),
        onArrival: (data) => this.handleArrival(data)
      });

      // Request genuine device GPS permission
      await this.locationManager.startTracking();

      // Initial render of search list and admin list
      this.renderSearchResults();
      this.renderAdminList();

      // 6. Initialize Student Offline Transport Map
      this.initTransportMap();

      // 7. Initialize Admin Transport Management Tabs & Position Tool
      this.initAdminTransportTabs();

      // 8. Connection Status Monitor
      this.initConnectionMonitor();

      // 9. Initialize Real Twilio SMS Notification System
      this.initSmsNotificationSystem();

      console.log('REC Campus Mobility initialized successfully with', this.campusData.locations.length, 'verified locations.');
    } catch (err) {
      console.error('Initialization error:', err);
      this.showToast('Initialization error: ' + err.message);
    }
  }

  cacheDomElements() {
    this.dom = {
      // Top Navigation View Switcher & Status
      btnViewCampus: document.getElementById('btn-view-campus'),
      btnViewTransport: document.getElementById('btn-view-transport'),
      connStatusPill: document.getElementById('conn-status-pill'),
      connStatusLabel: document.getElementById('conn-status-label'),
      mapElement: document.getElementById('map'),
      searchPanel: document.getElementById('search-panel'),
      bottomControls: document.getElementById('bottom-controls'),
      layerSwitcherWrapper: document.getElementById('layer-switcher-wrapper'),

      // Search
      searchInput: document.getElementById('search-dest-input'),
      btnClearSearch: document.getElementById('btn-clear-search'),
      btnDropdownToggle: document.getElementById('btn-dropdown-toggle'),
      searchResultsDropdown: document.getElementById('search-results-dropdown'),
      categoryChipsContainer: document.getElementById('category-chips-container'),

      // Top bar & GPS
      btnGpsStatus: document.getElementById('btn-gps-status'),
      gpsBeaconIndicator: document.getElementById('gps-beacon-indicator'),
      gpsStatusText: document.getElementById('gps-status-text'),
      btnLayerToggle: document.getElementById('btn-layer-toggle'),
      layerPickerMenu: document.getElementById('layer-picker-menu'),
      btnAdminModal: document.getElementById('btn-admin-modal'),

      // Map Controls
      btnToggle3d: document.getElementById('btn-toggle-3d'),
      btnRecenterUser: document.getElementById('btn-recenter-user'),
      btnRecenterCampus: document.getElementById('btn-recenter-campus'),
      btnToggleWalkways: document.getElementById('btn-toggle-walkways'),

      // Destination Details Card
      destinationCard: document.getElementById('destination-card'),
      cardDestCategory: document.getElementById('card-dest-category'),
      cardDestCode: document.getElementById('card-dest-code'),
      cardDestName: document.getElementById('card-dest-name'),
      cardDestDesc: document.getElementById('card-dest-desc'),
      cardDestCoords: document.getElementById('card-dest-coords'),
      metricDistance: document.getElementById('metric-distance'),
      metricDuration: document.getElementById('metric-duration'),
      metricProvider: document.getElementById('metric-provider'),
      btnStartNavigation: document.getElementById('btn-start-navigation'),
      btnToggleSteps: document.getElementById('btn-toggle-steps'),
      turnDirectionsDrawer: document.getElementById('turn-directions-drawer'),
      btnCloseCard: document.getElementById('btn-close-card'),

      // Active Navigation HUD
      activeNavHud: document.getElementById('active-nav-hud'),
      hudManeuverIcon: document.getElementById('hud-maneuver-icon'),
      hudInstructionText: document.getElementById('hud-instruction-text'),
      hudDestinationName: document.getElementById('hud-destination-name'),
      hudRemainingDist: document.getElementById('hud-remaining-dist'),
      hudRemainingTime: document.getElementById('hud-remaining-time'),
      btnStopNavigation: document.getElementById('btn-stop-navigation'),

      // Off-route & Arrival
      offRouteBanner: document.getElementById('off-route-banner'),
      arrivalModal: document.getElementById('arrival-modal'),
      arrivalDestName: document.getElementById('arrival-dest-name'),
      btnDismissArrival: document.getElementById('btn-dismiss-arrival'),

      // Modals
      gpsModal: document.getElementById('gps-diagnostic-modal'),
      btnCloseGpsModal: document.getElementById('btn-close-gps-modal'),
      diagStatus: document.getElementById('diag-status'),
      diagCoords: document.getElementById('diag-coords'),
      diagAccuracy: document.getElementById('diag-accuracy'),
      diagRecDist: document.getElementById('diag-rec-dist'),
      diagSpeed: document.getElementById('diag-speed'),
      gpsPermissionWarning: document.getElementById('gps-permission-warning'),
      btnRetryGps: document.getElementById('btn-retry-gps'),
      btnTestMainGate: document.getElementById('btn-test-main-gate'),

      adminModal: document.getElementById('admin-modal'),
      btnCloseAdminModal: document.getElementById('btn-close-admin-modal'),
      adminLocationsList: document.getElementById('admin-locations-list'),
      adminLocCount: document.getElementById('admin-loc-count'),
      inputCartoApiKey: document.getElementById('input-carto-api-key'),
      btnSaveApiKey: document.getElementById('btn-save-api-key'),
      btnExportData: document.getElementById('btn-export-data'),
      inputImportData: document.getElementById('input-import-data'),
      btnResetDefaultData: document.getElementById('btn-reset-default-data'),

      // Admin Modal Tabs & Bus Management
      tabBtnLocations: document.getElementById('tab-btn-locations'),
      tabBtnBuses: document.getElementById('tab-btn-buses'),
      tabBtnBusPosition: document.getElementById('tab-btn-bus-position'),
      tabBtnCalibration: document.getElementById('tab-btn-calibration'),
      adminPaneLocations: document.getElementById('admin-pane-locations'),
      adminPaneBuses: document.getElementById('admin-pane-buses'),
      adminPaneBusPosition: document.getElementById('admin-pane-bus-position'),
      adminPaneCalibration: document.getElementById('admin-pane-calibration'),
      adminLocTabCount: document.getElementById('admin-loc-tab-count'),
      adminBusTabCount: document.getElementById('admin-bus-tab-count'),
      adminFleetCount: document.getElementById('admin-fleet-count'),

      // Calibration Form
      calTlLat: document.getElementById('cal-tl-lat'),
      calTlLon: document.getElementById('cal-tl-lon'),
      calTrLat: document.getElementById('cal-tr-lat'),
      calTrLon: document.getElementById('cal-tr-lon'),
      calBlLat: document.getElementById('cal-bl-lat'),
      calBlLon: document.getElementById('cal-bl-lon'),
      calBrLat: document.getElementById('cal-br-lat'),
      calBrLon: document.getElementById('cal-br-lon'),
      btnSaveCalibration: document.getElementById('btn-save-calibration'),
      calStatusText: document.getElementById('cal-status-text'),

      // Admin Bus Form
      btnAdminAddBusToggle: document.getElementById('btn-admin-add-bus-toggle'),
      adminBusFormContainer: document.getElementById('admin-bus-form-container'),
      adminBusFormTitle: document.getElementById('admin-bus-form-title'),
      formBusNum: document.getElementById('form-bus-num'),
      formBusPlate: document.getElementById('form-bus-plate'),
      formBusRoute: document.getElementById('form-bus-route'),
      formBusBay: document.getElementById('form-bus-bay'),
      formBusDriver: document.getElementById('form-bus-driver'),
      formBusPhone: document.getElementById('form-bus-phone'),
      formBusDeptTime: document.getElementById('form-bus-dept-time'),
      formBusArrTime: document.getElementById('form-bus-arr-time'),
      formBusStops: document.getElementById('form-bus-stops'),
      btnCancelBusForm: document.getElementById('btn-cancel-bus-form'),
      btnSaveBusForm: document.getElementById('btn-save-bus-form'),
      adminBusTableContainer: document.getElementById('admin-bus-table-container'),

      // Admin Bus Position Canvas & Controls
      adminPosBusSelect: document.getElementById('admin-pos-bus-select'),
      adminPosBusName: document.getElementById('admin-pos-bus-name'),
      adminPosValX: document.getElementById('admin-pos-val-x'),
      adminPosValY: document.getElementById('admin-pos-val-y'),
      adminPosBayDesc: document.getElementById('admin-pos-bay-desc'),
      btnAdminSaveBusPos: document.getElementById('btn-admin-save-bus-pos'),
      adminMapPositionContainer: document.getElementById('admin-map-position-container'),

      // College Bus Fleet Modal Elements (Legacy Floating Modal)
      btnBusModal: document.getElementById('btn-bus-modal'),
      busModal: document.getElementById('bus-tracker-modal'),
      btnCloseBusModal: document.getElementById('btn-close-bus-modal'),
      busSearchInput: document.getElementById('bus-search-input'),
      busSelectToSave: document.getElementById('bus-select-to-save'),
      busBayNameInput: document.getElementById('bus-bay-name-input'),
      btnSaveCurrentGpsBus: document.getElementById('btn-save-current-gps-bus'),
      busFleetListContainer: document.getElementById('bus-fleet-list-container'),

      // Student Dedicated Transport Bus Map View Elements
      transportMapView: document.getElementById('transport-map-view'),
      tmapSearchInput: document.getElementById('tmap-search-input'),
      tmapBtnClearSearch: document.getElementById('tmap-btn-clear-search'),
      tmapConnectionBadge: document.getElementById('tmap-connection-badge'),
      tmapConnectionText: document.getElementById('tmap-connection-text'),
      tmapBtnAllBuses: document.getElementById('tmap-btn-all-buses'),
      tmapFilterActive: document.getElementById('tmap-filter-active'),
      tmapFilterLive: document.getElementById('tmap-filter-live'),
      tmapFilterLastKnown: document.getElementById('tmap-filter-last-known'),
      tmapFilterStatic: document.getElementById('tmap-filter-static'),
      tmapRouteFilter: document.getElementById('tmap-route-filter'),
      tmapCanvasContainer: document.getElementById('transport-map-canvas-container'),
      tCountAll: document.getElementById('t-count-all'),
      tCountActive: document.getElementById('t-count-active'),
      tCountLive: document.getElementById('t-count-live'),
      tCountLastKnown: document.getElementById('t-count-last-known'),
      tCountStatic: document.getElementById('t-count-static'),

      // Student Bus Details Card
      tcard: document.getElementById('transport-bus-detail-card'),
      tcardBusNum: document.getElementById('tcard-bus-number'),
      tcardStatusBadge: document.getElementById('tcard-status-badge'),
      tcardPosType: document.getElementById('tcard-pos-type'),
      tcardRouteName: document.getElementById('tcard-route-name'),
      tcardBayLocation: document.getElementById('tcard-bay-location'),
      tcardPlate: document.getElementById('tcard-plate'),
      tcardDriver: document.getElementById('tcard-driver'),
      tcardSchedule: document.getElementById('tcard-schedule'),
      tcardLastUpdated: document.getElementById('tcard-last-updated'),
      tcardBoardingPoints: document.getElementById('tcard-boarding-points'),
      tcardBtnNavigateToBay: document.getElementById('tcard-btn-navigate-to-bay'),
      tcardBtnClose: document.getElementById('tcard-btn-close')
    };
  }

  setupEventListeners() {
    // View Switcher (Campus Navigation vs Dedicated Transport Bus Map)
    if (this.dom.btnViewCampus) {
      this.dom.btnViewCampus.addEventListener('click', () => this.switchView('campus'));
    }
    if (this.dom.btnViewTransport) {
      this.dom.btnViewTransport.addEventListener('click', () => this.switchView('transport'));
    }

    // Search input & Student Dropdown Menu
    this.dom.searchInput.addEventListener('input', () => {
      const q = this.dom.searchInput.value.trim();
      this.dom.btnClearSearch.style.display = q.length > 0 ? 'flex' : 'none';
      this.renderSearchResults();
    });

    this.dom.searchInput.addEventListener('focus', () => {
      this.renderSearchResults();
    });

    this.dom.searchInput.addEventListener('click', () => {
      this.renderSearchResults();
    });

    if (this.dom.btnDropdownToggle) {
      this.dom.btnDropdownToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.dom.searchResultsDropdown.classList.contains('visible')) {
          this.dom.searchResultsDropdown.classList.remove('visible');
        } else {
          this.renderSearchResults();
          this.dom.searchInput.focus();
        }
      });
    }

    this.dom.btnClearSearch.addEventListener('click', () => {
      this.dom.searchInput.value = '';
      this.dom.btnClearSearch.style.display = 'none';
      this.renderSearchResults();
      this.dom.searchInput.focus();
    });

    // Close search dropdown on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#search-panel')) {
        this.dom.searchResultsDropdown.classList.remove('visible');
      }
      if (!e.target.closest('#btn-layer-toggle') && !e.target.closest('#layer-picker-menu')) {
        this.dom.layerPickerMenu.classList.remove('visible');
      }
    });

    // Category chips (safely guarded if container exists)
    if (this.dom.categoryChipsContainer) {
      this.dom.categoryChipsContainer.addEventListener('click', (e) => {
        const chip = e.target.closest('.cat-chip');
        if (!chip) return;
        this.dom.categoryChipsContainer.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.activeCategory = chip.dataset.cat;
        this.renderSearchResults();
      });
    }

    // Layer switcher
    this.dom.btnLayerToggle.addEventListener('click', () => {
      this.dom.layerPickerMenu.classList.toggle('visible');
    });

    this.dom.layerPickerMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('.layer-opt-btn');
      if (!btn) return;
      this.dom.layerPickerMenu.querySelectorAll('.layer-opt-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      this.mapEngine.switchTileLayer(btn.dataset.layer);
      this.dom.layerPickerMenu.classList.remove('visible');
    });

    // Map Controls
    if (this.dom.btnToggle3d) {
      this.dom.btnToggle3d.addEventListener('click', () => {
        const is3D = this.mapEngine.toggle3D();
        this.dom.btnToggle3d.classList.toggle('active', is3D);
        this.showToast(is3D ? '3D Google Earth Perspective (Tilted)' : '2D Top-Down View', 2000);
      });
    }

    this.dom.btnRecenterUser.addEventListener('click', () => {
      this.mapEngine.recenterOnUser();
    });

    this.dom.btnRecenterCampus.addEventListener('click', () => {
      this.mapEngine.recenterCampus();
    });

    this.dom.btnToggleWalkways.addEventListener('click', () => {
      this.isWalkwaysVisible = !this.isWalkwaysVisible;
      this.dom.btnToggleWalkways.classList.toggle('active', this.isWalkwaysVisible);
      this.mapEngine.toggleWalkways(this.isWalkwaysVisible);
    });

    // Destination card actions
    this.dom.btnCloseCard.addEventListener('click', () => {
      this.clearDestination();
    });

    this.dom.btnToggleSteps.addEventListener('click', () => {
      this.dom.turnDirectionsDrawer.classList.toggle('visible');
    });

    this.dom.btnStartNavigation.addEventListener('click', () => {
      this.startNavigationMode();
    });

    // Active Navigation Stop
    this.dom.btnStopNavigation.addEventListener('click', () => {
      this.stopNavigationMode();
    });

    // Arrival Modal
    this.dom.btnDismissArrival.addEventListener('click', () => {
      this.dom.arrivalModal.classList.remove('visible');
      this.stopNavigationMode();
    });

    // GPS Status pill click -> open diagnostics
    this.dom.btnGpsStatus.addEventListener('click', () => {
      this.openGpsModal();
    });

    this.dom.btnCloseGpsModal.addEventListener('click', () => {
      this.dom.gpsModal.classList.remove('visible');
    });

    this.dom.btnRetryGps.addEventListener('click', async () => {
      this.dom.gpsPermissionWarning.style.display = 'none';
      await this.locationManager.startTracking();
    });

    // Remote test button (Main Gate)
    this.dom.btnTestMainGate.addEventListener('click', () => {
      const gateLoc = this.campusData.locations.find(l => l.id === 'rec_main_gate') || {
        latitude: 13.0124751,
        longitude: 80.0003439
      };
      this.locationManager.setManualLocation(gateLoc.latitude, gateLoc.longitude, 3, 'REC Main Gate (NH 48)');
      this.dom.gpsModal.classList.remove('visible');
      this.showToast('Position set to REC Main Gate (NH 48 Entry) for in-campus testing');
    });

    // Admin Modal
    this.dom.btnAdminModal.addEventListener('click', () => {
      this.dom.adminModal.classList.add('visible');
      if (this.dom.inputCartoApiKey) {
        this.dom.inputCartoApiKey.value = localStorage.getItem('rec_carto_api_key') || '';
      }
      this.renderAdminList();
    });

    if (this.dom.btnSaveApiKey) {
      this.dom.btnSaveApiKey.addEventListener('click', () => {
        const key = (this.dom.inputCartoApiKey.value || '').trim();
        if (key) {
          localStorage.setItem('rec_carto_api_key', key);
          this.showToast('API Key saved! Reloading map layer...');
        } else {
          localStorage.removeItem('rec_carto_api_key');
          this.showToast('API Key cleared. Using free watermark-free layers.');
        }
        setTimeout(() => location.reload(), 800);
      });
    }

    this.dom.btnCloseAdminModal.addEventListener('click', () => {
      this.dom.adminModal.classList.remove('visible');
    });

    this.dom.btnExportData.addEventListener('click', () => {
      this.dataManager.exportJSON();
    });

    this.dom.inputImportData.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        const res = this.dataManager.importJSON(event.target.result);
        if (res.success) {
          this.showToast(`Imported ${res.count} verified locations.`);
        } else {
          alert('Import failed: ' + res.error);
        }
      };
      reader.readAsText(file);
    });

    this.dom.btnResetDefaultData.addEventListener('click', async () => {
      if (confirm('Reset campus locations database to default survey data?')) {
        const resp = await fetch('./rec_campus_data.json');
        const defaultData = await resp.json();
        this.dataManager.resetToDefault(defaultData);
        this.showToast('Reset to default verified database.');
      }
    });

    // College Bus Fleet Modal Listeners
    if (this.dom.btnBusModal) {
      this.dom.btnBusModal.addEventListener('click', () => {
        this.dom.busModal.classList.add('visible');
        this.renderBusModalList();
      });
    }

    if (this.dom.btnCloseBusModal) {
      this.dom.btnCloseBusModal.addEventListener('click', () => {
        this.dom.busModal.classList.remove('visible');
      });
    }

    if (this.dom.busSearchInput) {
      this.dom.busSearchInput.addEventListener('input', () => {
        this.renderBusModalList();
      });
    }

    if (this.dom.btnSaveCurrentGpsBus) {
      this.dom.btnSaveCurrentGpsBus.addEventListener('click', () => {
        this.saveCurrentGpsForBus();
      });
    }
  }

  /**
   * Filter and display search results (including persistent college buses)
   */
  renderSearchResults() {
    const query = this.dom.searchInput.value.trim().toLowerCase();
    const baseLocations = this.campusData ? this.campusData.locations : [];
    const busLocations = this.busManager ? this.busManager.getAllBusesAsLocations() : [];
    const allSearchable = [...baseLocations, ...busLocations];
    const userLoc = this.locationManager ? this.locationManager.getCurrentLocation() : null;

    const filtered = allSearchable.filter(loc => {
      const matchesCat = this.activeCategory === 'All' || loc.category === this.activeCategory;
      const matchesQuery = query === '' ||
        loc.name.toLowerCase().includes(query) ||
        (loc.building_code && loc.building_code.toLowerCase().includes(query)) ||
        (loc.category && loc.category.toLowerCase().includes(query)) ||
        (loc.description && loc.description.toLowerCase().includes(query)) ||
        (loc.busNumber && loc.busNumber.toLowerCase().includes(query)) ||
        (loc.route && loc.route.toLowerCase().includes(query)) ||
        (loc.parking_bay && loc.parking_bay.toLowerCase().includes(query));

      return matchesCat && matchesQuery;
    });

    // Sort by distance if user location is available
    if (userLoc) {
      filtered.sort((a, b) => {
        const aHasCoords = a.latitude !== null && a.latitude !== undefined && !isNaN(Number(a.latitude));
        const bHasCoords = b.latitude !== null && b.latitude !== undefined && !isNaN(Number(b.latitude));
        if (!aHasCoords && !bHasCoords) return 0;
        if (!aHasCoords) return 1;
        if (!bHasCoords) return -1;
        const da = CampusRouter.haversineDistance([userLoc.latitude, userLoc.longitude], [a.latitude, a.longitude]);
        const db = CampusRouter.haversineDistance([userLoc.latitude, userLoc.longitude], [b.latitude, b.longitude]);
        return da - db;
      });
    }

    this.dom.searchResultsDropdown.innerHTML = '';

    if (filtered.length === 0) {
      this.dom.searchResultsDropdown.innerHTML = `
        <div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px;">
          No campus locations or college buses found matching "${query}"
        </div>
      `;
      this.dom.searchResultsDropdown.classList.add('visible');
      this.dom.searchResultsDropdown.style.display = 'flex';
      return;
    }

    for (const loc of filtered) {
      const itemEl = document.createElement('div');
      itemEl.className = 'search-result-item';

      const hasCoords = loc.latitude !== null && loc.latitude !== undefined && loc.longitude !== null && loc.longitude !== undefined && !isNaN(Number(loc.latitude)) && !isNaN(Number(loc.longitude));

      let distText = '';
      if (userLoc && hasCoords) {
        const d = CampusRouter.haversineDistance([userLoc.latitude, userLoc.longitude], [loc.latitude, loc.longitude]);
        distText = d > 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
      }

      const isBus = !!loc.isBus;
      const isLive = Boolean(loc.isLive || loc.status === 'LIVE');
      let metaTag = loc.category;
      let verifiedTag = '✓ Verified';

      if (isBus) {
        if (isLive) {
          metaTag = `🟢 LIVE (${Math.round(loc.speed || 0)} km/h)`;
          verifiedTag = 'Real-Time GPS';
        } else if (hasCoords) {
          metaTag = `🅿️ ${loc.parking_bay || 'PARKWIZ'}`;
          verifiedTag = '📡 Saved GPS';
        } else {
          metaTag = `🅿️ ${loc.parking_bay || 'Assigned Bay'}`;
          verifiedTag = 'GPS Pending';
        }
      }

      itemEl.innerHTML = `
        <div class="item-main-info">
          <div class="item-cat-icon">
            ${this.getCategoryIcon(loc.category)}
          </div>
          <div class="item-title-block">
            <span class="item-name">${loc.name}</span>
            <div class="item-meta">
              <span>${metaTag}</span>
              <span>•</span>
              <span>${loc.building_code || ('BUS-' + loc.busNumber)}</span>
              <span>•</span>
              <span class="item-badge-verified">${verifiedTag}</span>
            </div>
          </div>
        </div>
        ${distText ? `<span class="item-distance-pill">${distText}</span>` : ''}
      `;

      itemEl.addEventListener('click', () => {
        this.selectDestination(loc);
        this.dom.searchResultsDropdown.classList.remove('visible');
        this.dom.searchResultsDropdown.style.display = 'none';
        this.dom.searchInput.value = loc.name;
        this.dom.btnClearSearch.style.display = 'flex';
      });

      this.dom.searchResultsDropdown.appendChild(itemEl);
    }

    this.dom.searchResultsDropdown.classList.add('visible');
    this.dom.searchResultsDropdown.style.display = 'flex';
  }

  getCategoryIcon(cat) {
    switch (cat) {
      case 'Buses':
        return `<span style="font-size: 15px;">🚌</span>`;
      case 'Academic':
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`;
      case 'Student Facilities':
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>`;
      case 'Food & Canteen':
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>`;
      case 'Hostels':
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`;
      case 'Sports':
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M4.93 4.93l4.24 4.24"></path><path d="M14.83 9.17l4.24-4.24"></path><path d="M14.83 14.83l4.24 4.24"></path><path d="M9.17 14.83L4.93 19.07"></path></svg>`;
      case 'Transport':
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>`;
      default:
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle></svg>`;
    }
  }

  /**
   * CRITICAL ACTION: Select Destination & Immediately Calculate Real Walking Route
   */
  async selectDestination(loc) {
    this.selectedDestination = loc;

    const hasCoords = loc.latitude !== null && loc.latitude !== undefined && loc.longitude !== null && loc.longitude !== undefined && !isNaN(Number(loc.latitude)) && !isNaN(Number(loc.longitude));

    // Place destination marker on map if valid coordinates exist
    if (hasCoords) {
      this.mapEngine.setDestinationMarker(loc);
    }

    // Update Card UI
    if (loc.isBus) {
      const isLive = Boolean(loc.isLive || loc.status === 'LIVE');
      this.dom.cardDestCategory.textContent = isLive ? 'COLLEGE BUS • LIVE EN ROUTE' : (hasCoords ? 'COLLEGE BUS • PARKED' : 'COLLEGE BUS • FLEET INFO');
      this.dom.cardDestCode.textContent = `BUS-${loc.busNumber}`;
      this.dom.cardDestName.textContent = loc.name;
      const driverStr = loc.driver_name ? `${loc.driver_name} (${loc.driver_phone || 'Contact via REC Transport'})` : 'REC Transport Driver';
      this.dom.cardDestDesc.textContent = isLive
        ? `🟢 LIVE BROADCAST: Driving at ${Math.round(loc.speed || 0)} km/h • Driver: ${driverStr}`
        : (hasCoords
            ? `🅿️ Parked at ${loc.parking_bay || 'Campus Parking'} • Driver: ${driverStr} • 📡 ${loc.last_gps_timestamp || 'Recently Recorded'}`
            : `🅿️ Bay: ${loc.parking_bay || 'Assigned Bay'} • Driver: ${driverStr} • (Driver GPS not broadcasted yet)`);
      this.dom.cardDestCoords.textContent = hasCoords 
        ? `📍 ${Number(loc.latitude).toFixed(6)}° N, ${Number(loc.longitude).toFixed(6)}° E` 
        : `📍 GPS Pending (Awaiting Driver Broadcast)`;
      this.dom.btnStartNavigation.textContent = isLive 
        ? `Walk to Moving Bus #${loc.busNumber}` 
        : (hasCoords ? `Walk to Bus #${loc.busNumber}` : `Awaiting Driver GPS`);
      this.dom.btnStartNavigation.disabled = !hasCoords;
    } else {
      this.dom.cardDestCategory.textContent = loc.category;
      this.dom.cardDestCode.textContent = loc.building_code || '';
      this.dom.cardDestName.textContent = loc.name;
      this.dom.cardDestDesc.textContent = loc.description || '';
      this.dom.cardDestCoords.textContent = hasCoords 
        ? `📍 ${Number(loc.latitude).toFixed(6)}° N, ${Number(loc.longitude).toFixed(6)}° E` 
        : `📍 Coordinates pending`;
      this.dom.btnStartNavigation.textContent = 'Start Walking Navigation';
      this.dom.btnStartNavigation.disabled = false;
    }

    this.dom.destinationCard.classList.add('visible');

    if (!hasCoords) {
      this.showToast(`Bus #${loc.busNumber} has not reported its parked GPS coordinates yet.`);
      return;
    }

    // Get current device GPS position
    const userLoc = this.locationManager.getCurrentLocation();
    if (!userLoc) {
      // Automatic verified in-campus entry fallback (Sole Main Entrance from NH 48)
      let originLoc = this.campusData.locations.find(l => l.id === 'rec_main_gate') || {
        latitude: 13.0124751,
        longitude: 80.0003439
      };
      if (loc.id === 'rec_main_gate') {
        originLoc = this.campusData.locations.find(l => l.id === 'rec_admin_block') || originLoc;
      }

      const fallbackOrigin = {
        latitude: originLoc.latitude,
        longitude: originLoc.longitude,
        isFallbackOrigin: true
      };

      await this.calculateAndDisplayRoute(fallbackOrigin, loc);
      return;
    }

    // Immediately calculate real walking route
    await this.calculateAndDisplayRoute(userLoc, loc);
  }

  /**
   * Calculates and renders the LIGHT-BLUE NAVIGATION PATH
   */
  async calculateAndDisplayRoute(userLoc, destination) {
    try {
      this.dom.metricDistance.textContent = 'Routing...';
      this.dom.metricDuration.textContent = '...';

      const isBus = Boolean(destination.isBus || destination.category === 'Buses' || destination.category === 'Transport');
      const routeResult = await this.routerEngine.calculateRoute(userLoc, destination, {
        profile: isBus ? 'driving' : 'auto',
        busAccessible: isBus
      });

      if (!routeResult || !routeResult.coordinates || routeResult.coordinates.length < 2) {
        throw new Error('Unable to calculate walking route.');
      }

      this.currentActiveRoute = routeResult;
      this.currentActiveRoute.isFallbackOrigin = !!userLoc.isFallbackOrigin;

      // Update route metrics
      const dist = routeResult.distanceMeters;
      this.dom.metricDistance.textContent = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${dist} m`;
      this.dom.metricDuration.textContent = `${routeResult.durationMinutes} min`;
      if (userLoc.isFallbackOrigin) {
        this.dom.metricProvider.textContent = 'From REC Main Gate (GPS acquiring)';
      } else {
        this.dom.metricProvider.textContent = routeResult.provider || (isBus ? 'OSRM Direct Road Engine' : 'REC Verified Graph');
      }

      // DRAW THE SIGNATURE LIGHT-BLUE NAVIGATION PATH
      this.mapEngine.drawNavigationRoute(routeResult.coordinates);

      // Render step directions
      this.renderTurnDirections(routeResult.steps);

      // If active navigation is running, update route with tracker
      if (this.locationManager.isNavigating) {
        this.locationManager.updateActiveRoute(routeResult.coordinates);
        this.updateActiveHud(userLoc, routeResult);
      }
    } catch (err) {
      console.error('Route error:', err);
      this.dom.metricDistance.textContent = 'Failed';
      this.dom.metricDuration.textContent = '--';
      this.showToast('Unable to calculate a walking route right now: ' + err.message);
    }
  }

  renderTurnDirections(steps) {
    this.dom.turnDirectionsDrawer.innerHTML = '';
    if (!steps || steps.length === 0) {
      this.dom.turnDirectionsDrawer.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Direct pedestrian path</div>';
      return;
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const div = document.createElement('div');
      div.className = 'turn-step-item';
      div.innerHTML = `
        <div class="turn-step-icon">
          ${this.getManeuverIcon(step.type)}
        </div>
        <div>
          <div>${step.instruction}</div>
          ${step.distanceMeters ? `<span class="turn-step-dist">${step.distanceMeters} m</span>` : ''}
        </div>
      `;
      this.dom.turnDirectionsDrawer.appendChild(div);
    }
  }

  getManeuverIcon(type) {
    if (type === 'right' || type === 'slight-right' || type === 'sharp-right') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
    }
    if (type === 'left' || type === 'slight-left' || type === 'sharp-left') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>`;
    }
    if (type === 'arrive') {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
    }
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`;
  }

  /**
   * Starts active live navigation mode
   */
  startNavigationMode() {
    if (!this.selectedDestination || !this.currentActiveRoute) return;

    this.locationManager.startNavigation(this.selectedDestination, this.currentActiveRoute.coordinates);

    // Hide preview card, show active navigation HUD
    this.dom.destinationCard.classList.remove('visible');
    this.dom.activeNavHud.classList.add('visible');

    // Lock camera to follow user
    this.mapEngine.isAutoPanEnabled = true;
    this.mapEngine.recenterOnUser();

    const userLoc = this.locationManager.getCurrentLocation();
    this.updateActiveHud(userLoc, this.currentActiveRoute);
  }

  stopNavigationMode() {
    this.locationManager.stopNavigation();
    this.dom.activeNavHud.classList.remove('visible');
    this.dom.offRouteBanner.classList.remove('visible');
    this.mapEngine.isAutoPanEnabled = false;

    if (this.selectedDestination) {
      this.dom.destinationCard.classList.add('visible');
    }
  }

  updateActiveHud(userLoc, route) {
    if (!this.selectedDestination || !route) return;

    if (this.selectedDestination.isBus) {
      const isLive = Boolean(this.selectedDestination.isLive);
      const statusText = isLive 
        ? `LIVE • ${Math.round(this.selectedDestination.speed || 0)} km/h` 
        : (this.selectedDestination.parking_bay || 'PARKWIZ');
      this.dom.hudDestinationName.textContent = `Target: 🚌 Bus #${this.selectedDestination.busNumber} (${statusText})`;
    } else {
      this.dom.hudDestinationName.textContent = `Target: ${this.selectedDestination.name}`;
    }

    const dist = route.distanceMeters;
    this.dom.hudRemainingDist.textContent = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${dist} m`;
    this.dom.hudRemainingTime.textContent = `${route.durationMinutes} min`;

    if (route.steps && route.steps.length > 0) {
      const nextStep = route.steps[0];
      this.dom.hudInstructionText.textContent = nextStep.instruction;
      this.dom.hudManeuverIcon.innerHTML = this.getManeuverIcon(nextStep.type);
    }
  }

  clearDestination() {
    this.selectedDestination = null;
    this.currentActiveRoute = null;
    this.dom.destinationCard.classList.remove('visible');
    this.dom.activeNavHud.classList.remove('visible');
    this.mapEngine.clearRoute();
  }

  /**
   * Handles live GPS updates from device
   */
  handleLocationUpdate(locationData) {
    // 1. Update map user marker and accuracy circle
    this.mapEngine.updateUserLocation(locationData);

    // 2. Update Header Status Pill
    this.dom.gpsBeaconIndicator.className = 'gps-beacon ' + (locationData.isLowAccuracy ? 'low-accuracy' : 'active');
    const campusDistText = locationData.isInsideCampus
      ? 'In REC Campus'
      : `${locationData.distToCampusKm} km to REC`;
    this.dom.gpsStatusText.textContent = `±${locationData.accuracy}m • ${campusDistText}`;

    // 3. Update Diagnostics modal
    this.dom.diagStatus.textContent = locationData.isManualTestMode ? 'Test Mode (Main Gate)' : 'Hardware GPS Active';
    this.dom.diagCoords.textContent = `${locationData.latitude.toFixed(6)}° N, ${locationData.longitude.toFixed(6)}° E`;
    this.dom.diagAccuracy.textContent = `±${locationData.accuracy} meters (${locationData.isLowAccuracy ? 'Low' : 'Good'})`;
    this.dom.diagRecDist.textContent = `${locationData.distToCampusMeters} m (${locationData.isInsideCampus ? 'Inside Campus' : 'Outside Campus'})`;
    this.dom.diagSpeed.textContent = locationData.speed ? `${locationData.speed} km/h` : 'Stationary / Walking';

    // 4. If destination is selected, calculate or upgrade route to real GPS coordinates
    if (this.selectedDestination && (!this.currentActiveRoute || this.currentActiveRoute.isFallbackOrigin)) {
      this.calculateAndDisplayRoute(locationData, this.selectedDestination);
    }
  }

  handleAccuracyWarning(warn) {
    console.warn(warn.message);
    // GPS warning applies to outdoor real navigation, but must NEVER block or disrupt offline transport map
    if (this.currentView === 'campus') {
      this.showToast(warn.message, 4000);
    }
  }

  handlePermissionDenied(msg) {
    this.dom.gpsBeaconIndicator.className = 'gps-beacon error';
    this.dom.gpsStatusText.textContent = 'GPS Denied';
    this.dom.gpsPermissionWarning.style.display = 'block';
    if (this.currentView === 'campus') {
      this.openGpsModal();
    }
  }

  handlePositionUnavailable(msg) {
    this.dom.gpsBeaconIndicator.className = 'gps-beacon error';
    this.dom.gpsStatusText.textContent = 'GPS Unavailable';
    if (this.currentView === 'campus') {
      this.showToast(msg);
    }
  }

  /**
   * OFF-ROUTE DETECTION & AUTOMATIC ROUTE RECALCULATION
   */
  async handleOffRoute(data) {
    this.dom.offRouteBanner.classList.add('visible');

    // Trigger route recalculation from user's new real GPS position
    if (this.selectedDestination) {
      await this.calculateAndDisplayRoute(data.currentLocation, this.selectedDestination);
    }

    setTimeout(() => {
      this.dom.offRouteBanner.classList.remove('visible');
    }, 4500);
  }

  /**
   * REAL ARRIVAL DETECTION
   */
  handleArrival(data) {
    this.dom.arrivalDestName.textContent = data.destination.name;
    this.dom.arrivalModal.classList.add('visible');
  }

  openGpsModal() {
    this.dom.gpsModal.classList.add('visible');
  }

  renderAdminList() {
    const listEl = this.dom.adminLocationsList;
    if (!listEl) return;
    const locations = this.dataManager.getAllLocations();
    this.dom.adminLocCount.textContent = locations.length;
    listEl.innerHTML = '';

    for (const loc of locations) {
      const row = document.createElement('div');
      row.className = 'admin-loc-row';
      row.innerHTML = `
        <div style="flex:1;">
          <strong>${loc.name}</strong> (${loc.building_code})
          <div style="color:var(--text-muted);font-size:11px;">
            ${loc.category} • [${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}]
          </div>
        </div>
        <button class="btn-secondary-outline" style="height:28px;padding:0 8px;font-size:11px;" data-id="${loc.id}">
          Navigate
        </button>
      `;

      row.querySelector('button').addEventListener('click', () => {
        this.selectDestination(loc);
        this.dom.adminModal.classList.remove('visible');
      });

      listEl.appendChild(row);
    }
  }

  /**
   * Populates the bus dropdown in the Save Parked Location panel
   */
  populateBusSelectOptions() {
    if (!this.dom.busSelectToSave || !this.busManager) return;
    this.dom.busSelectToSave.innerHTML = '';

    for (const bus of this.busManager.buses) {
      const opt = document.createElement('option');
      opt.value = bus.id;
      opt.textContent = `Bus #${bus.busNumber} — ${bus.route.split('(')[0].trim()}`;
      this.dom.busSelectToSave.appendChild(opt);
    }

    // Pre-populate initial bay name
    if (this.busManager.buses.length > 0 && this.dom.busBayNameInput) {
      this.dom.busBayNameInput.value = this.busManager.buses[0].parkingBay || '';
    }

    this.dom.busSelectToSave.addEventListener('change', () => {
      const selectedId = this.dom.busSelectToSave.value;
      const bus = this.busManager.getBusById(selectedId);
      if (bus && this.dom.busBayNameInput) {
        this.dom.busBayNameInput.value = bus.parkingBay || '';
      }
    });
  }

  /**
   * Renders the interactive list of all college buses inside the Bus Modal
   */
  renderBusModalList() {
    if (!this.dom.busFleetListContainer || !this.busManager) return;

    const query = (this.dom.busSearchInput ? this.dom.busSearchInput.value : '').trim().toLowerCase();
    const buses = this.busManager.buses.filter(bus => {
      if (!query) return true;
      return (
        bus.busNumber.toLowerCase().includes(query) ||
        bus.route.toLowerCase().includes(query) ||
        bus.plateNumber.toLowerCase().includes(query) ||
        bus.parkingBay.toLowerCase().includes(query) ||
        bus.driverName.toLowerCase().includes(query)
      );
    });

    this.dom.busFleetListContainer.innerHTML = '';

    if (buses.length === 0) {
      this.dom.busFleetListContainer.innerHTML = `
        <div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;">
          No college buses found matching "${query}"
        </div>
      `;
      return;
    }

    for (const bus of buses) {
      const card = document.createElement('div');
      card.className = 'bus-card-row';

      card.innerHTML = `
        <div class="bus-card-header">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="bus-num-badge">🚌 #${bus.busNumber}</span>
            <span class="bus-route-title">${bus.route.split('(')[0].trim()}</span>
          </div>
          <span class="bus-bay-pill">${bus.parkingBay}</span>
        </div>

        <div style="font-size: 11.5px; color: var(--text-muted); line-height: 1.4;">
          ${bus.route}
        </div>

        <div class="bus-meta-details">
          <span>Plate: <strong style="color: #fff;">${bus.plateNumber}</strong></span>
          <span>•</span>
          <span>Driver: <strong style="color: #fff;">${bus.driverName}</strong> (${bus.driverPhone})</span>
        </div>

        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; margin-top: 2px;">
          <span class="bus-gps-status-pill">
            📡 ${bus.lastGpsTimestamp}
          </span>
          <div class="bus-action-buttons">
            <button class="btn-secondary-outline btn-bus-view-map" style="height: 30px; padding: 0 10px; font-size: 11px;">
              📍 View Bay
            </button>
            <button class="btn-primary-nav btn-bus-walk-to" style="height: 30px; padding: 0 12px; font-size: 11px;">
              🚶 Walk to Bus #${bus.busNumber}
            </button>
          </div>
        </div>
      `;

      // Button listeners
      const locFormat = this.busManager.formatBusAsLocation(bus);

      card.querySelector('.btn-bus-walk-to').addEventListener('click', () => {
        this.dom.busModal.classList.remove('visible');
        this.selectDestination(locFormat);
      });

      card.querySelector('.btn-bus-view-map').addEventListener('click', () => {
        this.dom.busModal.classList.remove('visible');
        this.mapEngine.map.flyTo({
          center: [bus.longitude, bus.latitude],
          zoom: 19.5,
          pitch: 50,
          duration: 1200
        });
        this.selectDestination(locFormat);
      });

      this.dom.busFleetListContainer.appendChild(card);
    }
  }

  /**
   * CRITICAL ACTION: Stores current GPS position permanently for the selected bus
   * Keeps location stored even when bus GPS and engine are completely off!
   */
  async saveCurrentGpsForBus() {
    const busId = this.dom.busSelectToSave.value;
    const customBay = this.dom.busBayNameInput.value.trim();

    if (!busId) {
      this.showToast('Please select a bus to save.');
      return;
    }

    const currentLoc = this.locationManager.getCurrentLocation();
    let lat = null, lon = null;

    if (currentLoc && !isNaN(currentLoc.latitude) && !isNaN(currentLoc.longitude)) {
      lat = currentLoc.latitude;
      lon = currentLoc.longitude;
    } else {
      const bus = this.busManager.getBusById(busId);
      if (bus && bus.lastLatitude !== null && bus.lastLongitude !== null) {
        lat = bus.lastLatitude;
        lon = bus.lastLongitude;
        this.showToast('Preserving current verified coordinates for this bus.', 3000);
      } else {
        this.showToast('Waiting for genuine hardware GPS lock. Please allow location access.', 4500);
        return;
      }
    }

    try {
      await this.busManager.updateBusParkedLocation(busId, lat, lon, customBay);
      const updated = this.busManager.getBusById(busId);
      this.showToast(`✅ Bus #${updated ? updated.busNumber : busId} parked spot saved permanently in REC system.`, 4000);
      this.renderBusModalList();
      this.renderSearchResults();
      
      // Update map markers
      this.mapEngine.renderParkedBusMarkers(this.busManager.buses, (b) => {
        this.selectDestination(this.busManager.formatBusAsLocation(b));
      });

      if (this.transportMapEngine && updated) {
        this.transportMapEngine.updateSingleBus(updated);
      }
    } catch (err) {
      this.showToast('Failed to save parked location: ' + err.message);
    }
  }

  /**
   * Real-Time Telemetry & Status Update Handler
   * When updatedBus is provided, updates only that single bus marker (Requirement 20)
   */
  onBusLocationUpdated(updatedBus) {
    if (updatedBus) {
      // 1. Zero-latency single marker update on student transport map
      if (this.transportMapEngine) {
        this.transportMapEngine.updateSingleBus(updatedBus);
      }

      // 2. Update real-time counts
      this.updateTransportCounts();

      // 3. Update campus navigation parked markers
      this.mapEngine.renderParkedBusMarkers(this.busManager.buses, (b) => {
        this.selectDestination(this.busManager.formatBusAsLocation(b));
      });

      // 4. Update preview card if this bus is open
      if (this.dom.tcard && this.dom.tcard.dataset.activeBusId === updatedBus.busId) {
        this.showBusDetailCard(updatedBus);
      }

      // 5. Update active destination if navigating to this bus
      if (this.selectedDestination && this.selectedDestination.busId === updatedBus.busId) {
        const formattedLoc = this.busManager.formatBusAsLocation(updatedBus);
        this.selectedDestination = formattedLoc;
        this.mapEngine.setDestinationMarker(formattedLoc);

        const userLoc = this.locationManager.getCurrentLocation();
        if (userLoc) {
          this.calculateAndDisplayRoute(userLoc, formattedLoc);
        }
      }
    } else {
      // Full fleet refresh (e.g. initial load or batch sync)
      this.renderSearchResults();
      this.renderBusModalList();
      this.updateTransportMapBuses();
      if (this.adminMapEngine) {
        this.updateAdminSelectedBus();
      }
      this.mapEngine.renderParkedBusMarkers(this.busManager.buses, (b) => {
        this.selectDestination(this.busManager.formatBusAsLocation(b));
      });
    }
  }

  onConnectionStateChange(state) {
    if (!this.dom.connStatusLabel || !this.dom.connStatusPill) return;

    if (state === 'LIVE') {
      this.dom.connStatusPill.className = 'conn-status-pill online';
      this.dom.connStatusLabel.textContent = '🟢 LIVE GPS';
      this.dom.connStatusPill.title = 'Live GPS Stream Active';
      if (this.dom.tmapConnectionBadge && this.dom.tmapConnectionText) {
        this.dom.tmapConnectionBadge.className = 't-connection-badge online';
        this.dom.tmapConnectionText.textContent = '🟢 LIVE STREAM';
      }
    } else if (state === 'CONNECTED') {
      this.dom.connStatusPill.className = 'conn-status-pill online';
      this.dom.connStatusLabel.textContent = '🟢 ONLINE';
      this.dom.connStatusPill.title = 'Backend Online • SSE Stream Ready';
      if (this.dom.tmapConnectionBadge && this.dom.tmapConnectionText) {
        this.dom.tmapConnectionBadge.className = 't-connection-badge online';
        this.dom.tmapConnectionText.textContent = '🟢 CONNECTED';
      }
    } else if (state === 'RECONNECTING') {
      this.dom.connStatusPill.className = 'conn-status-pill syncing';
      this.dom.connStatusLabel.textContent = '🟡 RECONNECTING';
      this.dom.connStatusPill.title = 'Reconnecting live stream...';
      if (this.dom.tmapConnectionBadge && this.dom.tmapConnectionText) {
        this.dom.tmapConnectionBadge.className = 't-connection-badge syncing';
        this.dom.tmapConnectionText.textContent = '🟡 RECONNECTING';
      }
    } else {
      this.dom.connStatusPill.className = 'conn-status-pill offline';
      this.dom.connStatusLabel.textContent = '🔴 OFFLINE';
      this.dom.connStatusPill.title = 'Operating from verified IndexedDB offline cache';
      if (this.dom.tmapConnectionBadge && this.dom.tmapConnectionText) {
        this.dom.tmapConnectionBadge.className = 't-connection-badge offline';
        this.dom.tmapConnectionText.textContent = '🔴 OFFLINE (CACHED)';
      }
    }
  }

  updateTransportCounts() {
    const allBuses = this.busManager.buses || [];
    const activeBuses = allBuses.filter(b => b.isActive !== false);
    const liveCount = activeBuses.filter(b => b.status === 'LIVE').length;
    const lastKnownCount = activeBuses.filter(b => b.status === 'LAST_KNOWN').length;
    const staticCount = activeBuses.filter(b => !b.status || b.status === 'STATIC').length;

    if (this.dom.tCountAll) this.dom.tCountAll.textContent = activeBuses.length;
    if (this.dom.tCountActive) this.dom.tCountActive.textContent = activeBuses.length;
    if (this.dom.tCountLive) this.dom.tCountLive.textContent = liveCount;
    if (this.dom.tCountLastKnown) this.dom.tCountLastKnown.textContent = lastKnownCount;
    if (this.dom.tCountStatic) this.dom.tCountStatic.textContent = staticCount;
  }

  // =========================================================================
  // DEDICATED STUDENT TRANSPORT BUS MAP ENGINE & CONTROLS
  // =========================================================================

  switchView(viewName) {
    this.currentView = viewName;

    if (viewName === 'transport') {
      this.dom.btnViewCampus.classList.remove('active');
      this.dom.btnViewCampus.setAttribute('aria-selected', 'false');
      this.dom.btnViewTransport.classList.add('active');
      this.dom.btnViewTransport.setAttribute('aria-selected', 'true');

      // Hide campus navigation elements
      this.dom.mapElement.style.display = 'none';
      if (this.dom.searchPanel) this.dom.searchPanel.style.display = 'none';
      if (this.dom.bottomControls) this.dom.bottomControls.style.display = 'none';
      if (this.dom.layerSwitcherWrapper) this.dom.layerSwitcherWrapper.style.display = 'none';
      if (this.dom.destinationCard) this.dom.destinationCard.style.display = 'none';
      if (this.dom.activeNavHud) this.dom.activeNavHud.style.display = 'none';

      // Show transport view
      this.dom.transportMapView.style.display = 'flex';

      if (this.transportMapEngine) {
        setTimeout(() => {
          this.transportMapEngine.fitToScreen();
          this.updateTransportMapBuses();
        }, 50);
      }
    } else {
      this.dom.btnViewTransport.classList.remove('active');
      this.dom.btnViewTransport.setAttribute('aria-selected', 'false');
      this.dom.btnViewCampus.classList.add('active');
      this.dom.btnViewCampus.setAttribute('aria-selected', 'true');

      // Show campus navigation elements
      this.dom.mapElement.style.display = 'block';
      if (this.dom.searchPanel) this.dom.searchPanel.style.display = 'block';
      if (this.dom.bottomControls) this.dom.bottomControls.style.display = 'flex';
      if (this.dom.layerSwitcherWrapper) this.dom.layerSwitcherWrapper.style.display = 'block';

      // Hide transport view & bus detail card
      this.dom.transportMapView.style.display = 'none';
      if (this.dom.tcard) this.dom.tcard.style.display = 'none';

      // Resize maplibre map
      if (this.mapEngine && this.mapEngine.map) {
        setTimeout(() => this.mapEngine.map.resize(), 50);
      }
    }
  }

  initTransportMap() {
    if (!this.dom.tmapCanvasContainer) return;

    this.transportMapEngine = new TransportMapEngine(this.dom.tmapCanvasContainer, {
      onBusSelected: (bus) => this.showBusDetailCard(bus)
    });

    this.setupTransportEventListeners();
    this.populateRouteFilterDropdown();
    this.updateTransportMapBuses();
  }

  setupTransportEventListeners() {
    // Search input
    if (this.dom.tmapSearchInput) {
      this.dom.tmapSearchInput.addEventListener('input', () => {
        const q = this.dom.tmapSearchInput.value.trim();
        if (this.dom.tmapBtnClearSearch) {
          this.dom.tmapBtnClearSearch.style.display = q ? 'block' : 'none';
        }
        this.updateTransportMapBuses();

        // If user typed exact match (e.g. "10C"), zoom straight to it
        if (q) {
          const found = this.busManager.buses.find(b => 
            b.busNumber.toLowerCase() === q.toLowerCase()
          );
          if (found && this.transportMapEngine) {
            this.transportMapEngine.zoomToBus(found.busId);
            this.showBusDetailCard(found);
          }
        }
      });
    }

    if (this.dom.tmapBtnClearSearch) {
      this.dom.tmapBtnClearSearch.addEventListener('click', () => {
        this.dom.tmapSearchInput.value = '';
        this.dom.tmapBtnClearSearch.style.display = 'none';
        this.updateTransportMapBuses();
      });
    }

    // Filter chips
    const filterBtns = [
      { btn: this.dom.tmapBtnAllBuses, filter: 'ALL' },
      { btn: this.dom.tmapFilterActive, filter: 'ACTIVE' },
      { btn: this.dom.tmapFilterLive, filter: 'LIVE' },
      { btn: this.dom.tmapFilterLastKnown, filter: 'LAST_KNOWN' },
      { btn: this.dom.tmapFilterStatic, filter: 'STATIC' }
    ];

    filterBtns.forEach(({ btn, filter }) => {
      if (!btn) return;
      btn.addEventListener('click', () => {
        filterBtns.forEach(f => f.btn && f.btn.classList.remove('active'));
        btn.classList.add('active');
        this.transportFilter = filter;
        this.updateTransportMapBuses();
      });
    });

    // Route select dropdown
    if (this.dom.tmapRouteFilter) {
      this.dom.tmapRouteFilter.addEventListener('change', () => {
        this.selectedRouteFilter = this.dom.tmapRouteFilter.value;
        this.updateTransportMapBuses();
      });
    }

    // Bus Detail Card Actions
    if (this.dom.tcardBtnClose) {
      this.dom.tcardBtnClose.addEventListener('click', () => {
        this.dom.tcard.style.display = 'none';
        if (this.transportMapEngine) {
          this.transportMapEngine.selectBus(null, false);
        }
      });
    }

    if (this.dom.tcardBtnNavigateToBay) {
      this.dom.tcardBtnNavigateToBay.addEventListener('click', () => {
        const busId = this.dom.tcard.dataset.activeBusId;
        const bus = this.busManager.getBusById(busId);
        if (!bus) return;

        const locFormat = this.busManager.formatBusAsLocation(bus);
        this.switchView('campus');
        this.selectDestination(locFormat);
        this.showToast(`Navigating to Bus #${bus.busNumber} (${bus.parkingBay || 'Designated Campus Bay'})`, 3000);
      });
    }
  }

  updateTransportMapBuses() {
    if (!this.transportMapEngine || !this.busManager) return;

    const allBuses = this.busManager.buses || [];
    const searchQuery = (this.dom.tmapSearchInput?.value || '').trim().toLowerCase();

    // Counts (active buses only for student screen)
    const activeBuses = allBuses.filter(b => b.isActive !== false);
    const liveCount = activeBuses.filter(b => b.status === 'LIVE').length;
    const lastKnownCount = activeBuses.filter(b => b.status === 'LAST_KNOWN').length;
    const staticCount = activeBuses.filter(b => !b.status || b.status === 'STATIC').length;

    if (this.dom.tCountAll) this.dom.tCountAll.textContent = activeBuses.length;
    if (this.dom.tCountActive) this.dom.tCountActive.textContent = activeBuses.length;
    if (this.dom.tCountLive) this.dom.tCountLive.textContent = liveCount;
    if (this.dom.tCountLastKnown) this.dom.tCountLastKnown.textContent = lastKnownCount;
    if (this.dom.tCountStatic) this.dom.tCountStatic.textContent = staticCount;

    // Filter records
    let filtered = activeBuses;

    // Status Filter
    if (this.transportFilter === 'LIVE') {
      filtered = filtered.filter(b => b.status === 'LIVE');
    } else if (this.transportFilter === 'LAST_KNOWN') {
      filtered = filtered.filter(b => b.status === 'LAST_KNOWN');
    } else if (this.transportFilter === 'STATIC') {
      filtered = filtered.filter(b => !b.status || b.status === 'STATIC');
    }

    // Route filter
    if (this.selectedRouteFilter) {
      filtered = filtered.filter(b => 
        b.routeId === this.selectedRouteFilter ||
        (b.routeName && b.routeName.toLowerCase().includes(this.selectedRouteFilter.toLowerCase())) ||
        (b.route && b.route.toLowerCase().includes(this.selectedRouteFilter.toLowerCase()))
      );
    }

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter(b => 
        b.busNumber.toLowerCase().includes(searchQuery) ||
        (b.routeName && b.routeName.toLowerCase().includes(searchQuery)) ||
        (b.route && b.route.toLowerCase().includes(searchQuery)) ||
        (b.parkingBay && b.parkingBay.toLowerCase().includes(searchQuery)) ||
        (b.driver && b.driver.toLowerCase().includes(searchQuery)) ||
        (b.registrationNumber && b.registrationNumber.toLowerCase().includes(searchQuery))
      );
    }

    this.transportMapEngine.setBuses(filtered);
  }

  showBusDetailCard(bus) {
    if (!bus || !this.dom.tcard) return;

    this.dom.tcard.dataset.activeBusId = bus.busId;
    this.dom.tcardBusNum.textContent = `🚌 Bus #${bus.busNumber}`;
    
    const status = bus.status || 'STATIC';
    this.dom.tcardStatusBadge.className = `tcard-status-badge status-${status.toLowerCase().replace('_', '-')}`;
    this.dom.tcardStatusBadge.textContent = status === 'LIVE' ? '🟢 LIVE' : (status === 'LAST_KNOWN' ? '🟡 LAST KNOWN' : '🔵 STATIC');

    let posTypeText = 'Verified Static Bay Position';
    if (status === 'LIVE') {
      const spd = bus.speed !== undefined && bus.speed !== null ? `${Math.round(bus.speed)} km/h` : 'Moving';
      const acc = bus.accuracy ? ` • ±${Math.round(bus.accuracy)}m` : '';
      posTypeText = `Real Hardware Live GPS (${spd}${acc})`;
    } else if (status === 'LAST_KNOWN') {
      posTypeText = 'Last Known GPS Coordinates';
    }
    this.dom.tcardPosType.textContent = posTypeText;

    this.dom.tcardRouteName.textContent = bus.routeName || bus.route || `REC Route #${bus.busNumber}`;
    this.dom.tcardBayLocation.textContent = `🅿️ ${bus.parkingBay || 'Designated Campus Bay'}`;
    this.dom.tcardPlate.textContent = bus.registrationNumber || bus.plateNumber || 'Not configured';
    
    const driver = bus.driver || bus.driverName || 'Not configured';
    const phone = bus.driverContact || bus.driverPhone ? ` (${bus.driverContact || bus.driverPhone})` : '';
    this.dom.tcardDriver.textContent = `${driver}${phone}`;
    
    const dep = bus.departureTime ? `Dep: ${bus.departureTime}` : 'Dep: Not configured';
    const arr = bus.arrivalTime ? `Arr: ${bus.arrivalTime}` : 'Arr: Not configured';
    this.dom.tcardSchedule.textContent = `${dep} • ${arr}`;
    
    this.dom.tcardLastUpdated.textContent = bus.lastGpsUpdate || 'Verified Static Schedule';
    
    const stopsList = Array.isArray(bus.boardingPoints) ? bus.boardingPoints.join(' → ') : (bus.boardingPoints || 'Not configured');
    this.dom.tcardBoardingPoints.textContent = stopsList;

    this.updateSmsQuickStatusCard(bus);
    this.dom.tcard.style.display = 'flex';
  }

  async populateRouteFilterDropdown() {
    if (!this.dom.tmapRouteFilter) return;

    try {
      let routes = await offlineStorage.getAllRoutes();
      if (!routes || routes.length === 0) {
        const res = await fetch('/api/routes');
        if (res.ok) {
          routes = await res.json();
        }
      }

      if (routes && routes.length > 0) {
        this.dom.tmapRouteFilter.innerHTML = '<option value="">All Verified Routes</option>';
        routes.forEach(r => {
          const opt = document.createElement('option');
          opt.value = r.routeNumber;
          opt.textContent = `Route ${r.routeNumber} — ${r.routeName}`;
          this.dom.tmapRouteFilter.appendChild(opt);
        });
      }
    } catch (e) {
      console.warn('Failed to load routes for filter:', e);
    }
  }

  // =========================================================================
  // ADMIN MANAGEMENT TABS & BUS POSITIONING TOOL
  // =========================================================================

  initAdminTransportTabs() {
    this.setupAdminTabEventListeners();
  }

  setupAdminTabEventListeners() {
    const tabs = [
      { btn: this.dom.tabBtnLocations, pane: this.dom.adminPaneLocations },
      { btn: this.dom.tabBtnBuses, pane: this.dom.adminPaneBuses },
      { btn: this.dom.tabBtnBusPosition, pane: this.dom.adminPaneBusPosition },
      { btn: this.dom.tabBtnCalibration, pane: this.dom.adminPaneCalibration }
    ];

    tabs.forEach(tab => {
      if (!tab.btn) return;
      tab.btn.addEventListener('click', () => {
        tabs.forEach(t => {
          if (t.btn) {
            t.btn.classList.remove('active');
            t.btn.setAttribute('aria-selected', 'false');
          }
          if (t.pane) t.pane.style.display = 'none';
        });

        tab.btn.classList.add('active');
        tab.btn.setAttribute('aria-selected', 'true');
        if (tab.pane) tab.pane.style.display = 'block';

        if (tab.btn.id === 'tab-btn-buses') {
          this.renderAdminBusFleetList();
        } else if (tab.btn.id === 'tab-btn-bus-position') {
          this.initAdminMapEngine();
        } else if (tab.btn.id === 'tab-btn-calibration') {
          this.loadAdminCalibration();
        }
      });
    });

    if (this.dom.btnSaveCalibration) {
      this.dom.btnSaveCalibration.addEventListener('click', () => {
        this.saveAdminCalibration();
      });
    }

    // Admin Bus Form Toggles
    if (this.dom.btnAdminAddBusToggle) {
      this.dom.btnAdminAddBusToggle.addEventListener('click', () => {
        this.openAdminBusForm(null);
      });
    }

    if (this.dom.btnCancelBusForm) {
      this.dom.btnCancelBusForm.addEventListener('click', () => {
        this.dom.adminBusFormContainer.style.display = 'none';
        this.adminEditingBusId = null;
      });
    }

    if (this.dom.btnSaveBusForm) {
      this.dom.btnSaveBusForm.addEventListener('click', () => {
        this.saveAdminBusForm();
      });
    }

    // Admin Bus Position Select & Save
    if (this.dom.adminPosBusSelect) {
      this.dom.adminPosBusSelect.addEventListener('change', () => {
        this.updateAdminSelectedBus();
      });
    }

    if (this.dom.btnAdminSaveBusPos) {
      this.dom.btnAdminSaveBusPos.addEventListener('click', () => {
        this.saveAdminBusPosition();
      });
    }
  }

  renderAdminBusFleetList() {
    if (!this.dom.adminBusTableContainer || !this.busManager) return;

    const buses = this.busManager.buses || [];
    if (this.dom.adminBusTabCount) this.dom.adminBusTabCount.textContent = buses.length;
    if (this.dom.adminFleetCount) this.dom.adminFleetCount.textContent = buses.length;

    this.dom.adminBusTableContainer.innerHTML = '';

    if (buses.length === 0) {
      this.dom.adminBusTableContainer.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">
          No buses have been added yet. Click "+ Add Verified Bus" to register an official college bus.
        </div>
      `;
      return;
    }

    buses.forEach(bus => {
      const row = document.createElement('div');
      row.className = 'bus-card-row';
      const isActive = bus.isActive !== false;

      row.innerHTML = `
        <div class="bus-card-header">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="bus-num-badge">🚌 #${bus.busNumber}</span>
            <strong style="color: #fff; font-size: 13.5px;">${bus.routeName || bus.route || 'REC Bus'}</strong>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="tcard-status-badge status-${(bus.status || 'STATIC').toLowerCase().replace('_', '-')}">${bus.status || 'STATIC'}</span>
            <span class="bus-bay-pill">${bus.parkingBay || 'Bay'}</span>
          </div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; color: var(--text-secondary); margin-top: 4px; flex-wrap: wrap; gap: 6px;">
          <div>Driver: <strong style="color: #fff;">${bus.driver || 'Not configured'}</strong> (${bus.driverContact || '--'}) • Reg: ${bus.registrationNumber || bus.plateNumber || '--'}</div>
          <div style="display: flex; gap: 6px;">
            <button class="btn-secondary-outline btn-admin-edit-bus" style="height: 28px; padding: 0 10px; font-size: 11px;">✏️ Edit</button>
            <button class="btn-secondary-outline btn-admin-toggle-bus" style="height: 28px; padding: 0 10px; font-size: 11px; color: ${isActive ? 'var(--accent-amber)' : 'var(--accent-emerald)'};">
              ${isActive ? '⏸ Deactivate' : '▶ Activate'}
            </button>
            <button class="btn-secondary-outline btn-admin-pos-bus" style="height: 28px; padding: 0 10px; font-size: 11px;">📍 Position</button>
          </div>
        </div>
      `;

      row.querySelector('.btn-admin-edit-bus').addEventListener('click', () => {
        this.openAdminBusForm(bus);
      });

      row.querySelector('.btn-admin-toggle-bus').addEventListener('click', async () => {
        try {
          await this.busManager.saveBus({
            ...bus,
            isActive: !isActive
          });
          this.showToast(`Bus #${bus.busNumber} ${!isActive ? 'activated' : 'deactivated'}.`);
          this.renderAdminBusFleetList();
          this.updateTransportMapBuses();
        } catch (err) {
          alert('Failed to update status: ' + err.message);
        }
      });

      row.querySelector('.btn-admin-pos-bus').addEventListener('click', () => {
        this.dom.tabBtnBusPosition.click();
        if (this.dom.adminPosBusSelect) {
          this.dom.adminPosBusSelect.value = bus.busId;
          this.updateAdminSelectedBus();
        }
      });

      this.dom.adminBusTableContainer.appendChild(row);
    });
  }

  openAdminBusForm(bus) {
    this.adminEditingBusId = bus ? bus.busId : null;
    this.dom.adminBusFormTitle.textContent = bus ? `Edit Bus #${bus.busNumber}` : 'Add New Verified Bus';

    this.dom.formBusNum.value = bus ? bus.busNumber : '';
    this.dom.formBusPlate.value = bus ? (bus.registrationNumber || bus.plateNumber || '') : '';
    this.dom.formBusRoute.value = bus ? (bus.routeName || bus.route || '') : '';
    this.dom.formBusBay.value = bus ? (bus.parkingBay || '') : '';
    this.dom.formBusDriver.value = bus ? (bus.driver || bus.driverName || '') : '';
    this.dom.formBusPhone.value = bus ? (bus.driverContact || bus.driverPhone || '') : '';
    this.dom.formBusDeptTime.value = bus ? (bus.departureTime || '') : '';
    this.dom.formBusArrTime.value = bus ? (bus.arrivalTime || '') : '';
    this.dom.formBusStops.value = bus ? (Array.isArray(bus.boardingPoints) ? bus.boardingPoints.join(', ') : bus.boardingPoints || '') : '';

    this.dom.adminBusFormContainer.style.display = 'block';
    this.dom.formBusNum.focus();
  }

  async saveAdminBusForm() {
    const busNumber = this.dom.formBusNum.value.trim().toUpperCase();
    if (!busNumber) {
      alert('Bus Number is required (e.g. 10C, 15A).');
      return;
    }

    const existing = this.adminEditingBusId ? this.busManager.getBusById(this.adminEditingBusId) : null;
    const boardingPoints = this.dom.formBusStops.value.split(',').map(s => s.trim()).filter(Boolean);

    const busPayload = {
      busId: existing ? existing.busId : `rec_bus_${busNumber.toLowerCase()}`,
      busNumber: busNumber,
      registrationNumber: this.dom.formBusPlate.value.trim(),
      campus: 'REC Thandalam Campus',
      routeId: existing ? existing.routeId : `route_${busNumber.toLowerCase()}`,
      routeName: this.dom.formBusRoute.value.trim() || `Route ${busNumber}`,
      parkingBay: this.dom.formBusBay.value.trim(),
      driver: this.dom.formBusDriver.value.trim(),
      driverContact: this.dom.formBusPhone.value.trim(),
      departureTime: this.dom.formBusDeptTime.value.trim(),
      arrivalTime: this.dom.formBusArrTime.value.trim(),
      boardingPoints: boardingPoints,
      isActive: true,
      mapX: existing ? existing.mapX : 0.45,
      mapY: existing ? existing.mapY : 0.45,
      status: existing ? existing.status : 'STATIC'
    };

    try {
      await this.busManager.saveBus(busPayload);
      this.showToast(`✅ Bus #${busNumber} record saved successfully!`);
      this.dom.adminBusFormContainer.style.display = 'none';
      this.adminEditingBusId = null;
      this.renderAdminBusFleetList();
      this.updateTransportMapBuses();
      this.populateBusSelectOptions();
    } catch (err) {
      alert('Failed to save bus record: ' + err.message);
    }
  }

  initAdminMapEngine() {
    if (!this.dom.adminMapPositionContainer) return;

    if (!this.adminMapEngine) {
      this.adminMapEngine = new TransportMapEngine(this.dom.adminMapPositionContainer, {
        onPositionChanged: (coords) => {
          if (this.dom.adminPosValX) this.dom.adminPosValX.textContent = coords.mapX.toFixed(4);
          if (this.dom.adminPosValY) this.dom.adminPosValY.textContent = coords.mapY.toFixed(4);
        }
      });
    }

    // Populate bus dropdown
    const buses = this.busManager.buses || [];
    this.dom.adminPosBusSelect.innerHTML = '';
    buses.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.busId;
      opt.textContent = `Bus #${b.busNumber} — ${b.routeName || b.route || 'REC Bus'}`;
      this.dom.adminPosBusSelect.appendChild(opt);
    });

    setTimeout(() => {
      this.adminMapEngine.fitToScreen();
      this.updateAdminSelectedBus();
    }, 100);
  }

  updateAdminSelectedBus() {
    if (!this.adminMapEngine || !this.dom.adminPosBusSelect) return;
    const busId = this.dom.adminPosBusSelect.value;
    const bus = this.busManager.getBusById(busId);
    if (!bus) return;

    if (this.dom.adminPosBusName) this.dom.adminPosBusName.textContent = bus.busNumber;
    if (this.dom.adminPosBayDesc) this.dom.adminPosBayDesc.value = bus.parkingBay || `Bay ${bus.busNumber}`;

    const posX = bus.mapX !== null && bus.mapX !== undefined ? Number(bus.mapX) : 0.45;
    const posY = bus.mapY !== null && bus.mapY !== undefined ? Number(bus.mapY) : 0.45;

    if (this.dom.adminPosValX) this.dom.adminPosValX.textContent = posX.toFixed(4);
    if (this.dom.adminPosValY) this.dom.adminPosValY.textContent = posY.toFixed(4);

    this.adminMapEngine.enableAdminPlacementMode(bus, { x: posX, y: posY });
  }

  async saveAdminBusPosition() {
    if (!this.adminMapEngine || !this.dom.adminPosBusSelect) return;
    const busId = this.dom.adminPosBusSelect.value;
    const bus = this.busManager.getBusById(busId);
    if (!bus) {
      alert('Please select a bus.');
      return;
    }

    const coords = this.adminMapEngine.getAdminCoords();
    const bayDesc = (this.dom.adminPosBayDesc?.value || '').trim() || bus.parkingBay;

    try {
      await this.busManager.updateBusMapPosition(busId, coords.x, coords.y, bayDesc);
      this.showToast(`✅ Saved Bus #${bus.busNumber} position (X: ${coords.x.toFixed(4)}, Y: ${coords.y.toFixed(4)})`, 4000);
      
      // Update student transport map live
      this.updateTransportMapBuses();
      this.renderSearchResults();
    } catch (err) {
      alert('Failed to save position: ' + err.message);
    }
  }

  async loadAdminCalibration() {
    const cal = await this.busManager.getCalibration();
    if (cal) {
      this.populateCalibrationFields(cal);
    }
  }

  populateCalibrationFields(cal) {
    if (!cal) return;
    if (this.dom.calTlLat && cal.topLeft) this.dom.calTlLat.value = cal.topLeft.latitude;
    if (this.dom.calTlLon && cal.topLeft) this.dom.calTlLon.value = cal.topLeft.longitude;
    if (this.dom.calTrLat && cal.topRight) this.dom.calTrLat.value = cal.topRight.latitude;
    if (this.dom.calTrLon && cal.topRight) this.dom.calTrLon.value = cal.topRight.longitude;
    if (this.dom.calBlLat && cal.bottomLeft) this.dom.calBlLat.value = cal.bottomLeft.latitude;
    if (this.dom.calBlLon && cal.bottomLeft) this.dom.calBlLon.value = cal.bottomLeft.longitude;
    if (this.dom.calBrLat && cal.bottomRight) this.dom.calBrLat.value = cal.bottomRight.latitude;
    if (this.dom.calBrLon && cal.bottomRight) this.dom.calBrLon.value = cal.bottomRight.longitude;
    if (this.dom.calStatusText) {
      this.dom.calStatusText.textContent = cal.isVerified ? 'Status: Verified Active Calibration' : 'Status: Unverified / Pending Admin Verification';
      this.dom.calStatusText.style.color = cal.isVerified ? 'var(--accent-emerald)' : 'var(--accent-amber)';
    }
  }

  async saveAdminCalibration() {
    const tlLat = parseFloat(this.dom.calTlLat?.value);
    const tlLon = parseFloat(this.dom.calTlLon?.value);
    const trLat = parseFloat(this.dom.calTrLat?.value);
    const trLon = parseFloat(this.dom.calTrLon?.value);
    const blLat = parseFloat(this.dom.calBlLat?.value);
    const blLon = parseFloat(this.dom.calBlLon?.value);
    const brLat = parseFloat(this.dom.calBrLat?.value);
    const brLon = parseFloat(this.dom.calBrLon?.value);

    if (isNaN(tlLat) || isNaN(tlLon) || isNaN(trLat) || isNaN(trLon) ||
        isNaN(blLat) || isNaN(blLon) || isNaN(brLat) || isNaN(brLon)) {
      alert('All 4 corner coordinates (lat, lon) must be valid numbers.');
      return;
    }

    const payload = {
      topLeft: { latitude: tlLat, longitude: tlLon },
      topRight: { latitude: trLat, longitude: trLon },
      bottomLeft: { latitude: blLat, longitude: blLon },
      bottomRight: { latitude: brLat, longitude: brLon },
      isVerified: true
    };

    try {
      const saved = await this.busManager.saveCalibration(payload);
      if (this.transportMapEngine) {
        this.transportMapEngine.setCalibration(saved);
      }
      this.showToast('✅ 4-Corner Bilinear Calibration saved and broadcast to all clients.');
    } catch (err) {
      alert('Failed to save calibration: ' + err.message);
    }
  }

  // =========================================================================
  // CONNECTION MONITOR (ONLINE / OFFLINE BADGE)
  // =========================================================================

  initConnectionMonitor() {
    this.updateOnlineStatus(navigator.onLine);

    window.addEventListener('online', () => {
      this.updateOnlineStatus(true);
      this.busManager.syncWithBackend();
    });

    window.addEventListener('offline', () => {
      this.updateOnlineStatus(false);
    });

    // Periodically ping backend health
    setInterval(async () => {
      try {
        const res = await fetch('/api/status', { method: 'GET', cache: 'no-store' });
        this.updateOnlineStatus(res.ok);
      } catch (e) {
        this.updateOnlineStatus(false);
      }
    }, 12000);
  }

  updateOnlineStatus(isOnline) {
    this.isOnline = isOnline;

    // Top header status pill
    if (this.dom.connStatusPill && this.dom.connStatusLabel) {
      this.dom.connStatusPill.className = `conn-status-pill ${isOnline ? 'online' : 'offline'}`;
      this.dom.connStatusLabel.textContent = isOnline ? '🟢 ONLINE' : '🔴 OFFLINE';
      this.dom.connStatusPill.title = isOnline ? 'Backend Online • Live Telemetry Active' : 'Offline • Serving Verified IndexedDB Cache';
    }

    // Student transport map badge
    if (this.dom.tmapConnectionBadge && this.dom.tmapConnectionText) {
      this.dom.tmapConnectionBadge.className = `t-connection-badge ${isOnline ? 'online' : 'offline'}`;
      this.dom.tmapConnectionText.textContent = isOnline ? '🟢 ONLINE' : '🔴 OFFLINE';
    }
  }

  onCampusDataUpdated(updatedData) {
    this.campusData = updatedData;
    this.routerEngine = new CampusRouter(this.campusData);
    this.mapEngine.renderBuildings(this.campusData.locations);
    this.renderSearchResults();
    this.renderAdminList();
  }


  // =========================================================================
  // ACIMS REAL SMS NOTIFICATION SYSTEM CLIENT CONTROLLER
  // =========================================================================

  initSmsNotificationSystem() {
    this.dom.btnSmsModal = document.getElementById("btn-sms-modal");
    this.dom.smsModal = document.getElementById("sms-modal");
    this.dom.btnCloseSmsModal = document.getElementById("btn-close-sms-modal");
    this.dom.tcardSmsBox = document.getElementById("tcard-sms-box");
    this.dom.tcardSmsBadge = document.getElementById("tcard-sms-status-badge");
    this.dom.tcardSmsPhone = document.getElementById("tcard-sms-phone");
    this.dom.tcardSmsMeta = document.getElementById("tcard-sms-meta");
    this.dom.tcardSmsLastText = document.getElementById("tcard-sms-last-text");
    this.dom.tcardBtnManageSms = document.getElementById("tcard-btn-manage-sms");
    this.dom.tcardBtnTestSms = document.getElementById("tcard-btn-test-sms");

    this.dom.smsProviderBanner = document.getElementById("sms-provider-banner");
    this.dom.smsProviderStatusDot = document.getElementById("sms-provider-status-dot");
    this.dom.smsProviderStatusTitle = document.getElementById("sms-provider-status-title");
    this.dom.smsProviderStatusDetail = document.getElementById("sms-provider-status-detail");
    this.dom.smsToggleEnabled = document.getElementById("sms-toggle-enabled");
    this.dom.smsInputName = document.getElementById("sms-input-name");
    this.dom.smsInputPhone = document.getElementById("sms-input-phone");
    this.dom.smsPhoneValidationHint = document.getElementById("sms-phone-validation-hint");
    this.dom.smsSelectBus = document.getElementById("sms-select-bus");
    this.dom.smsSelectPickup = document.getElementById("sms-select-pickup");
    this.dom.btnSaveSmsProfile = document.getElementById("btn-save-sms-profile");

    this.dom.smsStatLastSent = document.getElementById("sms-stat-last-sent");
    this.dom.smsStatTriggerEta = document.getElementById("sms-stat-trigger-eta");
    this.dom.smsStatProviderStatus = document.getElementById("sms-stat-provider-status");
    this.dom.smsStatSid = document.getElementById("sms-stat-sid");

    this.dom.smsTestPhoneInput = document.getElementById("sms-test-phone-input");
    this.dom.btnTriggerRealTestSms = document.getElementById("btn-trigger-real-test-sms");
    this.dom.smsTestResultBox = document.getElementById("sms-test-result-box");

    this.dom.btnRunEtaSimulation = document.getElementById("btn-run-eta-simulation");
    this.dom.btnResetDedupState = document.getElementById("btn-reset-dedup-state");
    this.dom.smsSimulationOutput = document.getElementById("sms-simulation-output");
    this.dom.btnRefreshSmsLogs = document.getElementById("btn-refresh-sms-logs");
    this.dom.smsAuditLogContainer = document.getElementById("sms-audit-log-container");

    if (this.dom.btnSmsModal) {
      this.dom.btnSmsModal.addEventListener("click", () => this.openSmsModal());
    }
    if (this.dom.tcardBtnManageSms) {
      this.dom.tcardBtnManageSms.addEventListener("click", () => this.openSmsModal());
    }
    if (this.dom.tcardBtnTestSms) {
      this.dom.tcardBtnTestSms.addEventListener("click", () => {
        this.openSmsModal();
        if (this.dom.smsTestPhoneInput) {
          this.dom.smsTestPhoneInput.scrollIntoView({ behavior: "smooth" });
          this.dom.smsTestPhoneInput.focus();
        }
      });
    }
    if (this.dom.btnCloseSmsModal) {
      this.dom.btnCloseSmsModal.addEventListener("click", () => {
        if (this.dom.smsModal) this.dom.smsModal.classList.remove("visible");
      });
    }

    if (this.dom.smsInputPhone) {
      this.dom.smsInputPhone.addEventListener("input", () => this.validateSmsPhoneInput());
    }

    if (this.dom.btnSaveSmsProfile) {
      this.dom.btnSaveSmsProfile.addEventListener("click", () => this.saveSmsProfile());
    }

    if (this.dom.btnTriggerRealTestSms) {
      this.dom.btnTriggerRealTestSms.addEventListener("click", () => this.triggerRealTestSms());
    }

    if (this.dom.btnRunEtaSimulation) {
      this.dom.btnRunEtaSimulation.addEventListener("click", () => this.runEtaSimulation());
    }

    if (this.dom.btnResetDedupState) {
      this.dom.btnResetDedupState.addEventListener("click", async () => {
        try {
          await fetch("/api/notifications/reset", { method: "POST" });
          this.showToast("Deduplication state reset.");
          if (this.dom.smsSimulationOutput) this.dom.smsSimulationOutput.style.display = "none";
        } catch (e) {
          this.showToast("Failed to reset notification state");
        }
      });
    }

    if (this.dom.btnRefreshSmsLogs) {
      this.dom.btnRefreshSmsLogs.addEventListener("click", () => this.loadSmsLogs());
    }

    // Attach SSE listeners when busManager is initialized
    const attachSSE = () => {
      if (this.busManager && this.busManager.eventSource) {
        this.busManager.eventSource.addEventListener("STUDENT_NOTIFICATION_EVENT", (e) => {
          try {
            const data = JSON.parse(e.data);
            this.handleLiveNotificationEvent(data);
          } catch (err) {}
        });

        this.busManager.eventSource.addEventListener("STUDENT_PROFILE_UPDATED", (e) => {
          try {
            const profile = JSON.parse(e.data);
            this.currentStudentProfile = profile;
            this.renderSmsProfile(profile);
          } catch (err) {}
        });
      } else {
        setTimeout(attachSSE, 500);
      }
    };
    attachSSE();

    this.loadSmsProfile();
  }

  async loadSmsProfile() {
    try {
      const res = await fetch("/api/student/notification-profile");
      if (res.ok) {
        const data = await res.json();
        this.currentStudentProfile = data;
        this.renderSmsProfile(data);
      }
    } catch (e) {
      console.warn("[CampusApp] Could not load student notification profile:", e);
    }
  }

  renderSmsProfile(profile) {
    if (!profile) return;

    if (this.dom.smsInputName) this.dom.smsInputName.value = profile.name || "";
    if (this.dom.smsInputPhone) {
      this.dom.smsInputPhone.value = profile.phoneNumber || "";
      this.validateSmsPhoneInput();
    }
    if (this.dom.smsToggleEnabled) this.dom.smsToggleEnabled.checked = profile.smsEnabled !== false;
    if (this.dom.smsTestPhoneInput && !this.dom.smsTestPhoneInput.value) {
      this.dom.smsTestPhoneInput.value = profile.phoneNumber || "";
    }

    // Update Twilio provider banner
    if (this.dom.smsProviderBanner) {
      if (profile.twilioConfigured) {
        this.dom.smsProviderBanner.style.background = "rgba(16, 185, 129, 0.12)";
        this.dom.smsProviderBanner.style.borderColor = "rgba(16, 185, 129, 0.3)";
        this.dom.smsProviderBanner.style.color = "#6ee7b7";
        if (this.dom.smsProviderStatusDot) this.dom.smsProviderStatusDot.textContent = "🟢";
        if (this.dom.smsProviderStatusTitle) this.dom.smsProviderStatusTitle.textContent = "Twilio SMS Gateway: Connected";
        if (this.dom.smsProviderStatusDetail) this.dom.smsProviderStatusDetail.textContent = "Sender Number: " + (profile.fromNumber || "Configured in .env");
      } else {
        this.dom.smsProviderBanner.style.background = "rgba(245, 158, 11, 0.12)";
        this.dom.smsProviderBanner.style.borderColor = "rgba(245, 158, 11, 0.3)";
        this.dom.smsProviderBanner.style.color = "#fde68a";
        if (this.dom.smsProviderStatusDot) this.dom.smsProviderStatusDot.textContent = "🟡";
        if (this.dom.smsProviderStatusTitle) this.dom.smsProviderStatusTitle.textContent = "Twilio Credentials Pending in .env";
        if (this.dom.smsProviderStatusDetail) this.dom.smsProviderStatusDetail.textContent = "Configure TWILIO_ACCOUNT_SID, AUTH_TOKEN, PHONE_NUMBER";
      }
    }

    // Live alert stats
    if (profile.lastNotification) {
      const ln = profile.lastNotification;
      if (this.dom.smsStatLastSent) {
        this.dom.smsStatLastSent.textContent = ln.alertType === "10_MIN" ? "10-Min Alert" : (ln.alertType === "5_MIN" ? "5-Min Urgent Alert" : ln.alertType);
      }
      if (this.dom.smsStatTriggerEta) {
        this.dom.smsStatTriggerEta.textContent = ln.etaMinutes !== undefined && ln.etaMinutes !== null ? ln.etaMinutes + " min" : "--";
      }
      if (this.dom.smsStatProviderStatus) {
        this.dom.smsStatProviderStatus.textContent = (ln.status || "SENT").toUpperCase();
        this.dom.smsStatProviderStatus.style.color = ln.status === "failed" ? "#f43f5e" : "#a3e635";
      }
      if (this.dom.smsStatSid) {
        this.dom.smsStatSid.textContent = ln.messageSid ? "Message SID: " + ln.messageSid : (ln.error ? "Error: " + ln.error : "");
      }
    }

    // Update bus & pickup select options
    this.populateSmsSelects(profile);

    // Update active bus drawer if visible
    if (this.dom.tcard && this.dom.tcard.style.display !== "none") {
      const activeBusId = this.dom.tcard.dataset.activeBusId;
      const bus = this.busManager?.buses.find(b => b.busId === activeBusId);
      if (bus) this.updateSmsQuickStatusCard(bus);
    }
  }

  populateSmsSelects(profile) {
    if (this.dom.smsSelectBus && this.busManager) {
      const currentVal = profile.busId || "rec_bus_10c";
      this.dom.smsSelectBus.innerHTML = "";
      for (const b of this.busManager.buses) {
        const opt = document.createElement("option");
        opt.value = b.busId;
        opt.textContent = "Bus #" + b.busNumber + " — " + (b.routeName || b.route || "Campus");
        if (b.busId === currentVal) opt.selected = true;
        this.dom.smsSelectBus.appendChild(opt);
      }
    }

    if (this.dom.smsSelectPickup) {
      const currentStopId = profile.pickupPointId || "stop_main_gate";
      fetch("/api/stops").then(r => r.json()).then(stops => {
        if (Array.isArray(stops) && stops.length > 0) {
          this.dom.smsSelectPickup.innerHTML = "";
          for (const s of stops) {
            const opt = document.createElement("option");
            opt.value = s.stopId;
            opt.dataset.name = s.stopName;
            opt.textContent = s.stopName;
            if (s.stopId === currentStopId) opt.selected = true;
            this.dom.smsSelectPickup.appendChild(opt);
          }
        }
      }).catch(() => {});
    }
  }

  validateSmsPhoneInput() {
    if (!this.dom.smsInputPhone || !this.dom.smsPhoneValidationHint) return false;
    const raw = (this.dom.smsInputPhone.value || "").trim();
    if (!raw) {
      this.dom.smsPhoneValidationHint.textContent = "Standard 10-digit Indian number (+91)";
      this.dom.smsPhoneValidationHint.style.color = "var(--text-muted)";
      return false;
    }

    let cleaned = raw.replace(/[\s\-\(\)\.]/g, "");
    if (cleaned.startsWith("+")) cleaned = cleaned.substring(1);
    if (cleaned.startsWith("0") && cleaned.length === 11) cleaned = cleaned.substring(1);
    if (cleaned.startsWith("91") && cleaned.length === 12) cleaned = cleaned.substring(2);

    if (/^[6-9]\d{9}$/.test(cleaned)) {
      this.dom.smsPhoneValidationHint.textContent = "✓ Valid Indian mobile (+91" + cleaned + ")";
      this.dom.smsPhoneValidationHint.style.color = "var(--accent-emerald)";
      return true;
    } else {
      this.dom.smsPhoneValidationHint.textContent = "✗ Must be 10 digits starting with 6, 7, 8, or 9";
      this.dom.smsPhoneValidationHint.style.color = "var(--accent-rose)";
      return false;
    }
  }

  async openSmsModal() {
    if (!this.dom.smsModal) return;
    this.dom.smsModal.classList.add("visible");
    await this.loadSmsProfile();
    this.loadSmsLogs();
  }

  async saveSmsProfile() {
    const name = (this.dom.smsInputName?.value || "").trim();
    const phone = (this.dom.smsInputPhone?.value || "").trim();
    const busSelect = this.dom.smsSelectBus;
    const busId = busSelect ? busSelect.value : "rec_bus_10c";
    const busText = busSelect?.options[busSelect.selectedIndex]?.text || "10C";
    const busNumber = busText.split(" ")[0].replace("Bus", "").replace("#", "").trim();

    const pickupSelect = this.dom.smsSelectPickup;
    const pickupPointId = pickupSelect ? pickupSelect.value : "stop_main_gate";
    const pickupPointName = pickupSelect?.options[pickupSelect.selectedIndex]?.dataset.name || pickupSelect?.options[pickupSelect.selectedIndex]?.text || "Main Campus Entrance Gate (NH 48)";
    const smsEnabled = this.dom.smsToggleEnabled ? this.dom.smsToggleEnabled.checked : true;

    try {
      const res = await fetch("/api/student/notification-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          phoneNumber: phone,
          busId,
          busNumber,
          pickupPointId,
          pickupPointName,
          smsEnabled
        })
      });

      const data = await res.json();
      if (!res.ok) {
        this.showToast(data.error || "Failed to save settings");
        return;
      }

      this.currentStudentProfile = data.profile;
      this.renderSmsProfile(data.profile);
      this.showToast("Student SMS settings saved successfully!");
    } catch (err) {
      this.showToast("Error saving profile: " + err.message);
    }
  }

  async triggerRealTestSms() {
    const phone = (this.dom.smsTestPhoneInput?.value || "").trim();
    if (!phone) {
      this.showToast("Enter a test phone number first");
      return;
    }

    const box = this.dom.smsTestResultBox;
    if (!box) return;
    box.style.display = "block";
    box.style.background = "rgba(0,0,0,0.4)";
    box.style.color = "#fff";
    box.textContent = "Connecting to Twilio API and transmitting SMS...";

    try {
      const res = await fetch("/api/sms/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: phone,
          busNumber: this.currentStudentProfile?.busNumber || "10C",
          pickupPoint: this.currentStudentProfile?.pickupPointName || "Main Campus Entrance Gate (NH 48)"
        })
      });

      const data = await res.json();
      if (data.success) {
        box.style.background = "rgba(16, 185, 129, 0.2)";
        box.style.borderColor = "var(--accent-emerald)";
        box.style.color = "#a7f3d0";
        box.innerHTML = "<strong>✓ Real SMS Dispatched via Twilio!</strong><br>" +
          "Recipient: " + data.maskedPhone + "<br>" +
          "Twilio Message SID: <code>" + data.messageSid + "</code><br>" +
          "Status: <strong>" + data.status + "</strong>";
        this.showToast("Test SMS sent successfully via Twilio!");
      } else {
        box.style.background = "rgba(244, 63, 94, 0.2)";
        box.style.borderColor = "var(--accent-rose)";
        box.style.color = "#fecdd3";
        box.innerHTML = "<strong>✗ Twilio Dispatch Notice:</strong><br>" +
          (data.error || "Failed to send SMS") + "<br>" +
          (data.code ? "Error Code: " + data.code + "<br>" : "") +
          '<small style="opacity:0.8;">Configure valid credentials in .env to transmit live carrier SMS.</small>';
      }
      this.loadSmsLogs();
    } catch (e) {
      box.style.background = "rgba(244, 63, 94, 0.2)";
      box.style.color = "#fecdd3";
      box.textContent = "Network Error: " + e.message;
    }
  }

  async runEtaSimulation() {
    const out = this.dom.smsSimulationOutput;
    if (!out) return;
    out.style.display = "block";
    out.innerHTML = '<div style="color: var(--text-muted); text-align: center;">Simulating approach progression [12m → 10m → 9m → 5m → 4m]...</div>';

    try {
      const res = await fetch("/api/sms/simulate-eta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: this.currentStudentProfile?.phoneNumber,
          busNumber: this.currentStudentProfile?.busNumber || "10C",
          pickupPoint: this.currentStudentProfile?.pickupPointName || "Main Campus Entrance Gate (NH 48)",
          sendRealSMS: false,
          etaSequence: [12, 10, 9, 5, 4]
        })
      });

      const data = await res.json();
      if (data.success && Array.isArray(data.simulation)) {
        let html = '<div style="font-weight:700; color:#fff; margin-bottom:6px;">ETA Progression Deduplication Trace:</div>';
        for (const s of data.simulation) {
          let badgeClass = "none";
          let badgeText = "OUT OF WINDOW";
          if (s.action === "SENT_10_MIN") {
            badgeClass = "sent";
            badgeText = "10-MIN SMS TRIGGERED";
          } else if (s.action === "SENT_5_MIN") {
            badgeClass = "sent";
            badgeText = "5-MIN URGENT SMS TRIGGERED";
          } else if (s.action.startsWith("SUPPRESSED")) {
            badgeClass = "suppressed";
            badgeText = "DUPLICATE SUPPRESSED";
          }

          html += '<div class="sim-row">' +
            '<span>ETA: <strong>' + s.eta + ' min</strong></span>' +
            '<span class="sim-badge ' + badgeClass + '">' + badgeText + '</span>' +
            '</div>';
        }
        out.innerHTML = html;
        this.showToast("ETA simulation completed with zero duplicates!");
      }
    } catch (e) {
      out.textContent = "Simulation failed: " + e.message;
    }
  }

  async loadSmsLogs() {
    const container = this.dom.smsAuditLogContainer;
    if (!container) return;

    try {
      const res = await fetch("/api/notifications/logs");
      if (res.ok) {
        const data = await res.json();
        const logs = data.logs || [];
        if (logs.length === 0) {
          container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 10px;">No SMS logs recorded yet</div>';
          return;
        }

        let html = "";
        for (const log of logs.slice(0, 8)) {
          const time = new Date(log.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          const statusColor = log.success ? "#10b981" : "#f43f5e";
          html += '<div class="log-item-row">' +
            '<div class="log-item-header">' +
            '<strong>' + (log.alertType || "ALERT") + ' • ' + (log.busNumber ? "Bus " + log.busNumber : "") + '</strong>' +
            '<span style="color:' + statusColor + '; font-weight:700;">' + (log.status || (log.success ? "SENT" : "FAILED")) + '</span>' +
            '</div>' +
            '<div style="color:var(--text-secondary);">To: ' + (log.maskedPhone || "--") + ' • ETA: ' + (log.etaMinutes ? log.etaMinutes + "m" : "--") + ' • ' + time + '</div>' +
            (log.messageSid ? '<div style="font-family:monospace; font-size:10px; color:var(--text-muted);">SID: ' + log.messageSid + '</div>' : '') +
            '</div>';
        }
        container.innerHTML = html;
      }
    } catch (e) {}
  }

  handleLiveNotificationEvent(event) {
    if (!event) return;
    const msg = event.action === "SENT_10_MIN"
      ? "🔔 ACIMS SMS Sent: Your bus is ~10 min away!"
      : (event.action === "SENT_5_MIN"
        ? "🚨 ACIMS SMS Sent: Your bus is ~5 min away! Proceed to stop."
        : "ACIMS SMS Alert Triggered");
    this.showToast(msg, 5000);
    this.loadSmsProfile();
    this.loadSmsLogs();
  }

  updateSmsQuickStatusCard(bus) {
    if (!this.dom.tcardSmsBox || !bus) return;

    const student = this.currentStudentProfile;
    if (!student) return;

    const isAssigned = (student.busId && (student.busId === bus.busId || student.busId === bus.busNumber)) ||
                       (student.busNumber && student.busNumber === bus.busNumber);

    if (this.dom.tcardSmsPhone) {
      this.dom.tcardSmsPhone.textContent = student.maskedPhone || student.phoneNumber || "Not set";
    }

    if (this.dom.tcardSmsBadge) {
      if (student.smsEnabled !== false && isAssigned) {
        this.dom.tcardSmsBadge.className = "tcard-sms-badge";
        this.dom.tcardSmsBadge.textContent = "ACTIVE (10m & 5m)";
      } else {
        this.dom.tcardSmsBadge.className = "tcard-sms-badge inactive";
        this.dom.tcardSmsBadge.textContent = isAssigned ? "DISABLED" : "ASSIGNED TO ANOTHER BUS";
      }
    }

    if (student.lastNotification && this.dom.tcardSmsMeta && this.dom.tcardSmsLastText) {
      this.dom.tcardSmsMeta.style.display = "block";
      const ln = student.lastNotification;
      const time = new Date(ln.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      this.dom.tcardSmsLastText.textContent = (ln.alertType === "10_MIN" ? "10-Min Alert" : "5-Min Urgent Alert") +
        " (ETA " + ln.etaMinutes + "m) at " + time + " • " + (ln.status || "SENT");
    }
  }


  showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      top: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid var(--border-glass);
      color: #fff;
      padding: 10px 18px;
      border-radius: 9999px;
      font-size: 13px;
      font-family: var(--font-heading);
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      z-index: 3000;
      pointer-events: none;
      animation: slide-down 0.25s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }
}

// Start application when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  const app = new CampusApp();
  app.init();
});
