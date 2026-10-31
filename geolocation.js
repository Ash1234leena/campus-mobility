/**
 * REC Campus Mobility — Real-Time Geolocation & Navigation Tracking Manager
 * 
 * Manages device GPS hardware tracking, accuracy filtering, off-route deviation detection,
 * and arrival verification. Zero simulated movement; 100% genuine hardware telemetry.
 */

import { CampusRouter } from './router.js';

export class LocationManager {
  constructor(options = {}) {
    this.campusCenter = options.campusCenter || [13.008351, 80.003351]; // REC Center
    this.watchId = null;
    this.currentPosition = null;
    this.lastValidPosition = null;
    this.isTracking = false;
    this.isNavigating = false;
    this.activeDestination = null;
    this.activeRouteCoordinates = null;

    // Deviation & arrival control
    this.offRouteCounter = 0;
    this.offRouteThresholdMeters = 25;
    this.arrivalThresholdMeters = 18;
    this.hasArrived = false;

    // Callbacks
    this.onLocationUpdate = options.onLocationUpdate || (() => {});
    this.onAccuracyWarning = options.onAccuracyWarning || (() => {});
    this.onPermissionDenied = options.onPermissionDenied || (() => {});
    this.onPositionUnavailable = options.onPositionUnavailable || (() => {});
    this.onOffRoute = options.onOffRoute || (() => {});
    this.onArrival = options.onArrival || (() => {});
  }

