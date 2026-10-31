/**
 * REC Campus Mobility — Direct, Accurate, Road-Following Routing Engine
 * 
 * Provides true, sensible road and pedestrian routes across Rajalakshmi Engineering College (REC).
 * 
 * Key Capabilities:
 * 1. Road-Following Navigation: Uses high-performance road-network engines (OSRM Driving & Foot profiles)
 *    with fail-safe fallback to the verified REC campus road & walkway network graph (A* pathfinding).
 * 2. Anti-Detour & Anti-Looping: Eliminates unnecessary turns, loops, dead-end parking slot traps,
 *    and backtracking away from destinations.
 * 3. Directional Road Snapping: Projects positions onto connected road segments rather than snapping
 *    backwards to behind-the-user nodes.
 * 4. Realistic Road Termination: Ends cleanly at building entrances, designated bus stops, or live bus
 *    positions instead of cutting arbitrary straight lines through buildings or fields.
 * 5. Bus & Vehicle Accessibility: Accounts for bus-accessible service roads vs pedestrian paths.
 * 6. Multi-Stop Waypoints: Supports sequential stop routing preserving required stop order.
 * 7. Route Quality Validation: Prunes spikes, removes duplicate coordinates, and validates directness.
 * 
 * NO straight-line shortcuts through buildings. NO fake coordinates. Zero simulated movement.
 */

export class CampusRouter {
  constructor(campusData) {
    this.campusData = campusData;
    this.nodesMap = new Map();
    this.adjacencyList = new Map();
    this.edges = [];
    this.initGraph();
  }

  /**
   * Initializes the verified in-campus road and walkway network graph
   */
  initGraph() {
    if (!this.campusData || !this.campusData.walkway_network) return;

    const { nodes, edges } = this.campusData.walkway_network;
    this.edges = edges || [];

    // Verified service road way IDs on REC campus suitable for buses & vehicles
    const busAccessibleWayIds = new Set([
      384824290,   // Main campus spine road from NH 48 entrance
      833739275,   // East corridor road past Library and Auditorium
      833740494,   // Cross connector road between Main Spine and East corridor
      833740496,   // Southern quadrangle road near C Block & Academic Block
      1123856574,  // North-Central campus circulation road
      1557573757,  // Admin Block & Tech Lounge service road
      1557578243   // Workshop avenue service road
    ]);

    // Index all nodes
    for (const node of nodes) {
      this.nodesMap.set(node.id, node);
      this.adjacencyList.set(node.id, []);
    }

    // Index all bidirectional walkable and drivable edges
    for (const edge of this.edges) {
      if (edge.walkable === false) continue;
      const neighborsFrom = this.adjacencyList.get(edge.from);
      const neighborsTo = this.adjacencyList.get(edge.to);

      const isBusAccessible = busAccessibleWayIds.has(Number(edge.way_id)) || edge.bus_accessible === true;
      edge.busAccessible = isBusAccessible;

      if (neighborsFrom && neighborsTo) {
        neighborsFrom.push({
          nodeId: edge.to,
          distance: edge.distance,
          wayId: edge.way_id,
          edgeId: edge.id,
          busAccessible: isBusAccessible
        });
        neighborsTo.push({
          nodeId: edge.from,
          distance: edge.distance,
          wayId: edge.way_id,
          edgeId: edge.id,
          busAccessible: isBusAccessible
        });
      }
    }
  }

