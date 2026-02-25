/* ================================
   Track Sphere Dashboard Logic
   - User tracking + Admin live view
   - Sidebar + Details panel + Speed estimate
   ================================ */

let map;
let userMarker = null;
let accuracyCircle = null;

let lastCoords = null;
let lastAccuracy = null;

let trackingEnabled = true;
let followEnabled = true;

let watchId = null;       // geolocation watcher id
let shareEnabled = true;  // consent toggle

// Admin state
let adminMarkers = {};         // username -> marker
let adminCircles = {};         // username -> circle
let adminTrails = {};          // username -> polyline
let adminTrailPoints = {};     // username -> [[lat,lng], ...]
let adminLastSeen = {};        // username -> ms
let adminLastPoint = {};       // username -> {lat,lng,t}
let adminSpeedKmh = {};        // username -> number
let adminLastData = {};        // username -> latest data snapshot

let trailsEnabled = true;
let focusedUser = null;

function $(id){ return document.getElementById(id); }

function fmtTime(d){
  const pad = (n)=> String(n).padStart(2,'0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtAgo(seconds){
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds/60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60);
  return `${h}h ago`;
}

function setStatus(text, color){
  const el = $("statStatus");
  if(!el) return;
  el.textContent = text;
  el.style.color = color;
}
function setAccuracy(m){
  const el = $("statAccuracy");
  if(!el) return;
  el.textContent = (m ? `${Math.round(m)} m` : "—");
}
function setUpdated(t){
  const el = $("statUpdated");
  if(!el) return;
  el.textContent = t || "—";
}