  /**
   * Initializes device geolocation tracking
   */
  async startTracking() {
    if (!('geolocation' in navigator)) {
      this.onPositionUnavailable('Geolocation is not supported by your browser or device.');
      return false;
    }

    // Check permission state if API available
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const permissionStatus = await navigator.permissions.query({ name: 'geolocation' });
        permissionStatus.onchange = () => {
          if (permissionStatus.state === 'denied') {
            this.onPermissionDenied('Location access was revoked.');
          }
        };
      } catch (e) {
        // Permission query not supported on some mobile browsers
      }
    }

    const geoOptions = {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0
    };

    this.isTracking = true;

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handleSuccess(pos),
      (err) => this.handleError(err),
      geoOptions
    );

    return true;
  }

  /**
   * Stops geolocation watch
   */
  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.isTracking = false;
    this.isNavigating = false;
  }

  /**
   * Sets manual start location for remote testing of campus paths (clearly tagged as test mode)
   */
  setManualLocation(lat, lon, accuracy = 5, label = 'REC Main Gate') {
    const syntheticPos = {
      coords: {
        latitude: lat,
        longitude: lon,
        accuracy: accuracy,
        altitude: null,
        heading: null,
        speed: null
      },
      timestamp: Date.now(),
      isManualTestMode: true,
      label: label
    };
    this.handleSuccess(syntheticPos);
  }

  /**
   * Handles real GPS position updates
   */
  handleSuccess(pos) {
    const coords = pos.coords;
    const now = pos.timestamp || Date.now();

    // Sanity / Outlier check: Filter impossible GPS teleport jumps (>300m in <2 seconds)
    if (this.lastValidPosition && !pos.isManualTestMode) {
      const dt = (now - this.lastValidPosition.timestamp) / 1000;
      const dist = CampusRouter.haversineDistance(
        [this.lastValidPosition.latitude, this.lastValidPosition.longitude],
        [coords.latitude, coords.longitude]
      );
      if (dt > 0 && dt < 2 && dist > 300) {
        console.warn('Rejecting GPS jump anomaly:', dist, 'meters in', dt, 'seconds');
        return;
      }
    }

    // Distance to REC Campus
    const distToCampus = CampusRouter.haversineDistance(
      [coords.latitude, coords.longitude],
      this.campusCenter
    );

    const isInsideCampus = distToCampus <= 800; // Within 800m of campus center
    const isLowAccuracy = coords.accuracy > 30;

    const locationData = {
      latitude: coords.latitude,
      longitude: coords.longitude,
      accuracy: Math.round(coords.accuracy),
      speed: coords.speed ? Math.round(coords.speed * 3.6) : null, // km/h
      heading: coords.heading || null,
      timestamp: now,
      isInsideCampus,
      distToCampusMeters: Math.round(distToCampus),
      distToCampusKm: (distToCampus / 1000).toFixed(1),
      isLowAccuracy,
      isManualTestMode: Boolean(pos.isManualTestMode),
      label: pos.label || null
    };

    this.currentPosition = locationData;
    this.lastValidPosition = locationData;

    // Trigger low accuracy warning if accuracy exceeds 30m
    if (isLowAccuracy) {
      this.onAccuracyWarning({
        accuracy: locationData.accuracy,
        message: `GPS accuracy is low (±${locationData.accuracy}m). Move to an open area with clear sky view for best accuracy.`
      });
    }

    // Forward to general listener
    this.onLocationUpdate(locationData);

    // If active turn-by-turn navigation is running, perform real-time checks
    if (this.isNavigating && this.activeDestination && this.activeRouteCoordinates) {
      this.processActiveNavigation(locationData);
    }
  }

  /**
   * Evaluates active navigation state: off-route detection and arrival detection
   */
  processActiveNavigation(locationData) {
    const userPoint = [locationData.latitude, locationData.longitude];

    // 1. Check Arrival
    const destCoords = [
      this.activeDestination.latitude,
      this.activeDestination.longitude
    ];
    const arrivalCheck = CampusRouter.checkArrival(
      userPoint,
      destCoords,
      Math.max(this.arrivalThresholdMeters, Math.min(locationData.accuracy, 25))
    );

    if (arrivalCheck.arrived && !this.hasArrived) {
      this.hasArrived = true;
      this.isNavigating = false;

      // Haptic feedback if supported on mobile
      if ('vibrate' in navigator) {
        try { navigator.vibrate([150, 75, 200]); } catch (e) {}
      }

      this.onArrival({
        destination: this.activeDestination,
        distanceMeters: arrivalCheck.distanceToDestination
      });
      return;
    }

    // 2. Check Off-Route Deviation
    const offRouteCheck = CampusRouter.checkOffRoute(
      userPoint,
      this.activeRouteCoordinates,
      this.offRouteThresholdMeters
    );

    if (offRouteCheck.isOffRoute) {
      this.offRouteCounter++;
      // Require 2 consecutive off-route signals to eliminate single-reading GPS flutter
      if (this.offRouteCounter >= 2) {
        console.warn(`User deviated ${offRouteCheck.minDistance}m from route.`);
        this.offRouteCounter = 0; // Reset
        this.onOffRoute({
          deviationMeters: offRouteCheck.minDistance,
          currentLocation: locationData,
          destination: this.activeDestination
        });
      }
    } else {
      this.offRouteCounter = 0;
    }
  }

  /**
   * Starts active live navigation mode toward a destination with a calculated route
   */
  startNavigation(destination, routeCoordinates) {
    this.isNavigating = true;
    this.activeDestination = destination;
    this.activeRouteCoordinates = routeCoordinates;
    this.offRouteCounter = 0;
    this.hasArrived = false;

    // Immediately evaluate with current position
    if (this.currentPosition) {
      this.processActiveNavigation(this.currentPosition);
    }
  }

  /**
   * Updates the active route (e.g. after recalculation)
   */
  updateActiveRoute(newRouteCoordinates) {
    this.activeRouteCoordinates = newRouteCoordinates;
    this.offRouteCounter = 0;
  }

  /**
   * Stops active navigation mode
   */
  stopNavigation() {
    this.isNavigating = false;
    this.activeDestination = null;
    this.activeRouteCoordinates = null;
    this.offRouteCounter = 0;
    this.hasArrived = false;
  }

  /**
   * Geolocation error handler
   */
  handleError(err) {
    console.error('Geolocation hardware error:', err);
    switch (err.code) {
      case err.PERMISSION_DENIED:
        this.onPermissionDenied('Location access was denied. Please allow location permissions in your browser settings to navigate.');
        break;
      case err.POSITION_UNAVAILABLE:
        this.onPositionUnavailable('Location information is currently unavailable from your device.');
        break;
      case err.TIMEOUT:
        this.onPositionUnavailable('Location request timed out. Retrying...');
        break;
      default:
        this.onPositionUnavailable(err.message || 'An unknown error occurred while retrieving device location.');
    }
  }

  /**
   * Gets current location snapshot
   */
  getCurrentLocation() {
    return this.currentPosition;
  }
}