  /**
   * Calculates Haversine distance in meters between two [lat, lon] coordinates
   */
  static haversineDistance(c1, c2) {
    if (!c1 || !c2) return 0;
    const lat1 = Number(c1[0]), lon1 = Number(c1[1]);
    const lat2 = Number(c2[0]), lon2 = Number(c2[1]);
    const R = 6371000; // Earth radius in meters
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Calculates initial bearing between two coordinates in degrees (0 = North, 90 = East, etc.)
   */
  static calculateBearing(c1, c2) {
    if (!c1 || !c2) return 0;
    const lat1 = Number(c1[0]) * Math.PI / 180;
    const lon1 = Number(c1[1]) * Math.PI / 180;
    const lat2 = Number(c2[0]) * Math.PI / 180;
    const lon2 = Number(c2[1]) * Math.PI / 180;
    const dLon = lon2 - lon1;

    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
              Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    let brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
  }

  /**
   * Converts bearing change into human-readable turn maneuver
   */
  static getTurnManeuver(bearing1, bearing2) {
    let diff = (bearing2 - bearing1 + 360) % 360;
    if (diff > 180) diff -= 360;

    if (Math.abs(diff) < 20) return { type: 'straight', text: 'Continue straight' };
    if (diff >= 20 && diff < 60) return { type: 'slight-right', text: 'Turn slight right' };
    if (diff >= 60 && diff < 120) return { type: 'right', text: 'Turn right' };
    if (diff >= 120 && diff < 160) return { type: 'sharp-right', text: 'Turn sharp right' };
    if (diff <= -20 && diff > -60) return { type: 'slight-left', text: 'Turn slight left' };
    if (diff <= -60 && diff > -120) return { type: 'left', text: 'Turn left' };
    if (diff <= -120 && diff > -160) return { type: 'sharp-left', text: 'Turn sharp left' };
    return { type: 'u-turn', text: 'Make a U-turn' };
  }

  /**
   * Calculates perpendicular distance from a point to a line segment
   */
  static distanceToSegment(p, v, w) {
    const proj = CampusRouter.projectPointToSegment(p, v, w);
    return proj.distance;
  }

  /**
   * Projects a point onto a line segment (v -> w), accounting for spherical longitude scaling
   */
  static projectPointToSegment(p, v, w) {
    // p, v, w: [lat, lon]
    const pLat = Number(p[0]), pLon = Number(p[1]);
    const vLat = Number(v[0]), vLon = Number(v[1]);
    const wLat = Number(w[0]), wLon = Number(w[1]);

    const meanLat = ((vLat + wLat) / 2) * Math.PI / 180;
    const cosLat = Math.cos(meanLat);

    const vx = vLon * cosLat, vy = vLat;
    const wx = wLon * cosLat, wy = wLat;
    const px = pLon * cosLat, py = pLat;

    const dx = wx - vx;
    const dy = wy - vy;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
      return {
        point: [vLat, vLon],
        t: 0,
        distance: CampusRouter.haversineDistance(p, v)
      };
    }

    let t = ((px - vx) * dx + (py - vy) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const projPoint = [
      vLat + t * (wLat - vLat),
      vLon + t * (wLon - vLon)
    ];

    return {
      point: projPoint,
      t: t,
      distance: CampusRouter.haversineDistance(p, projPoint)
    };
  }

  /**
   * Projects an arbitrary [lat, lon] point onto the nearest road segment in the campus graph
   */
  findNearestRoadProjection(point, options = {}) {
    const onlyBusAccessible = Boolean(options.busAccessible);
    let bestDist = Infinity;
    let bestProj = null;
    let bestEdge = null;

    for (const edge of this.edges) {
      if (onlyBusAccessible && !edge.busAccessible) continue;
      const nA = this.nodesMap.get(edge.from);
      const nB = this.nodesMap.get(edge.to);
      if (!nA || !nB) continue;

      const proj = CampusRouter.projectPointToSegment(point, [nA.lat, nA.lon], [nB.lat, nB.lon]);
      if (proj.distance < bestDist) {
        bestDist = proj.distance;
        bestProj = proj;
        bestEdge = edge;
      }
    }

    return {
      point: bestProj ? bestProj.point : point,
      distance: bestDist,
      edge: bestEdge,
      fromNodeId: bestEdge?.from || null,
      toNodeId: bestEdge?.to || null,
      t: bestProj ? bestProj.t : 0
    };
  }

  /**
   * Legacy helper: Snaps an arbitrary [lat, lon] coordinate to the closest node on the campus graph
   */
  findNearestWalkwayNode(point, options = {}) {
    const onlyBusAccessible = Boolean(options.busAccessible);
    let bestDist = Infinity;
    let bestNode = null;

    for (const [nodeId, node] of this.nodesMap.entries()) {
      if (onlyBusAccessible) {
        const neighbors = this.adjacencyList.get(nodeId) || [];
        const hasBusEdge = neighbors.some(n => n.busAccessible);
        if (!hasBusEdge) continue;
      }

      const d = CampusRouter.haversineDistance(point, [node.lat, node.lon]);
      if (d < bestDist) {
        bestDist = d;
        bestNode = node;
      }
    }

    return { node: bestNode, distance: bestDist };
  }

  /**
   * Resolves the sensible, connected road endpoint coordinates for a destination
   * to avoid dead-end parking slot detours and straight-line cuts through buildings.
   */
  resolveEndpointCoordinates(locationObj, isOrigin = false) {
    if (!locationObj) return null;

    const rawLat = locationObj.latitude ?? locationObj.lastLatitude ?? locationObj.lat;
    const rawLon = locationObj.longitude ?? locationObj.lastLongitude ?? locationObj.lon;
    if (rawLat == null || rawLon == null) return null;

    const point = [Number(rawLat), Number(rawLon)];

    // 1. If it has a verified road entrance, prefer the entrance coordinates
    if (locationObj.entrance && locationObj.entrance.latitude && locationObj.entrance.longitude) {
      const entLat = Number(locationObj.entrance.latitude);
      const entLon = Number(locationObj.entrance.longitude);
      return {
        roadCoords: [entLat, entLon],
        actualCoords: point,
        walkwayNodeId: locationObj.entrance.walkway_node_id || null,
        isEntrance: true
      };
    }

    // 2. Known Parking Zones (PARKWIZ 1 & PARKWIZ 2):
    // Snap to the through-road spine node to prevent OSRM from routing north into a dead-end slot
    if (locationObj.id === 'rec_parkwiz_1' || locationObj.building_code === 'PKG-01' || locationObj.name?.includes('PARKWIZ 1')) {
      return {
        roadCoords: [13.0112322, 80.0010702], // node_3881789998 on through-road
        actualCoords: point,
        walkwayNodeId: 'node_3881789998',
        isEntrance: true
      };
    }
    if (locationObj.id === 'rec_parkwiz_2' || locationObj.building_code === 'PKG-02' || locationObj.name?.includes('PARKWIZ 2')) {
      return {
        roadCoords: [13.011205, 80.0011243], // node_12071943790 on through-road
        actualCoords: point,
        walkwayNodeId: 'node_12071943790',
        isEntrance: true
      };
    }

    // 3. Main Gate
    if (locationObj.id === 'rec_main_gate' || locationObj.name?.includes('Main Gate') || locationObj.building_code === 'GATE-01') {
      return {
        roadCoords: [13.0124751, 80.0003439], // node_3881789997
        actualCoords: point,
        walkwayNodeId: 'node_3881789997',
        isEntrance: true
      };
    }

    // 4. College Bus Destination (Moving or Parked in Bay)
    if (locationObj.isBus || locationObj.category === 'Buses') {
      const proj = this.findNearestRoadProjection(point, { busAccessible: true });
      return {
        roadCoords: proj.distance < 45 ? proj.point : point,
        actualCoords: point,
        walkwayNodeId: proj.fromNodeId || null,
        isEntrance: false
      };
    }

    // 5. General building or arbitrary point: project to nearest road segment
    const proj = this.findNearestRoadProjection(point);
    return {
      roadCoords: proj.distance < 40 ? proj.point : point,
      actualCoords: point,
      walkwayNodeId: proj.fromNodeId || null,
      isEntrance: false
    };
  }

  /**
   * Advanced A* Pathfinding over verified REC road and walkway network.
   * Features:
   * - Directional segment snapping (no 180° backtracking to behind-the-user nodes)
   * - Euclidean A* heuristic
   * - Turn-angle penalties (penalizes zigzagging & reversals, prefers continuous roads)
   * - Vehicle/bus accessibility constraint
   */
  calculateGraphAStarPath(startCoord, endCoord, options = {}) {
    const busAccessible = Boolean(options.busAccessible || options.profile === 'driving');
    const startProj = this.findNearestRoadProjection(startCoord, { busAccessible });
    const endProj = this.findNearestRoadProjection(endCoord, { busAccessible });

    if (!startProj.edge || !endProj.edge) {
      return null;
    }

    // Case A: Both start and end project onto the EXACT same road edge
    if (startProj.edge.id === endProj.edge.id) {
      const directDist = CampusRouter.haversineDistance(startProj.point, endProj.point);
      const raw = [startCoord];
      if (CampusRouter.haversineDistance(startCoord, startProj.point) > 2) raw.push(startProj.point);
      raw.push(endProj.point);
      if (CampusRouter.haversineDistance(endProj.point, endCoord) > 2) raw.push(endCoord);

      const cleaned = CampusRouter.validateAndCleanPolyline(raw, startCoord, endCoord);
      const totalDist = Math.round(startProj.distance + directDist + endProj.distance);
      return {
        success: true,
        provider: 'REC Verified Road Graph (A*)',
        distanceMeters: totalDist,
        durationMinutes: Math.max(1, Math.round(totalDist / (busAccessible ? 250 : 75))),
        coordinates: cleaned,
        steps: this.synthesizeStepsFromCoordinates(cleaned, options.destinationName || 'Destination')
      };
    }

    // Case B: Pathfinding across connected road segments
    // Candidates at start: traveler can proceed towards fromNode or toNode along edge
    const startEdgeDist = startProj.edge.distance;
    const startCandidates = [
      { nodeId: startProj.fromNodeId, initCost: startProj.t * startEdgeDist, anchor: startProj.point },
      { nodeId: startProj.toNodeId, initCost: (1 - startProj.t) * startEdgeDist, anchor: startProj.point }
    ];

    const targetCandidates = new Set([endProj.fromNodeId, endProj.toNodeId]);

    let bestPath = null;
    let bestTotalCost = Infinity;

    for (const startCand of startCandidates) {
      if (!this.nodesMap.has(startCand.nodeId)) continue;

      const dists = new Map();
      const prev = new Map();
      const openSet = new Set([startCand.nodeId]);

      for (const nid of this.nodesMap.keys()) {
        dists.set(nid, Infinity);
      }
      dists.set(startCand.nodeId, startCand.initCost);

      while (openSet.size > 0) {
        let curr = null;
        let lowestF = Infinity;

        for (const nid of openSet) {
          const g = dists.get(nid);
          const node = this.nodesMap.get(nid);
          const h = CampusRouter.haversineDistance([node.lat, node.lon], endProj.point);
          const f = g + h;
          if (f < lowestF) {
            lowestF = f;
            curr = nid;
          }
        }

        if (curr === null || dists.get(curr) === Infinity) break;

        // If target road boundary node reached
        if (targetCandidates.has(curr)) {
          const endEdgeDist = endProj.edge.distance;
          const finalCost = (curr === endProj.fromNodeId ? endProj.t * endEdgeDist : (1 - endProj.t) * endEdgeDist);
          const totalCost = dists.get(curr) + finalCost;
          if (totalCost < bestTotalCost) {
            bestTotalCost = totalCost;
            bestPath = { endNode: curr, prevMap: prev, distsMap: dists };
          }
          break;
        }

        openSet.delete(curr);

        const currNode = this.nodesMap.get(curr);
        const currCoord = [currNode.lat, currNode.lon];
        const prevNodeId = prev.get(curr);
        const prevCoord = prevNodeId 
          ? [this.nodesMap.get(prevNodeId).lat, this.nodesMap.get(prevNodeId).lon] 
          : startCand.anchor;
        const bearingIn = CampusRouter.calculateBearing(prevCoord, currCoord);

        const neighbors = this.adjacencyList.get(curr) || [];
        for (const neighbor of neighbors) {
          if (busAccessible && !neighbor.busAccessible) continue;

          const nextNode = this.nodesMap.get(neighbor.nodeId);
          if (!nextNode) continue;
          const nextCoord = [nextNode.lat, nextNode.lon];
          const bearingOut = CampusRouter.calculateBearing(currCoord, nextCoord);

          let turnDiff = Math.abs(bearingOut - bearingIn);
          if (turnDiff > 180) turnDiff = 360 - turnDiff;

          // Turn penalties to prioritize smooth, continuous road-following
          let turnPenalty = 0;
          if (turnDiff > 25 && turnDiff <= 60) turnPenalty = 3;
          else if (turnDiff > 60 && turnDiff <= 110) turnPenalty = 8;
          else if (turnDiff > 110 && turnDiff <= 145) turnPenalty = 20;
          else if (turnDiff > 145) turnPenalty = 150; // Heavy penalty against U-turns

          const alt = dists.get(curr) + neighbor.distance + turnPenalty;
          if (alt < dists.get(neighbor.nodeId)) {
            dists.set(neighbor.nodeId, alt);
            prev.set(neighbor.nodeId, curr);
            openSet.add(neighbor.nodeId);
          }
        }
      }
    }

    if (!bestPath) return null;

    // Reconstruct road nodes
    const nodeSequence = [];
    let curr = bestPath.endNode;
    while (curr) {
      nodeSequence.unshift(curr);
      curr = bestPath.prevMap.get(curr);
    }

    const assembledCoords = [];
    assembledCoords.push(startCoord);

    if (CampusRouter.haversineDistance(startCoord, startProj.point) > 2) {
      assembledCoords.push(startProj.point);
    }

    for (const nid of nodeSequence) {
      const n = this.nodesMap.get(nid);
      assembledCoords.push([n.lat, n.lon]);
    }

    if (CampusRouter.haversineDistance(endProj.point, endCoord) > 2) {
      assembledCoords.push(endProj.point);
    }
    assembledCoords.push(endCoord);

    const cleanedCoords = CampusRouter.validateAndCleanPolyline(assembledCoords, startCoord, endCoord);
    const totalDist = Math.round(bestTotalCost + startProj.distance + endProj.distance);
    const durationMinutes = Math.max(1, Math.round(totalDist / (busAccessible ? 250 : 75)));

    return {
      success: true,
      provider: 'REC Verified Road Graph (A*)',
      distanceMeters: totalDist,
      durationMinutes: durationMinutes,
      coordinates: cleanedCoords,
      steps: this.synthesizeStepsFromCoordinates(cleanedCoords, options.destinationName || 'Destination')
    };
  }

  /**
   * Fetches real road-following routes from OSRM engines with profile selection,
   * multiple endpoint failovers, and route quality scoring.
   */
  async fetchOSRMRoute(origin, destination, options = {}) {
    // origin: [lat, lon], destination: [lat, lon]
    const [lat1, lon1] = origin;
    const [lat2, lon2] = destination;

    const profile = options.profile === 'driving' || options.busAccessible ? 'driving' : 'foot';
    
    // Ordered endpoints for high reliability
    const endpointUrls = [
      profile === 'driving'
        ? `https://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson&steps=true&alternatives=true&continue_straight=true`
        : `https://router.project-osrm.org/route/v1/foot/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson&steps=true&alternatives=true&continue_straight=true`,
      profile === 'driving'
        ? `https://routing.openstreetmap.de/routed-car/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson&steps=true&alternatives=true&continue_straight=true`
        : `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson&steps=true&alternatives=true&continue_straight=true`
    ];

    for (const url of endpointUrls) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500); // 4.5s timeout per endpoint

      try {
        const response = await fetch(url, {
          headers: { 'Accept': 'application/json' },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) continue;

        const data = await response.json();
        if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) continue;

        // Evaluate all returned routes and pick the most direct, sensible route
        const directDistance = CampusRouter.haversineDistance(origin, destination);
        let bestRoute = null;
        let bestQualityScore = Infinity;

        for (const candidateRoute of data.routes) {
          if (!candidateRoute.geometry || !candidateRoute.geometry.coordinates || candidateRoute.geometry.coordinates.length < 2) {
            continue;
          }

          const rawCoords = candidateRoute.geometry.coordinates.map(c => [c[1], c[0]]);
          const dist = candidateRoute.distance;
          const directnessRatio = directDistance > 15 ? (dist / directDistance) : 1;

          // Count sharp bearing reversals (>135°) to detect U-turn detours
          let reversalCount = 0;
          for (let i = 0; i < rawCoords.length - 2; i++) {
            const b1 = CampusRouter.calculateBearing(rawCoords[i], rawCoords[i + 1]);
            const b2 = CampusRouter.calculateBearing(rawCoords[i + 1], rawCoords[i + 2]);
            let diff = Math.abs(b2 - b1);
            if (diff > 180) diff = 360 - diff;
            if (diff > 135) reversalCount++;
          }

          // Penalize indirect routes that beat around the bush
          let score = dist + (reversalCount * 250);
          if (directnessRatio > 1.85) score += 450;
          if (directnessRatio > 2.5) score += 1200;

          if (score < bestQualityScore) {
            bestQualityScore = score;
            bestRoute = {
              route: candidateRoute,
              coords: rawCoords,
              directnessRatio,
              reversalCount
            };
          }
        }

        if (!bestRoute) continue;

        // If even the best route exhibits extreme detour (>2.6x direct distance)
        // reject it so the direct in-campus A* road graph is preferred
        if (bestRoute.directnessRatio > 2.6 && directDistance > 50) {
          console.warn(`[CampusRouter] OSRM route rejected due to excessive detour ratio (${bestRoute.directnessRatio.toFixed(2)}x)`);
          continue;
        }

        // Parse turn-by-turn steps
        const steps = [];
        const leg = bestRoute.route.legs?.[0];
        if (leg && leg.steps) {
          for (const step of leg.steps) {
            steps.push({
              instruction: this.formatManeuverText(step.maneuver, step.name),
              distanceMeters: Math.round(step.distance),
              durationSeconds: Math.round(step.duration),
              location: [step.maneuver.location[1], step.maneuver.location[0]],
              type: step.maneuver.modifier ? step.maneuver.modifier.replace(' ', '-') : (step.maneuver.type || 'straight')
            });
          }
        }

        // Attach actual origin and destination cleanly
        const fullCoords = [origin, ...bestRoute.coords, destination];
        const cleanedCoords = CampusRouter.validateAndCleanPolyline(fullCoords, origin, destination);

        const durationMins = profile === 'driving'
          ? Math.max(1, Math.round(bestRoute.route.duration / 60))
          : Math.max(1, Math.round(bestRoute.route.distance / 78));

        return {
          success: true,
          provider: profile === 'driving' ? 'OSRM Direct Road Engine' : 'OSRM Foot Pedestrian Engine',
          profile: profile,
          distanceMeters: Math.round(bestRoute.route.distance),
          durationMinutes: durationMins,
          coordinates: cleanedCoords,
          steps: steps.length > 0 ? steps : this.synthesizeStepsFromCoordinates(cleanedCoords, options.destinationName || 'Destination')
        };
      } catch (err) {
        clearTimeout(timeoutId);
        // Continue to next endpoint failover
      }
    }