function colorFromName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 85%, 60%)`;
}

function makeUserIcon(username) {
  const color = colorFromName(username);
  return L.divIcon({
    className: "user-div-icon",
    html: `
      <div style="
        width:14px;height:14px;border-radius:50%;
        background:${color};
        box-shadow:0 0 18px ${color};
        border:2px solid rgba(255,255,255,0.85);
      "></div>
    `,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
}

function haversineMeters(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const toRad = (x)=> x * Math.PI / 180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a =
    Math.sin(dLat/2)*Math.sin(dLat/2) +
    Math.cos(toRad(lat1))*Math.cos(toRad(lat2)) *
    Math.sin(dLon/2)*Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}

function initMap(){
  map = L.map("map", { zoomControl: true }).setView([20.5937, 78.9629], 5);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19
  }).addTo(map);
}

/* ======================
   Shared UI actions
   ====================== */

window.recenter = function(){
  if(role === "admin"){
    if(focusedUser && adminMarkers[focusedUser]) {
      map.setView(adminMarkers[focusedUser].getLatLng(), Math.max(map.getZoom(), 16));
      return;
    }
    window.fitAllUsers?.();
    return;
  }

  if(userMarker){
    map.setView(userMarker.getLatLng(), Math.max(map.getZoom(), 16));
  }
};

window.toggleFollow = function(){
  followEnabled = !followEnabled;
  const btn = $("followBtn");
  if(btn) btn.textContent = followEnabled ? "🧲 Follow: ON" : "🧲 Follow: OFF";
  setStatus(followEnabled ? "Live" : "Free roam", followEnabled ? "var(--good)" : "var(--warn)");
};

window.toggleTracking = function(){
  trackingEnabled = !trackingEnabled;
  const pill = $("trackingPill");
  const btn = $("trackBtn");

  if(trackingEnabled){
    if(pill) pill.innerHTML = `<span class="dot"></span> Tracking enabled`;
    if(btn) btn.textContent = "⏸ Pause tracking";
    setStatus("Live", "var(--good)");
  }else{
    if(pill) pill.innerHTML = `<span class="dot" style="background: var(--warn); box-shadow: 0 0 14px rgba(251,191,36,0.45);"></span> Tracking paused`;
    if(btn) btn.textContent = "▶ Resume tracking";
    setStatus("Paused", "var(--warn)");
  }
};

window.copyCoords = async function(){
  if(!lastCoords){
    alert("No coordinates yet. Allow location permission first.");
    return;
  }
  const txt = `${lastCoords.lat.toFixed(6)}, ${lastCoords.lng.toFixed(6)} (±${Math.round(lastAccuracy || 0)}m)`;
  try{
    await navigator.clipboard.writeText(txt);
    const toast = $("toast");
    if(toast){
      toast.innerHTML = `<span class="tag">Copied</span> <span><b>${txt}</b></span>`;
      setTimeout(()=>{
        toast.innerHTML = `<span class="tag">Tip</span><span>Admin view: click a user to <b>focus</b>. Details + speed update live.</span>`;
      }, 2200);
    }
  }catch(e){
    alert("Clipboard blocked. Copy manually: " + txt);
  }
};

window.toggleShare = function(){
  shareEnabled = !shareEnabled;

  const btn = document.getElementById("shareBtn");
  const pill = document.getElementById("trackingPill");

  if(shareEnabled){
    if(btn) btn.textContent = "🟢 Share location: ON";
    if(pill) pill.innerHTML = `<span class="dot"></span> Tracking enabled`;
    setStatus("Live", "var(--good)");

    // restart GPS tracking
    startUserTracking();
  } else {
    if(btn) btn.textContent = "⚪ Share location: OFF";
    if(pill) pill.innerHTML =
      `<span class="dot" style="background: var(--warn); box-shadow: 0 0 14px rgba(251,191,36,0.45);"></span> Not sharing location`;

    setStatus("Not sharing", "var(--warn)");

    // stop GPS watch
    if(watchId !== null){
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }
};

window.stopSharing = function(){
  // hard stop (kills tracking + clears marker UI)
  shareEnabled = false;

  const shareBtn = document.getElementById("shareBtn");
  const pill = document.getElementById("trackingPill");

  if(shareBtn) shareBtn.textContent = "⚪ Share location: OFF";
  if(pill) pill.innerHTML =
    `<span class="dot" style="background: var(--danger); box-shadow: 0 0 14px rgba(255,107,107,0.50);"></span> Sharing stopped`;

  setStatus("Stopped", "var(--danger)");
  setAccuracy(null);
  setUpdated("—");

  // stop GPS watch
  if(watchId !== null){
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  // remove marker/circle from map so it's obvious it stopped
  try{
    if(userMarker){ map.removeLayer(userMarker); userMarker = null; }
    if(accuracyCircle){ map.removeLayer(accuracyCircle); accuracyCircle = null; }
  }catch(e){}

  lastCoords = null;
  lastAccuracy = null;
};

/* ======================
   USER MODE (GPS -> POST)
   ====================== */

function startUserTracking(){
  if(!navigator.geolocation){
    setStatus("Geolocation not supported", "var(--danger)");
    return;
  }

  // if user has turned off sharing, don't start GPS
  if(!shareEnabled){
    setStatus("Not sharing", "var(--warn)");
    return;
  }

  // If already watching, don't start again
  if(watchId !== null) return;

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      // If user turned off sharing after watch started, ignore updates
      if(!shareEnabled) return;

      // Your existing pause tracking still works
      if(!trackingEnabled) return;

      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = pos.coords.accuracy;

      lastCoords = { lat, lng };
      lastAccuracy = accuracy;

      if(!userMarker){
        userMarker = L.marker([lat, lng]).addTo(map);
      } else {
        userMarker.setLatLng([lat, lng]);
      }

      if(!accuracyCircle){
        accuracyCircle = L.circle([lat, lng], {
          radius: accuracy,
          color: "#60a5fa",
          fillColor: "#3b82f6",
          fillOpacity: 0.18,
          weight: 2
        }).addTo(map);
      } else {
        accuracyCircle.setLatLng([lat, lng]);
        accuracyCircle.setRadius(accuracy);
      }

      if(followEnabled){
        map.setView([lat, lng], Math.max(map.getZoom(), 16));
      }

      setAccuracy(accuracy);
      setUpdated(fmtTime(new Date()));

      fetch("/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude: lat, longitude: lng, accuracy })
      }).catch(()=>{});
    },
    (err) => {
      console.log("Location error:", err);
      setStatus("GPS error / denied", "var(--danger)");
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
}

/* ======================
   ADMIN MODE (Live users)
   ====================== */

function calcSpeed(username, lat, lng, tNow){
  const prev = adminLastPoint[username];
  if(!prev) {
    adminLastPoint[username] = { lat, lng, t: tNow };
    adminSpeedKmh[username] = 0;
    return 0;
  }
  const dt = (tNow - prev.t) / 1000;
  if(dt <= 0.8) return adminSpeedKmh[username] || 0; // ignore too-fast samples

  const dist = haversineMeters(prev.lat, prev.lng, lat, lng);
  const mps = dist / dt;
  const kmh = mps * 3.6;

  // smooth it a bit to avoid crazy spikes
  const old = adminSpeedKmh[username] || 0;
  const smooth = old * 0.7 + kmh * 0.3;

  adminLastPoint[username] = { lat, lng, t: tNow };
  adminSpeedKmh[username] = smooth;

  return smooth;
}

function upsertAdminUser(data){
  const username = data.username;
  const lat = data.latitude;
  const lng = data.longitude;
  const acc = data.accuracy;
  const timeLabel = data.time || fmtTime(new Date());

  if(!username || lat == null || lng == null) return;

  const now = Date.now();
  adminLastSeen[username] = now;
  adminLastData[username] = { username, latitude: lat, longitude: lng, accuracy: acc, time: timeLabel };

  lastCoords = { lat, lng };
  lastAccuracy = acc;

  const speed = calcSpeed(username, lat, lng, now);

  // marker
  if(!adminMarkers[username]){
    adminMarkers[username] = L.marker([lat, lng], { icon: makeUserIcon(username) })
      .addTo(map)
      .bindPopup(`<b>User:</b> ${username}<br><b>Accuracy:</b> ${acc ? Math.round(acc) + "m" : "—"}<br><b>Speed:</b> ${speed.toFixed(1)} km/h<br><b>Last:</b> ${timeLabel}`);

    // accuracy circle
    adminCircles[username] = L.circle([lat, lng], {
      radius: acc || 0,
      color: colorFromName(username),
      fillColor: colorFromName(username),
      fillOpacity: 0.10,
      weight: 2
    }).addTo(map);

    // trail
    adminTrailPoints[username] = [];
    adminTrails[username] = L.polyline([], { weight: 3, opacity: 0.65 }).addTo(map);
  } else {
    adminMarkers[username].setLatLng([lat, lng]);
    if(adminMarkers[username].getPopup()){
      adminMarkers[username].setPopupContent(
        `<b>User:</b> ${username}<br><b>Accuracy:</b> ${acc ? Math.round(acc) + "m" : "—"}<br><b>Speed:</b> ${speed.toFixed(1)} km/h<br><b>Last:</b> ${timeLabel}`
      );
    }

    if(adminCircles[username]){
      adminCircles[username].setLatLng([lat, lng]);
      if(acc) adminCircles[username].setRadius(acc);
    }
  }

  // trails
  if(trailsEnabled){
    const pts = adminTrailPoints[username] || [];
    pts.push([lat, lng]);
    if(pts.length > 80) pts.shift();
    adminTrailPoints[username] = pts;
    if(adminTrails[username]) adminTrails[username].setLatLngs(pts);
  }

  // Follow focused user
  if(followEnabled && focusedUser === username){
    map.setView([lat, lng], Math.max(map.getZoom(), 16));
    updateDetailsPanel(username);
  }

  renderUserList();
  updateAdminCount();
}

function updateAdminCount(){
  const el = $("adminLiveCount");
  if(el) el.textContent = Object.keys(adminMarkers).length;
}

function cleanupStaleUsers(){
  const now = Date.now();
  const staleMs = 60_000;

  for(const username of Object.keys(adminMarkers)){
    const last = adminLastSeen[username] || 0;
    if(now - last > staleMs){
      map.removeLayer(adminMarkers[username]);
      delete adminMarkers[username];

      if(adminCircles[username]) map.removeLayer(adminCircles[username]);
      delete adminCircles[username];

      if(adminTrails[username]) map.removeLayer(adminTrails[username]);
      delete adminTrails[username];

      delete adminTrailPoints[username];
      delete adminLastSeen[username];
      delete adminLastPoint[username];
      delete adminSpeedKmh[username];
      delete adminLastData[username];

      if(focusedUser === username) focusedUser = null;
    }
  }

  renderUserList();
  updateAdminCount();

  // If focused user vanished, clear panel
  if(focusedUser && !adminMarkers[focusedUser]) {
    focusedUser = null;
    updateDetailsPanel(null);
  }
}

function fetchInitialLiveUsers(){
  fetch("/api/live_users")
    .then(res => res.json())
    .then(rows => {
      if(!Array.isArray(rows)) {
        console.warn("live_users response:", rows);
        return;
      }
      rows.forEach(r => upsertAdminUser(r));
    })
    .catch(err => console.error("Error loading live users:", err));
}

window.fitAllUsers = function(){
  const markers = Object.values(adminMarkers);
  if(markers.length === 0) return;
  const group = L.featureGroup(markers);
  map.fitBounds(group.getBounds().pad(0.25));
};

window.toggleTrails = function(){
  trailsEnabled = !trailsEnabled;
  const btn = $("trailBtn");
  if(btn) btn.textContent = trailsEnabled ? "🧵 Trails: ON" : "🧵 Trails: OFF";

  if(!trailsEnabled){
    Object.values(adminTrails).forEach(pl => pl.setLatLngs([]));
  } else {
    for(const u of Object.keys(adminTrails)){
      adminTrails[u].setLatLngs(adminTrailPoints[u] || []);
    }
  }
};

window.clearTrails = function(){
  for(const u of Object.keys(adminTrailPoints)){
    adminTrailPoints[u] = [];
    if(adminTrails[u]) adminTrails[u].setLatLngs([]);
  }
};

window.focusUser = function(username){
  focusedUser = username;
  if(adminMarkers[username]){
    map.setView(adminMarkers[username].getLatLng(), Math.max(map.getZoom(), 16));
    adminMarkers[username].openPopup();
  }
  updateDetailsPanel(username);
  renderUserList();
};

window.unfocus = function(){
  focusedUser = null;
  updateDetailsPanel(null);
  renderUserList();
};

function updateDetailsPanel(username){
  // details elements exist only in admin map.html
  const dUser = $("d_user");
  if(!dUser) return;

  if(!username){
    dUser.textContent = "No user focused";
    $("d_lat").textContent = "—";
    $("d_lng").textContent = "—";
    $("d_acc").textContent = "—";
    $("d_seen").textContent = "—";
    $("d_speed").textContent = "—";
    $("d_note").textContent = "Focus updates live";
    return;
  }

  const data = adminLastData[username];
  const last = adminLastSeen[username];
  const speed = adminSpeedKmh[username] || 0;

  dUser.textContent = `${username} • focused`;
  $("d_lat").textContent = data ? Number(data.latitude).toFixed(6) : "—";
  $("d_lng").textContent = data ? Number(data.longitude).toFixed(6) : "—";
  $("d_acc").textContent = data && data.accuracy ? `${Math.round(data.accuracy)} m` : "—";

  if(last){
    const secs = Math.max(0, Math.round((Date.now() - last) / 1000));
    $("d_seen").textContent = fmtAgo(secs);
  } else {
    $("d_seen").textContent = "—";
  }

  $("d_speed").textContent = `${speed.toFixed(1)} km/h`;
  $("d_note").textContent = speed > 80 ? "Speed seems high (GPS noise?)" : "OK";
}

window.copyFocusedDetails = async function(){
  if(!focusedUser){
    alert("Focus a user first.");
    return;
  }
  const data = adminLastData[focusedUser];
  const speed = adminSpeedKmh[focusedUser] || 0;
  const seen = adminLastSeen[focusedUser]
    ? fmtAgo(Math.max(0, Math.round((Date.now() - adminLastSeen[focusedUser]) / 1000)))
    : "—";

  const txt =
    `User: ${focusedUser}\n` +
    `Lat: ${data ? Number(data.latitude).toFixed(6) : "—"}\n` +
    `Lng: ${data ? Number(data.longitude).toFixed(6) : "—"}\n` +
    `Accuracy: ${data && data.accuracy ? Math.round(data.accuracy) + " m" : "—"}\n` +
    `Last seen: ${seen}\n` +
    `Speed: ${speed.toFixed(1)} km/h`;

  try{
    await navigator.clipboard.writeText(txt);
    const toast = $("toast");
    if(toast) toast.innerHTML = `<span class="tag">Copied</span><span><b>${focusedUser}</b> details copied.</span>`;
    setTimeout(()=>{
      const toast2 = $("toast");
      if(toast2) toast2.innerHTML = `<span class="tag">Tip</span><span>Admin view: click a user to <b>focus</b>. Details + speed update live.</span>`;
    }, 2200);
  }catch(e){
    alert("Clipboard blocked. Copy manually:\n\n" + txt);
  }
};

// Sidebar rendering
window.renderUserList = function(){
  const list = $("userList");
  if(!list) return;

  const q = ($("userSearch")?.value || "").toLowerCase().trim();
  const users = Object.keys(adminMarkers).sort((a,b)=> a.localeCompare(b));
  const filtered = q ? users.filter(u => u.toLowerCase().includes(q)) : users;

  list.innerHTML = "";

  for(const u of filtered){
    const color = colorFromName(u);
    const last = adminLastSeen[u] ? Math.round((Date.now() - adminLastSeen[u]) / 1000) : null;
    const acc = adminLastData[u]?.accuracy;

    const div = document.createElement("div");
    div.className = "usercard";

    const left = document.createElement("div");
    left.className = "u-left";

    const dot = document.createElement("div");
    dot.className = "u-dot";
    dot.style.background = color;
    dot.style.boxShadow = `0 0 18px ${color}`;

    const meta = document.createElement("div");
    meta.className = "u-meta";

    const name = document.createElement("div");
    name.className = "u-name";
    name.textContent = u + (focusedUser === u ? "  • focused" : "");

    const sub = document.createElement("div");
    sub.className = "u-sub";
    const seenTxt = last != null ? fmtAgo(last) : "—";
    const accTxt = acc ? `±${Math.round(acc)}m` : "—";
    sub.textContent = `last: ${seenTxt} • acc: ${accTxt}`;

    meta.appendChild(name);
    meta.appendChild(sub);

    left.appendChild(dot);
    left.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "u-actions";

    const focus = document.createElement("div");
    focus.className = "chip";
    focus.textContent = "Focus";
    focus.onclick = () => window.focusUser(u);

    actions.appendChild(focus);

    div.appendChild(left);
    div.appendChild(actions);

    list.appendChild(div);
  }

  // Keep details panel fresh (last seen ticking)
  if(focusedUser) updateDetailsPanel(focusedUser);
};

function startAdminLive(){
  setStatus("Admin", "var(--brand)");
  const pill = $("trackingPill");
  if(pill){
    pill.innerHTML = `<span class="dot" style="background: var(--brand); box-shadow: 0 0 14px rgba(96,165,250,0.55);"></span> Admin live monitoring`;
  }

  fetchInitialLiveUsers();
  window.fitAllUsers?.();

  // Socket live updates
  const socket = io();
  socket.on("connect", () => console.log("socket connected"));
  socket.on("location_update", (data) => upsertAdminUser(data));

  // cleanup stale markers every 15s
  setInterval(cleanupStaleUsers, 15000);

  // fallback polling every 12s
  setInterval(fetchInitialLiveUsers, 12000);

  // tick last-seen and details every 2s
  setInterval(() => {
    renderUserList();
  }, 2000);
}

/* ======================
   Bootstrap
   ====================== */
window.addEventListener("load", () => {
  initMap();
  setStatus("Live", "var(--good)");

  if(role === "admin"){
    startAdminLive();
  } else {
    startUserTracking();
  }
});
