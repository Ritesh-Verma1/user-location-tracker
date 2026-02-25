let watchId = null;

// ===============================
// MAP INITIALIZATION
// ===============================

let map = null;
let userMarker = null;
let accuracyCircle = null;

document.addEventListener("DOMContentLoaded", function () {

    if (document.getElementById("map")) {

        map = L.map('map').setView([20.5937, 78.9629], 5);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap'
        }).addTo(map);

    }

});


// ===============================
// START TRACKING
// ===============================
function getLocation() {

    if (!navigator.geolocation) {
        updateStatus("Geolocation is not supported by your browser.");
        return;
    }

    if (!confirm("Do you allow this app to access your location?")) {
        updateStatus("Permission denied by user.");
        return;
    }

    updateStatus("Starting high accuracy tracking...");

    const options = {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
    };

    watchId = navigator.geolocation.watchPosition(
        sendLocation,
        showError,
        options
    );
}


// ===============================
// SEND LOCATION TO BACKEND
// ===============================
function sendLocation(position) {

    const latitude = position.coords.latitude;
    const longitude = position.coords.longitude;
    const accuracy = position.coords.accuracy;

        // ===============================
        // UPDATE MAP MARKER
        // ===============================
        if (map) {

        map.setView([latitude, longitude], 16);

        if (!userMarker) {
            userMarker = L.marker([latitude, longitude]).addTo(map);
        } else {
            userMarker.setLatLng([latitude, longitude]);
        }

        // Accuracy radius circle
        if (accuracyCircle) {
            map.removeLayer(accuracyCircle);
        }

        accuracyCircle = L.circle([latitude, longitude], {
            radius: accuracy,
            color: 'blue',
            fillColor: '#3b82f6',
            fillOpacity: 0.2
        }).addTo(map);
    }

    // Reject low accuracy (>100m)
    if (accuracy > 100) {
        updateStatus("Low accuracy (" + Math.round(accuracy) + "m). Waiting for better signal...");
        return;
    }

    fetch("/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            latitude: latitude,
            longitude: longitude,
            accuracy: accuracy
        })
    })
    .then(response => response.json())
    .then(data => {
        updateStatus("Live tracking active ✔ Accuracy: " + Math.round(accuracy) + "m");
    })
    .catch(error => {
        updateStatus("Error sending location.");
        console.error(error);
    });
}


// ===============================
// STOP TRACKING
// ===============================
function stopTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
        updateStatus("Tracking stopped.");
    }
}


// ===============================
// ERROR HANDLER
// ===============================
function showError(error) {

    let message = "Unable to retrieve location.";

    if (error) {
        switch (error.code) {
            case error.PERMISSION_DENIED:
                message = "User denied location access.";
                break;
            case error.POSITION_UNAVAILABLE:
                message = "Location unavailable.";
                break;
            case error.TIMEOUT:
                message = "Location request timed out.";
                break;
        }
    }

    updateStatus(message);
}


// ===============================
// STATUS HELPER
// ===============================
function updateStatus(message) {
    const statusElement = document.getElementById("status");
    if (statusElement) {
        statusElement.innerText = message;
    }
}

navigator.geolocation.getCurrentPosition(function(pos) {
    console.log("Latitude:", pos.coords.latitude);
    console.log("Longitude:", pos.coords.longitude);
});