    return null;
  }

  /**
   * Formats OSRM maneuver instructions into clean, natural navigation guidance
   */
  formatManeuverText(maneuver, streetName) {
    const type = maneuver.type;
    const modifier = maneuver.modifier;
    const name = streetName && streetName.trim() !== '' ? streetName : 'campus avenue';

    if (type === 'depart') return `Proceed along ${name}`;
    if (type === 'arrive') return `Arrive at destination`;
    if (type === 'turn') {
      if (modifier === 'left') return `Turn left onto ${name}`;
      if (modifier === 'right') return `Turn right onto ${name}`;
      if (modifier === 'slight left') return `Turn slight left onto ${name}`;
      if (modifier === 'slight right') return `Turn slight right onto ${name}`;
      if (modifier === 'sharp left') return `Turn sharp left onto ${name}`;
      if (modifier === 'sharp right') return `Turn sharp right onto ${name}`;
    }
    if (type === 'fork') {
      if (modifier === 'left' || modifier === 'slight left') return `Keep left onto ${name}`;
      if (modifier === 'right' || modifier === 'slight right') return `Keep right onto ${name}`;
    }
    if (type === 'new name' || type === 'continue') {
      return `Continue along ${name}`;
    }
    return `Continue on ${name}`;
  }

  /**
   * Route Quality Validator & Pruner:
   * - Deduplicates consecutive identical or near-identical coordinates (< 0.8m)
   * - Eliminates acute micro-spikes and false reversals (> 140° reversal within 25m)
   * - Ensures the route begins at the true GPS origin and ends at the true destination
   * - Validates finite coordinates within Tamil Nadu / REC bounding box
   */
  static validateAndCleanPolyline(coords, origin, destination) {
    if (!coords || coords.length === 0) return [];
    if (coords.length === 1) return coords;

    // Filter non-finite coordinates
    const validCoords = coords.filter(c => {
      if (!c || c.length < 2) return false;
      const lat = Number(c[0]), lon = Number(c[1]);
      return isFinite(lat) && isFinite(lon) && lat >= 12.5 && lat <= 13.5 && lon >= 79.5 && lon <= 80.5;
    }).map(c => [Number(c[0]), Number(c[1])]);

    if (validCoords.length < 2) return validCoords;

    // Step 1: Deduplicate consecutive coordinates closer than 0.8 meters
    const deduplicated = [validCoords[0]];
    for (let i = 1; i < validCoords.length; i++) {
      const prev = deduplicated[deduplicated.length - 1];
      const curr = validCoords[i];
      if (CampusRouter.haversineDistance(prev, curr) >= 0.8) {
        deduplicated.push(curr);
      }
    }

    if (deduplicated.length < 3) return deduplicated;

    // Step 2: Prune acute overshoot spikes / backtrack loops
    const pruned = [deduplicated[0]];
    for (let i = 1; i < deduplicated.length - 1; i++) {
      const pPrev = pruned[pruned.length - 1];
      const pCurr = deduplicated[i];
      const pNext = deduplicated[i + 1];

      const bIn = CampusRouter.calculateBearing(pPrev, pCurr);
      const bOut = CampusRouter.calculateBearing(pCurr, pNext);
      let angleDiff = Math.abs(bOut - bIn);
      if (angleDiff > 180) angleDiff = 360 - angleDiff;

      const segLen1 = CampusRouter.haversineDistance(pPrev, pCurr);
      const segLen2 = CampusRouter.haversineDistance(pCurr, pNext);
      const chordLen = CampusRouter.haversineDistance(pPrev, pNext);

      // If it forms a sharp spike reversing on itself within a short distance
      if (angleDiff > 140 && (segLen1 < 25 || segLen2 < 25) && chordLen < Math.max(segLen1, segLen2)) {
        // Skip current spike apex point
        continue;
      }

      pruned.push(pCurr);
    }
    pruned.push(deduplicated[deduplicated.length - 1]);

    // Step 3: Ensure true origin and destination are anchored
    if (origin && CampusRouter.haversineDistance(pruned[0], origin) > 1.5 && CampusRouter.haversineDistance(pruned[0], origin) < 60) {
      pruned.unshift([Number(origin[0]), Number(origin[1])]);
    }
    if (destination && CampusRouter.haversineDistance(pruned[pruned.length - 1], destination) > 1.5 && CampusRouter.haversineDistance(pruned[pruned.length - 1], destination) < 60) {
      pruned.push([Number(destination[0]), Number(destination[1])]);
    }

    return pruned;
  }

  /**
   * Multi-Stop (Waypoints) Sequential Road Routing:
   * Visited stops in designated order, stitching road connections cleanly.
   */
  async calculateMultiStopRoute(stops, options = {}) {
    if (!stops || stops.length < 2) {
      throw new Error('At least 2 stops are required for multi-stop routing.');
    }

    const allCoordinates = [];
    const allSteps = [];
    let totalDistance = 0;
    let totalDuration = 0;

    for (let i = 0; i < stops.length - 1; i++) {
      const startStop = stops[i];
      const nextStop = stops[i + 1];

      const startLoc = {
        latitude: startStop.latitude ?? startStop.lat,
        longitude: startStop.longitude ?? startStop.lon,
        name: startStop.name || `Stop #${i + 1}`
      };
      const destLoc = {
        latitude: nextStop.latitude ?? nextStop.lat,
        longitude: nextStop.longitude ?? nextStop.lon,
        name: nextStop.name || `Stop #${i + 2}`,
        entrance: nextStop.entrance
      };

      const legResult = await this.calculateRoute(startLoc, destLoc, {
        ...options,
        isIntermediateLeg: true
      });

      if (!legResult || !legResult.coordinates || legResult.coordinates.length < 2) {
        throw new Error(`Unable to calculate route between ${startLoc.name} and ${destLoc.name}.`);
      }

      totalDistance += legResult.distanceMeters;
      totalDuration += legResult.durationMinutes;

      // Stitch coordinates without duplicating leg junction point
      if (allCoordinates.length === 0) {
        allCoordinates.push(...legResult.coordinates);
      } else {
        allCoordinates.push(...legResult.coordinates.slice(1));
      }

      // Add stop milestone instruction
      allSteps.push({
        instruction: `Arrive at ${destLoc.name}`,
        distanceMeters: legResult.distanceMeters,
        type: 'arrive',
        location: legResult.coordinates[legResult.coordinates.length - 1]
      });
    }

    return {
      success: true,
      provider: 'REC Multi-Stop Road Transit Engine',
      distanceMeters: totalDistance,
      durationMinutes: totalDuration,
      coordinates: allCoordinates,
      steps: allSteps,
      origin: stops[0],
      destination: stops[stops.length - 1],
      stopsCount: stops.length
    };
  }

  /**
   * Master Route Calculator:
   * Generates the shortest practical, road-following route from origin to destination.
   * 
   * Strategy:
   * 1. Resolves sensible road endpoints (bypassing dead-end slot traps).
   * 2. Automatically selects profile ('driving' for buses/transit, 'auto' / 'foot' for pedestrians).
   * 3. Tries real-time OSRM with alternative evaluation & quality scoring.
   * 4. Fails over smoothly to verified REC Campus Road Graph (A* pathfinding with turn penalties).
   * 5. Validates geometry, prunes spikes, and ensures strictly road-following navigation.
   */
  async calculateRoute(userLocation, destination, options = {}) {
    if (!userLocation || !destination) {
      throw new Error('Both user origin and destination are required.');
    }

    // If multi-stop waypoints are provided in options
    if (options.waypoints && Array.isArray(options.waypoints) && options.waypoints.length > 0) {
      const allStops = [userLocation, ...options.waypoints, destination];
      return this.calculateMultiStopRoute(allStops, options);
    }

    // Resolve starting coordinates
    const originLat = userLocation.latitude ?? userLocation.lastLatitude ?? userLocation.lat;
    const originLon = userLocation.longitude ?? userLocation.lastLongitude ?? userLocation.lon;
    if (originLat == null || originLon == null) {
      throw new Error('Origin coordinates are missing or invalid.');
    }
    const originPoint = [Number(originLat), Number(originLon)];

    // Resolve sensible road connection points
    const resolvedOrigin = this.resolveEndpointCoordinates(userLocation, true);
    const resolvedDest = this.resolveEndpointCoordinates(destination, false);

    if (!resolvedDest) {
      throw new Error('Destination coordinates are missing or invalid.');
    }

    const startRoadCoords = resolvedOrigin?.roadCoords || originPoint;
    const destRoadCoords = resolvedDest.roadCoords;

    // Determine appropriate routing profile
    const isBusOrVehicle = Boolean(
      destination.isBus ||
      destination.category === 'Buses' ||
      destination.category === 'Transport' ||
      userLocation.isBus ||
      options.busAccessible ||
      options.profile === 'driving'
    );

    const routingOptions = {
      profile: isBusOrVehicle ? 'driving' : (options.profile || 'auto'),
      busAccessible: isBusOrVehicle,
      destinationName: destination.name || 'Destination'
    };

    // Use verified entrance coordinates for buildings, avoiding artificial straight-line cuts to centroids
    const targetCoord = (resolvedDest.isEntrance && resolvedDest.roadCoords) ? resolvedDest.roadCoords : resolvedDest.actualCoords;

    // Attempt 1: Real-time Road Routing API (OSRM) with direct road snapping
    let osrmResult = null;
    try {
      osrmResult = await this.fetchOSRMRoute(startRoadCoords, destRoadCoords, routingOptions);
    } catch (e) {
      osrmResult = null;
    }

    if (osrmResult && osrmResult.coordinates && osrmResult.coordinates.length >= 2) {
      // Connect true GPS start if origin is slightly off the road
      const finalCoords = CampusRouter.validateAndCleanPolyline(
        [originPoint, ...osrmResult.coordinates, targetCoord],
        originPoint,
        targetCoord
      );

      return {
        ...osrmResult,
        coordinates: finalCoords,
        origin: userLocation,
        destination: destination
      };
    }

    // Attempt 2: Verified REC In-Campus Road Graph (A* with Turn Cost Penalties)
    const aStarResult = this.calculateGraphAStarPath(originPoint, destRoadCoords, {
      ...routingOptions,
      destinationName: destination.name
    });

    if (aStarResult && aStarResult.coordinates && aStarResult.coordinates.length >= 2) {
      const finalCoords = CampusRouter.validateAndCleanPolyline(
        [originPoint, ...aStarResult.coordinates, targetCoord],
        originPoint,
        targetCoord
      );

      return {
        ...aStarResult,
        coordinates: finalCoords,
        origin: userLocation,
        destination: destination
      };
    }

    throw new Error('No practical, connected road path found to this location.');
  }

  /**
   * Synthesizes readable turn directions from road coordinates
   */
  synthesizeStepsFromCoordinates(coordinates, destinationName) {
    if (!coordinates || coordinates.length < 2) return [];

    const steps = [];
    let currentBearing = CampusRouter.calculateBearing(coordinates[0], coordinates[1]);

    steps.push({
      instruction: `Proceed along campus roadway towards ${destinationName}`,
      distanceMeters: Math.round(CampusRouter.haversineDistance(coordinates[0], coordinates[1])),
      type: 'depart',
      location: coordinates[0]
    });

    let accumulatedDist = 0;

    for (let i = 1; i < coordinates.length - 1; i++) {
      const segDist = CampusRouter.haversineDistance(coordinates[i], coordinates[i + 1]);
      const nextBearing = CampusRouter.calculateBearing(coordinates[i], coordinates[i + 1]);
      const turn = CampusRouter.getTurnManeuver(currentBearing, nextBearing);

      if (turn.type !== 'straight' && segDist > 8) {
        steps.push({
          instruction: `${turn.text} along campus avenue`,
          distanceMeters: Math.round(segDist),
          type: turn.type,
          location: coordinates[i]
        });
        currentBearing = nextBearing;
        accumulatedDist = 0;
      } else {
        accumulatedDist += segDist;
      }
    }

    steps.push({
      instruction: `Arrive at ${destinationName}`,
      distanceMeters: Math.round(accumulatedDist),
      type: 'arrive',
      location: coordinates[coordinates.length - 1]
    });

    return steps;
  }

  /**
   * Off-route deviation detection:
   * Checks whether user has moved further than thresholdMeters away from ANY segment of the active polyline.
   */
  static checkOffRoute(userPoint, routeCoordinates, thresholdMeters = 25) {
    if (!routeCoordinates || routeCoordinates.length < 2) {
      return { isOffRoute: false, minDistance: 0 };
    }

    let minDistance = Infinity;

    for (let i = 0; i < routeCoordinates.length - 1; i++) {
      const v = routeCoordinates[i];
      const w = routeCoordinates[i + 1];
      const dist = CampusRouter.distanceToSegment(userPoint, v, w);
      if (dist < minDistance) {
        minDistance = dist;
      }
    }

    return {
      isOffRoute: minDistance > thresholdMeters,
      minDistance: Math.round(minDistance)
    };
  }

  /**
   * Arrival detection:
   * Checks whether user is within arrivalThresholdMeters of destination
   */
  static checkArrival(userPoint, destinationCoords, arrivalThresholdMeters = 18) {
    const dist = CampusRouter.haversineDistance(userPoint, destinationCoords);
    return {
      arrived: dist <= arrivalThresholdMeters,
      distanceToDestination: Math.round(dist)
    };
  }
}
