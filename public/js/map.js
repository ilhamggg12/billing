// ==========================================================================
// FTTH NETWORK INFRASTRUCTURE & CUSTOMER MAP (ISP MANAGER)
// Features: Pure Google Satellite default, ODP, ODC, OLT, Switch, ONT,
// Interactive Cable Drawing (with Undo & Snap), House Pinning & Draggable fine-tuning
// ==========================================================================

let map = null;
let googleSatellite = null;
let googleHybrid = null;
let googleStreets = null;
let osm = null;

// Layer Groups
let oltGroup = null;
let odcGroup = null;
let odpGroup = null;
let switchGroup = null;
let ontGroup = null;
let cablesGroup = null;
let radiusGroup = null;
let drawingPointsGroup = null;

// Drawing & Pinning States
let drawingCableMode = false;
let cablePoints = [];
let drawingPolyline = null;
let pickingLocationForNode = false;
let pinningCustomerTarget = null;
let activeDraggableMarker = null;

// Cached data
let currentNetworkData = { nodes: [], cables: [], customers: [] };

// Helper to safely show & hide Bootstrap 5 modals without freezing backdrops
function safeShowModal(modalId) {
    const el = document.getElementById(modalId);
    if (!el) return;
    try {
        const modal = bootstrap.Modal.getOrCreateInstance ? bootstrap.Modal.getOrCreateInstance(el) : new bootstrap.Modal(el);
        modal.show();
    } catch (e) {
        console.error('Error safeShowModal:', e);
    }
}

function safeHideModal(modalId) {
    const el = document.getElementById(modalId);
    if (!el) return;
    try {
        const modal = bootstrap.Modal.getOrCreateInstance ? bootstrap.Modal.getOrCreateInstance(el) : bootstrap.Modal.getInstance(el);
        if (modal) modal.hide();
    } catch (e) {}
    
    const dismissBtn = el.querySelector('[data-bs-dismiss="modal"]');
    if (dismissBtn) dismissBtn.click();

    setTimeout(() => {
        document.querySelectorAll('.modal-backdrop').forEach(b => b.remove());
        document.body.classList.remove('modal-open');
        document.body.style.removeProperty('padding-right');
        document.body.style.removeProperty('overflow');
    }, 250);
}

// ==========================================================================
// INITIALIZATION
// ==========================================================================
document.addEventListener('DOMContentLoaded', function() {
    const mapElement = document.getElementById('customerMap');
    if (!mapElement) return;

    const defaultLat = parseFloat(mapElement.getAttribute('data-lat')) || -7.020892;
    const defaultLng = parseFloat(mapElement.getAttribute('data-lng')) || 107.72796;
    const defaultZoom = parseInt(mapElement.getAttribute('data-zoom'), 10) || 15;

    // 1. Inisialisasi Peta Leaflet
    map = L.map('customerMap', {
        center: [defaultLat, defaultLng],
        zoom: defaultZoom,
        zoomControl: true
    });

    // 2. Base Tile Layers (Google Satelit Murni sebagai DEFAULT UTAMA)
    googleSatellite = L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
        maxZoom: 22,
        maxNativeZoom: 20,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
        attribution: '&copy; Google Maps Satelit Murni'
    });

    googleHybrid = L.tileLayer('https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
        maxZoom: 22,
        maxNativeZoom: 20,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
        attribution: '&copy; Google Maps Satelit & Jalan'
    });

    googleStreets = L.tileLayer('https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
        maxZoom: 20,
        subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
        attribution: '&copy; Google Maps Peta Jalan'
    });

    osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    });

    // Default aktif: SATELIT MURNI GOOGLE MAPS
    googleSatellite.addTo(map);

    // Layer switcher control (pojok kanan atas)
    const baseLayers = {
        '🌍 Google Satelit Murni (Default)': googleSatellite,
        '🛰️ Google Satelit + Jalan (Hybrid)': googleHybrid,
        '🗺️ Google Peta Jalan': googleStreets,
        '🌐 OpenStreetMap': osm
    };
    L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);

    // Skala jarak (meter / km) pojok kiri bawah
    L.control.scale({ imperial: false, metric: true }).addTo(map);

    // 3. Layer Groups
    oltGroup = L.layerGroup().addTo(map);
    odcGroup = L.layerGroup().addTo(map);
    odpGroup = L.layerGroup().addTo(map);
    switchGroup = L.layerGroup().addTo(map);
    ontGroup = L.layerGroup().addTo(map);
    cablesGroup = L.layerGroup().addTo(map);
    radiusGroup = L.layerGroup(); // ODP 150m coverage radius
    drawingPointsGroup = L.layerGroup().addTo(map);

    // 4. Map Event Listeners
    map.on('click', handleMapClick);
    map.on('dblclick', handleMapDblClick);
    map.on('contextmenu', handleMapContextMenu); // Klik kanan menu pintas

    // 5. Muat Data Infrastruktur & Pelanggan
    loadNetworkData();

    // Setup listener modal pin pelanggan
    setupCustomerPinModal();
});

// ==========================================================================
// 1. MEMUAT DATA INFRASTRUKTUR (NODES, CABLES, CUSTOMERS)
// ==========================================================================
function loadNetworkData() {
    fetch('/api/network/data')
        .then(res => res.json())
        .then(data => {
            if (!data.success) {
                console.error('Gagal memuat data jaringan:', data.error);
                return;
            }

            currentNetworkData = data;

            // Bersihkan layer sebelumnya
            oltGroup.clearLayers();
            odcGroup.clearLayers();
            odpGroup.clearLayers();
            switchGroup.clearLayers();
            ontGroup.clearLayers();
            cablesGroup.clearLayers();
            radiusGroup.clearLayers();

            let cOlt = 0, cOdc = 0, cOdp = 0, cSwitch = 0, cOnt = 0, cCables = 0;
            const bounds = [];

            // A. Render Perangkat Jaringan (Nodes)
            (data.nodes || []).forEach(node => {
                if (!node.latitude || !node.longitude) return;
                const lat = parseFloat(node.latitude);
                const lng = parseFloat(node.longitude);
                bounds.push([lat, lng]);

                const marker = createNodeMarker(node);
                if (!marker) return;

                switch (node.type) {
                    case 'OLT':
                        oltGroup.addLayer(marker);
                        cOlt++;
                        break;
                    case 'ODC':
                        odcGroup.addLayer(marker);
                        cOdc++;
                        break;
                    case 'ODP':
                        odpGroup.addLayer(marker);
                        cOdp++;
                        // Radius coverage 150m
                        const radiusCircle = L.circle([lat, lng], {
                            radius: 150,
                            color: '#f59e0b',
                            weight: 1.5,
                            dashArray: '4, 6',
                            fillColor: '#f59e0b',
                            fillOpacity: 0.08
                        });
                        radiusGroup.addLayer(radiusCircle);
                        break;
                    case 'Switch':
                        switchGroup.addLayer(marker);
                        cSwitch++;
                        break;
                    case 'ONT':
                        ontGroup.addLayer(marker);
                        cOnt++;
                        break;
                }
            });

            // B. Render Pelanggan (Rumah / ONT) dari tabel customers
            const existingOntCustIds = new Set(
                (data.nodes || []).filter(n => n.type === 'ONT' && n.customer_id).map(n => n.customer_id)
            );

            (data.customers || []).forEach(cust => {
                if (!cust.latitude || !cust.longitude) return;
                if (existingOntCustIds.has(cust.id)) return;

                const lat = parseFloat(cust.latitude);
                const lng = parseFloat(cust.longitude);
                bounds.push([lat, lng]);

                const custMarker = createCustomerMarker(cust);
                ontGroup.addLayer(custMarker);
                cOnt++;
            });

            // C. Render Kabel Jaringan (Cables Polyline)
            (data.cables || []).forEach(cable => {
                let coords = [];
                try {
                    coords = typeof cable.coordinates === 'string' ? JSON.parse(cable.coordinates) : cable.coordinates;
                } catch (e) {
                    return;
                }
                if (!Array.isArray(coords) || coords.length < 2) return;

                coords.forEach(pt => bounds.push(pt));

                const polyline = createCablePolyline(cable, coords);
                cablesGroup.addLayer(polyline);
                cCables++;
            });

            // Update badge counters
            const elOLT = document.getElementById('countOLT'); if (elOLT) elOLT.textContent = cOlt;
            const elODC = document.getElementById('countODC'); if (elODC) elODC.textContent = cOdc;
            const elODP = document.getElementById('countODP'); if (elODP) elODP.textContent = cOdp;
            const elSwitch = document.getElementById('countSwitch'); if (elSwitch) elSwitch.textContent = cSwitch;
            const elONT = document.getElementById('countONT'); if (elONT) elONT.textContent = cOnt;
            const elCables = document.getElementById('countCables'); if (elCables) elCables.textContent = cCables;

            // Fit bounds jika ada titik dan baru pertama kali dibuka
            if (bounds.length > 0 && !window.hasFittedInitial) {
                map.fitBounds(bounds, { padding: [50, 50], maxZoom: 17 });
                window.hasFittedInitial = true;
            }
        })
        .catch(err => console.error('Error loadNetworkData:', err));
}

// ==========================================================================
// 2. CREATION OF MARKERS & POPUPS
// ==========================================================================
function createNodeMarker(node) {
    const lat = parseFloat(node.latitude);
    const lng = parseFloat(node.longitude);

    let iconHtml = '';
    let typeBadge = '';
    let badgeClass = '';

    switch (node.type) {
        case 'OLT':
            badgeClass = 'node-badge-olt';
            iconHtml = '<i class="fas fa-server"></i>';
            typeBadge = '<span class="badge bg-danger">OLT - NOC Pusat</span>';
            break;
        case 'ODC':
            badgeClass = 'node-badge-odc';
            iconHtml = '<i class="fas fa-cubes"></i>';
            typeBadge = '<span class="badge bg-primary">ODC - Feeder</span>';
            break;
        case 'ODP':
            badgeClass = 'node-badge-odp';
            iconHtml = '<i class="fas fa-box"></i>';
            typeBadge = '<span class="badge bg-warning text-dark">ODP - Distribusi</span>';
            break;
        case 'Switch':
            badgeClass = 'node-badge-switch';
            iconHtml = '<i class="fas fa-random"></i>';
            typeBadge = '<span class="badge bg-purple text-white" style="background:#8b5cf6;">Switch Hub</span>';
            break;
        case 'ONT':
            badgeClass = 'node-badge-ont';
            iconHtml = '<i class="fas fa-home"></i>';
            typeBadge = '<span class="badge bg-success">ONT Pelanggan</span>';
            break;
    }

    const customDivIcon = L.divIcon({
        className: 'node-marker-container',
        html: `<div class="node-badge ${badgeClass}">${iconHtml}</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -14]
    });

    const cap = node.capacity || 8;
    const used = node.used_capacity || 0;
    const pct = Math.min(Math.round((used / cap) * 100), 100);

    const marker = L.marker([lat, lng], { icon: customDivIcon });

    const popupHtml = `
        <div style="min-width: 230px; font-size: 0.88rem;">
            <div class="d-flex align-items-center justify-content-between mb-1">
                ${typeBadge}
                <small class="text-muted fw-bold">#${node.id}</small>
            </div>
            <h6 class="fw-bold mb-1 text-dark">${escapeHtml(node.name)}</h6>
            ${node.address ? `<div class="text-muted small mb-2"><i class="fas fa-map-marker-alt text-danger me-1"></i>${escapeHtml(node.address)}</div>` : ''}
            
            <div class="bg-light p-2 rounded-3 mb-2 border">
                <div class="d-flex justify-content-between small mb-1">
                    <span>Kapasitas Port:</span>
                    <strong>${used} / ${cap} Port</strong>
                </div>
                <div class="progress" style="height: 6px;">
                    <div class="progress-bar ${pct > 80 ? 'bg-danger' : (pct > 50 ? 'bg-warning' : 'bg-success')}" style="width: ${pct}%;"></div>
                </div>
            </div>

            ${node.notes ? `<div class="small text-muted mb-2 fst-italic">"${escapeHtml(node.notes)}"</div>` : ''}

            <div class="small text-muted mb-2" style="font-size: 0.75rem;">
                <i class="fas fa-crosshairs me-1"></i>${lat.toFixed(6)}, ${lng.toFixed(6)}
            </div>

            <div class="d-flex gap-1 pt-1 border-top flex-column">
                <div class="d-flex gap-1 mb-1">
                    <button class="btn btn-sm btn-outline-primary w-50 py-1" onclick="openEditNodeModal(${JSON.stringify(node).replace(/"/g, '&quot;')})">
                        <i class="fas fa-edit me-1"></i> Edit
                    </button>
                    <button class="btn btn-sm btn-outline-secondary w-50 py-1" onclick="enableMarkerDrag(${node.id}, 'node')">
                        <i class="fas fa-arrows-alt me-1"></i> Geser
                    </button>
                </div>
                <button class="btn btn-sm btn-outline-danger w-100 py-1" onclick="deleteNode(${node.id}, '${escapeHtml(node.name)}')">
                    <i class="fas fa-trash-alt me-1"></i> Hapus Perangkat
                </button>
            </div>
        </div>
    `;

    marker.bindPopup(popupHtml);

    // Klik Marker: Jika Mode Tarik Kabel Aktif, SNAP TITIK KE SINI (jangan buka popup)
    marker.on('click', function(e) {
        if (drawingCableMode) {
            L.DomEvent.stopPropagation(e);
            addCablePoint(lat, lng, node.name);
            marker.closePopup();
            return false;
        }
    });

    return marker;
}

function createCustomerMarker(cust) {
    const lat = parseFloat(cust.latitude);
    const lng = parseFloat(cust.longitude);

    let statusBg = '#10b981';
    let statusBadge = '<span class="badge bg-success">Aktif</span>';
    if (cust.status === 'suspended') {
        statusBg = '#f59e0b';
        statusBadge = '<span class="badge bg-warning text-dark">Suspend</span>';
    } else if (cust.status === 'terminated') {
        statusBg = '#ef4444';
        statusBadge = '<span class="badge bg-danger">Terminasi</span>';
    }

    const divIcon = L.divIcon({
        className: 'node-marker-container',
        html: `<div class="node-badge" style="background:${statusBg}; border-radius:50%; width:26px; height:26px;"><i class="fas fa-home" style="font-size:11px;"></i></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
        popupAnchor: [0, -12]
    });

    const marker = L.marker([lat, lng], { icon: divIcon });

    const popupHtml = `
        <div style="min-width: 230px; font-size: 0.88rem;">
            <div class="d-flex align-items-center justify-content-between mb-1">
                ${statusBadge}
                <small class="text-muted fw-bold">${cust.customer_id || '-'}</small>
            </div>
            <h6 class="fw-bold mb-1 text-dark">${escapeHtml(cust.name)}</h6>
            <div class="small mb-1"><strong>Paket:</strong> ${escapeHtml(cust.package_name || '-')}</div>
            <div class="small mb-1"><strong>Telepon:</strong> ${escapeHtml(cust.phone || '-')}</div>
            <div class="small mb-2 text-truncate" title="${escapeHtml(cust.address || '')}">
                <i class="fas fa-map-marker-alt text-danger me-1"></i>${escapeHtml(cust.address || '-')}
            </div>
            <div class="small text-muted mb-2" style="font-size: 0.75rem;">
                <i class="fas fa-crosshairs me-1"></i>${lat.toFixed(6)}, ${lng.toFixed(6)}
            </div>
            <div class="d-flex gap-1 pt-1 border-top flex-column">
                <div class="d-flex gap-1 mb-1">
                    <a href="/customers/${cust.id}/edit" class="btn btn-sm btn-primary w-50 py-1 text-white">
                        <i class="fas fa-user-edit me-1"></i> Detail
                    </a>
                    <button class="btn btn-sm btn-outline-secondary w-50 py-1" onclick="enableMarkerDrag(${cust.id}, 'customer')">
                        <i class="fas fa-arrows-alt me-1"></i> Geser
                    </button>
                </div>
                <button class="btn btn-sm btn-outline-danger w-100 py-1" onclick="unpinCustomer(${cust.id}, '${escapeHtml(cust.name)}')">
                    <i class="fas fa-map-pin me-1"></i> Hapus Pin Rumah
                </button>
            </div>
        </div>
    `;

    marker.bindPopup(popupHtml);

    // Klik Marker: Jika Mode Tarik Kabel Aktif, SNAP TITIK KE RUMAH PELANGGAN
    marker.on('click', function(e) {
        if (drawingCableMode) {
            L.DomEvent.stopPropagation(e);
            addCablePoint(lat, lng, cust.name);
            marker.closePopup();
            return false;
        }
    });

    return marker;
}

function createCablePolyline(cable, coords) {
    const color = cable.color || '#3b82f6';
    const polyline = L.polyline(coords, {
        color: color,
        weight: 5,
        opacity: 0.9,
        smoothFactor: 1
    });

    const len = cable.length_meters ? `${Math.round(cable.length_meters)} meter` : 'Panjang otomatis';

    let typeBadge = '<span class="badge bg-primary">Distribusi</span>';
    if (cable.cable_type === 'feeder') typeBadge = '<span class="badge bg-danger">Feeder</span>';
    else if (cable.cable_type === 'dropcore') typeBadge = '<span class="badge bg-success">Drop Core</span>';
    else if (cable.cable_type === 'backbone') typeBadge = '<span class="badge bg-purple text-white" style="background:#8b5cf6;">Backbone</span>';

    const popupHtml = `
        <div style="min-width: 210px; font-size: 0.88rem;">
            <div class="d-flex align-items-center justify-content-between mb-1">
                ${typeBadge}
                <span class="badge bg-light text-dark border">${cable.core_count || 12} Core</span>
            </div>
            <h6 class="fw-bold mb-1 text-dark">${escapeHtml(cable.name)}</h6>
            <div class="small mb-2"><i class="fas fa-ruler-combined text-primary me-1"></i><strong>Panjang:</strong> ${len}</div>
            ${cable.notes ? `<div class="small text-muted mb-2 fst-italic">"${escapeHtml(cable.notes)}"</div>` : ''}
            <div class="pt-1 border-top">
                <button class="btn btn-sm btn-outline-danger w-100 py-1" onclick="deleteCable(${cable.id}, '${escapeHtml(cable.name)}')">
                    <i class="fas fa-trash-alt me-1"></i> Hapus Jalur Kabel
                </button>
            </div>
        </div>
    `;

    polyline.bindPopup(popupHtml);

    // Hover effect
    polyline.on('mouseover', function() {
        if (!drawingCableMode) this.setStyle({ weight: 7.5, opacity: 1 });
    });
    polyline.on('mouseout', function() {
        if (!drawingCableMode) this.setStyle({ weight: 5, opacity: 0.9 });
    });

    // Klik Polyline saat mode menggambar: tambahkan titik kabel
    polyline.on('click', function(e) {
        if (drawingCableMode) {
            L.DomEvent.stopPropagation(e);
            addCablePoint(e.latlng.lat, e.latlng.lng);
            polyline.closePopup();
            return false;
        }
    });

    return polyline;
}

// ==========================================================================
// 3. MODE MENGGAMBAR KABEL JARINGAN (POLYLINE DRAWING)
// ==========================================================================
function toggleCableDrawingMode() {
    if (drawingCableMode) {
        cancelCableDrawing();
    } else {
        startCableDrawing();
    }
}

function startCableDrawing(startLat = null, startLng = null) {
    drawingCableMode = true;
    cablePoints = [];
    if (drawingPolyline) {
        map.removeLayer(drawingPolyline);
        drawingPolyline = null;
    }
    drawingPointsGroup.clearLayers();
    map.closePopup();

    // Matikan double click zoom agar dobel-klik bisa dipakai untuk menyelesaikan gambar
    map.doubleClickZoom.disable();

    // Ubah kursor jadi crosshair
    document.getElementById('customerMap').style.cursor = 'crosshair';

    // Update banner
    const banner = document.getElementById('drawingAlertBanner');
    banner.classList.remove('d-none');
    banner.classList.add('d-flex');
    document.getElementById('drawingAlertTitle').textContent = 'Mode Menggambar Jalur Kabel Aktif';
    document.getElementById('drawingAlertDesc').textContent = 'Klik titik demi titik di peta (atau klik langsung pada ODP/ODC/Rumah). Dobel-klik untuk menyelesaikan.';
    document.getElementById('cablePointsCount').textContent = '0';

    const btn = document.getElementById('btnToggleDrawCable');
    btn.classList.remove('btn-success');
    btn.classList.add('btn-outline-danger');
    btn.innerHTML = '<i class="fas fa-times me-1"></i> Batal Gambar';

    // Jika ada koordinat awal (misal dari klik kanan)
    if (startLat && startLng) {
        addCablePoint(startLat, startLng, 'Titik Awal');
    }

    Swal.fire({
        icon: 'info',
        title: 'Tarik Kabel Aktif',
        text: 'Klik pada peta / perangkat untuk menentukan jalur kabel. Dobel-klik untuk selesai.',
        timer: 2500,
        showConfirmButton: false,
        toast: true,
        position: 'top-end'
    });
}

function addCablePoint(lat, lng, label = '') {
    if (!drawingCableMode) return;

    cablePoints.push([lat, lng]);
    const count = cablePoints.length;
    document.getElementById('cablePointsCount').textContent = count;

    // Tambah marker visual titik
    const ptMarker = L.circleMarker([lat, lng], {
        radius: count === 1 ? 6 : 4.5,
        color: count === 1 ? '#10b981' : '#ef4444',
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 2
    });
    drawingPointsGroup.addLayer(ptMarker);

    // Hitung total panjang berjalan
    let runningMeters = 0;
    for (let i = 0; i < cablePoints.length - 1; i++) {
        const p1 = L.latLng(cablePoints[i][0], cablePoints[i][1]);
        const p2 = L.latLng(cablePoints[i+1][0], cablePoints[i+1][1]);
        runningMeters += p1.distanceTo(p2);
    }

    // Update polyline preview
    if (drawingPolyline) {
        drawingPolyline.setLatLngs(cablePoints);
    } else {
        drawingPolyline = L.polyline(cablePoints, {
            color: '#ef4444',
            weight: 4.5,
            dashArray: '6, 6'
        }).addTo(map);
    }

    // Update deskripsi banner dengan panjang
    if (runningMeters > 0) {
        document.getElementById('drawingAlertDesc').textContent = `Panjang Jalur: ~${Math.round(runningMeters)} meter (${count} Titik). Dobel-klik untuk selesai.`;
    }
}

function undoCablePoint() {
    if (!drawingCableMode || cablePoints.length === 0) return;

    cablePoints.pop();
    const count = cablePoints.length;
    document.getElementById('cablePointsCount').textContent = count;

    // Bersihkan titik visual dan gambar ulang
    drawingPointsGroup.clearLayers();
    cablePoints.forEach((pt, idx) => {
        const ptMarker = L.circleMarker(pt, {
            radius: idx === 0 ? 6 : 4.5,
            color: idx === 0 ? '#10b981' : '#ef4444',
            fillColor: '#ffffff',
            fillOpacity: 1,
            weight: 2
        });
        drawingPointsGroup.addLayer(ptMarker);
    });

    if (drawingPolyline) {
        if (cablePoints.length > 0) {
            drawingPolyline.setLatLngs(cablePoints);
        } else {
            map.removeLayer(drawingPolyline);
            drawingPolyline = null;
        }
    }

    // Update meter banner
    let runningMeters = 0;
    for (let i = 0; i < cablePoints.length - 1; i++) {
        const p1 = L.latLng(cablePoints[i][0], cablePoints[i][1]);
        const p2 = L.latLng(cablePoints[i+1][0], cablePoints[i+1][1]);
        runningMeters += p1.distanceTo(p2);
    }
    document.getElementById('drawingAlertDesc').textContent = runningMeters > 0 
        ? `Panjang Jalur: ~${Math.round(runningMeters)} meter (${count} Titik). Dobel-klik untuk selesai.` 
        : 'Klik pada titik-titik di peta (sepanjang tiang/jalan).';
}

function cancelCableDrawing() {
    drawingCableMode = false;
    cablePoints = [];
    if (drawingPolyline) {
        map.removeLayer(drawingPolyline);
        drawingPolyline = null;
    }
    drawingPointsGroup.clearLayers();
    document.getElementById('customerMap').style.cursor = '';
    map.doubleClickZoom.enable();

    const banner = document.getElementById('drawingAlertBanner');
    banner.classList.add('d-none');
    banner.classList.remove('d-flex');

    const btn = document.getElementById('btnToggleDrawCable');
    btn.classList.add('btn-success');
    btn.classList.remove('btn-outline-danger');
    btn.innerHTML = '<i class="fas fa-draw-polygon me-1"></i> Tarik Kabel';
}

function handleMapDblClick(e) {
    if (drawingCableMode && cablePoints.length >= 2) {
        L.DomEvent.stopPropagation(e);
        finishCableDrawing();
    }
}

function finishCableDrawing() {
    if (cablePoints.length < 2) {
        Swal.fire({
            icon: 'warning',
            title: 'Titik Kabel Kurang',
            text: 'Klik minimal 2 titik pada peta untuk membuat jalur kabel.'
        });
        return;
    }

    // Hitung total panjang meter
    let totalMeters = 0;
    for (let i = 0; i < cablePoints.length - 1; i++) {
        const p1 = L.latLng(cablePoints[i][0], cablePoints[i][1]);
        const p2 = L.latLng(cablePoints[i+1][0], cablePoints[i+1][1]);
        totalMeters += p1.distanceTo(p2);
    }

    const mRounded = Math.round(totalMeters);
    document.getElementById('cableLengthDisplay').value = `${mRounded} m`;
    document.getElementById('cableName').value = `Kabel Jaringan ${cablePoints.length} Titik (${mRounded}m)`;

    safeShowModal('modalSaveCable');
}

function handleSaveCableSubmit(e) {
    e.preventDefault();
    const btn = document.getElementById('btnSubmitCable');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Menyimpan...';

    let totalMeters = 0;
    for (let i = 0; i < cablePoints.length - 1; i++) {
        const p1 = L.latLng(cablePoints[i][0], cablePoints[i][1]);
        const p2 = L.latLng(cablePoints[i+1][0], cablePoints[i+1][1]);
        totalMeters += p1.distanceTo(p2);
    }

    const payload = {
        name: document.getElementById('cableName').value,
        cable_type: document.getElementById('cableType').value,
        core_count: parseInt(document.getElementById('cableCoreCount').value, 10),
        color: document.getElementById('cableColor').value,
        coordinates: cablePoints,
        length_meters: totalMeters,
        notes: document.getElementById('cableNotes').value
    };

    fetch('/api/network/cables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        btn.disabled = false;
        btn.innerHTML = 'Simpan Kabel';
        if (data.success) {
            safeHideModal('modalSaveCable');
            cancelCableDrawing();
            loadNetworkData();
            Swal.fire({
                icon: 'success',
                title: 'Kabel Tersimpan',
                text: 'Jalur kabel fiber optic berhasil disimpan ke peta!',
                timer: 2000,
                showConfirmButton: false
            });
        } else {
            Swal.fire({ icon: 'error', title: 'Gagal', text: data.message || 'Gagal menyimpan kabel' });
        }
    })
    .catch(err => {
        btn.disabled = false;
        btn.innerHTML = 'Simpan Kabel';
        Swal.fire({ icon: 'error', title: 'Error', text: err.message });
    });
}

function deleteCable(id, name) {
    map.closePopup();
    Swal.fire({
        title: 'Hapus Jalur Kabel?',
        text: `Apakah Anda yakin ingin menghapus "${name}"?`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        confirmButtonText: 'Ya, Hapus!',
        cancelButtonText: 'Batal'
    }).then(res => {
        if (res.isConfirmed) {
            fetch(`/api/network/cables/${id}/delete`, { method: 'POST' })
                .then(r => r.json())
                .then(data => {
                    if (data.success) {
                        loadNetworkData();
                        Swal.fire({ icon: 'success', title: 'Dihapus', text: 'Kabel berhasil dihapus', timer: 1500, showConfirmButton: false });
                    } else {
                        Swal.fire({ icon: 'error', title: 'Gagal', text: data.message });
                    }
                })
                .catch(err => Swal.fire({ icon: 'error', title: 'Error', text: err.message }));
        }
    });
}

// ==========================================================================
// 4. MAP CLICKS & CONTEXT MENUS
// ==========================================================================
function handleMapClick(e) {
    // A. Mode Memilih Titik untuk Modal Tambah Perangkat
    if (pickingLocationForNode) {
        document.getElementById('nodeLat').value = e.latlng.lat.toFixed(6);
        document.getElementById('nodeLng').value = e.latlng.lng.toFixed(6);
        pickingLocationForNode = false;
        document.getElementById('customerMap').style.cursor = '';
        const banner = document.getElementById('drawingAlertBanner');
        banner.classList.add('d-none');
        banner.classList.remove('d-flex');

        safeShowModal('modalAddNode');
        return;
    }

    // B. Mode Menandai Rumah Pelanggan
    if (pinningCustomerTarget) {
        handleCustomerPinLocation(e.latlng);
        return;
    }

    // C. Mode Menggambar Kabel
    if (drawingCableMode) {
        addCablePoint(e.latlng.lat, e.latlng.lng);
        return;
    }
}

// Klik Kanan Peta: Menu Pintas Tambah Perangkat / Tandai Rumah / Tarik Kabel
function handleMapContextMenu(e) {
    if (drawingCableMode || pickingLocationForNode || pinningCustomerTarget) return;

    const lat = e.latlng.lat.toFixed(6);
    const lng = e.latlng.lng.toFixed(6);

    const contextHtml = `
        <div style="min-width: 190px; padding: 2px;">
            <div class="fw-bold small text-muted mb-2 border-bottom pb-1">
                <i class="fas fa-map-marker-alt text-danger me-1"></i>${lat}, ${lng}
            </div>
            <button class="btn btn-sm btn-outline-primary w-100 text-start mb-1 py-1" onclick="map.closePopup(); openAddNodeModal(${lat}, ${lng})">
                <i class="fas fa-plus-circle text-primary me-2"></i> Tambah Perangkat di Sini
            </button>
            <button class="btn btn-sm btn-outline-warning text-dark w-100 text-start mb-1 py-1" onclick="map.closePopup(); openPinCustomerWithCoords(${lat}, ${lng})">
                <i class="fas fa-home text-warning me-2"></i> Tandai Rumah di Sini
            </button>
            <button class="btn btn-sm btn-outline-success w-100 text-start py-1" onclick="map.closePopup(); startCableDrawing(${lat}, ${lng})">
                <i class="fas fa-draw-polygon text-success me-2"></i> Tarik Kabel dari Sini
            </button>
        </div>
    `;

    L.popup({ offset: [0, -5] })
        .setLatLng(e.latlng)
        .setContent(contextHtml)
        .openOn(map);
}

// ==========================================================================
// 5. TAMBAH & EDIT TITIK PERANGKAT (ODP, ODC, OLT, SWITCH, ONT)
// ==========================================================================
function openAddNodeModal(prefilledLat = null, prefilledLng = null) {
    const form = document.getElementById('formAddNode');
    if (form) form.reset();
    document.getElementById('nodeId').value = '';
    document.getElementById('modalAddNodeLabel').innerHTML = '<i class="fas fa-plus-circle text-primary me-2"></i>Tambah Titik Perangkat';
    document.getElementById('btnSubmitNode').textContent = 'Simpan Perangkat';
    handleNodeTypeChange();

    if (prefilledLat && prefilledLng) {
        document.getElementById('nodeLat').value = prefilledLat;
        document.getElementById('nodeLng').value = prefilledLng;
    }

    safeShowModal('modalAddNode');
}

function openEditNodeModal(node) {
    map.closePopup();
    document.getElementById('nodeId').value = node.id;
    document.getElementById('nodeType').value = node.type;
    document.getElementById('nodeName').value = node.name;
    document.getElementById('nodeCapacity').value = node.capacity || 8;
    document.getElementById('nodeUsedCapacity').value = node.used_capacity || 0;
    document.getElementById('nodeLat').value = parseFloat(node.latitude).toFixed(6);
    document.getElementById('nodeLng').value = parseFloat(node.longitude).toFixed(6);
    document.getElementById('nodeAddress').value = node.address || '';
    document.getElementById('nodeNotes').value = node.notes || '';
    document.getElementById('modalAddNodeLabel').innerHTML = `<i class="fas fa-edit text-warning me-2"></i>Edit Perangkat #${node.id} (${node.name})`;
    document.getElementById('btnSubmitNode').textContent = 'Perbarui Perangkat';
    safeShowModal('modalAddNode');
}

function startPickingNodeLocation() {
    pickingLocationForNode = true;
    safeHideModal('modalAddNode');

    document.getElementById('customerMap').style.cursor = 'crosshair';
    const banner = document.getElementById('drawingAlertBanner');
    banner.classList.remove('d-none');
    banner.classList.add('d-flex');
    document.getElementById('drawingAlertTitle').textContent = 'Pilih Titik di Peta Satelit';
    document.getElementById('drawingAlertDesc').textContent = 'Klik satu kali pada peta satelit untuk menetapkan titik koordinat perangkat.';
    document.getElementById('btnFinishDrawing').classList.add('d-none');
    const btnUndo = document.getElementById('btnUndoPoint');
    if (btnUndo) btnUndo.classList.add('d-none');

    Swal.fire({
        icon: 'info',
        title: 'Klik Titik di Peta',
        text: 'Klik lokasi tiang / posisi perangkat pada citra satelit.',
        timer: 2000,
        showConfirmButton: false,
        toast: true,
        position: 'top-end'
    });
}

function handleSaveNode(e) {
    e.preventDefault();
    const btn = document.getElementById('btnSubmitNode');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Menyimpan...';

    const nodeId = document.getElementById('nodeId').value;
    const isEdit = !!nodeId;

    const payload = {
        type: document.getElementById('nodeType').value,
        name: document.getElementById('nodeName').value,
        capacity: parseInt(document.getElementById('nodeCapacity').value, 10),
        used_capacity: parseInt(document.getElementById('nodeUsedCapacity').value, 10),
        latitude: parseFloat(document.getElementById('nodeLat').value),
        longitude: parseFloat(document.getElementById('nodeLng').value),
        address: document.getElementById('nodeAddress').value,
        notes: document.getElementById('nodeNotes').value
    };

    const url = isEdit ? `/api/network/nodes/${nodeId}` : '/api/network/nodes';

    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    .then(r => r.json())
    .then(data => {
        btn.disabled = false;
        btn.innerHTML = isEdit ? 'Perbarui Perangkat' : 'Simpan Perangkat';
        if (data.success) {
            safeHideModal('modalAddNode');
            document.getElementById('formAddNode').reset();
            loadNetworkData();
            Swal.fire({
                icon: 'success',
                title: 'Berhasil',
                text: data.message || (isEdit ? 'Perangkat diperbarui' : 'Perangkat ditambahkan'),
                timer: 2000,
                showConfirmButton: false
            });
        } else {
            Swal.fire({ icon: 'error', title: 'Gagal', text: data.message || 'Gagal menyimpan perangkat' });
        }
    })
    .catch(err => {
        btn.disabled = false;
        btn.innerHTML = isEdit ? 'Perbarui Perangkat' : 'Simpan Perangkat';
        Swal.fire({ icon: 'error', title: 'Error', text: err.message });
    });
}

function deleteNode(id, name) {
    map.closePopup();
    Swal.fire({
        title: 'Hapus Perangkat?',
        text: `Apakah Anda yakin ingin menghapus perangkat "${name}"?`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        confirmButtonText: 'Ya, Hapus!',
        cancelButtonText: 'Batal'
    }).then(res => {
        if (res.isConfirmed) {
            fetch(`/api/network/nodes/${id}/delete`, { method: 'POST' })
                .then(r => r.json())
                .then(data => {
                    if (data.success) {
                        loadNetworkData();
                        Swal.fire({ icon: 'success', title: 'Dihapus', text: 'Perangkat berhasil dihapus', timer: 1500, showConfirmButton: false });
                    } else {
                        Swal.fire({ icon: 'error', title: 'Gagal', text: data.message });
                    }
                })
                .catch(err => Swal.fire({ icon: 'error', title: 'Error', text: err.message }));
        }
    });
}

function handleNodeTypeChange() {
    const type = document.getElementById('nodeType').value;
    const cap = document.getElementById('nodeCapacity');
    if (!cap) return;
    if (type === 'OLT') cap.value = 16;
    else if (type === 'ODC') cap.value = 48;
    else if (type === 'ODP') cap.value = 8;
    else if (type === 'Switch') cap.value = 24;
    else if (type === 'ONT') cap.value = 1;
}

function handleCableTypeChange() {
    const type = document.getElementById('cableType').value;
    const colorInput = document.getElementById('cableColor');
    const colorLabel = document.getElementById('cableColorLabel');
    if (!colorInput) return;
    if (type === 'feeder') {
        colorInput.value = '#ef4444';
        if (colorLabel) colorLabel.textContent = 'Merah';
    } else if (type === 'distribution') {
        colorInput.value = '#3b82f6';
        if (colorLabel) colorLabel.textContent = 'Biru';
    } else if (type === 'dropcore') {
        colorInput.value = '#10b981';
        if (colorLabel) colorLabel.textContent = 'Hijau';
    } else if (type === 'backbone') {
        colorInput.value = '#8b5cf6';
        if (colorLabel) colorLabel.textContent = 'Ungu';
    }
}

// ==========================================================================
// 6. MENANDAI RUMAH PELANGGAN & GESER POSISI PIN
// ==========================================================================
function setupCustomerPinModal() {
    const sel = document.getElementById('pinCustomerId');
    if (!sel) return;
    sel.addEventListener('change', function() {
        const opt = this.options[this.selectedIndex];
        const info = document.getElementById('pinCustomerInfo');
        if (!this.value) {
            info.innerHTML = '<i class="fas fa-info-circle text-primary me-1"></i>Pilih salah satu pelanggan untuk melihat informasi alamat dan koordinat saat ini.';
            return;
        }
        const name = opt.getAttribute('data-name');
        const code = opt.getAttribute('data-code');
        const address = opt.getAttribute('data-address');
        const lat = opt.getAttribute('data-lat');
        const lng = opt.getAttribute('data-lng');

        info.innerHTML = `
            <strong>${escapeHtml(name)}</strong> (${escapeHtml(code)})<br>
            <i class="fas fa-map-marker-alt text-danger me-1"></i>Alamat: ${escapeHtml(address || 'Belum ada alamat')}<br>
            <i class="fas fa-crosshairs text-info me-1"></i>Koordinat: ${lat ? `<strong>${lat}, ${lng}</strong> <span class="badge bg-success ms-1">Sudah Ada Pin</span>` : '<span class="badge bg-secondary ms-1">Belum Ditandai</span>'}
        `;
    });
}

function filterCustomerDropdown() {
    const query = (document.getElementById('searchCustomerInput').value || '').toLowerCase().trim();
    const sel = document.getElementById('pinCustomerId');
    if (!sel) return;

    for (let i = 1; i < sel.options.length; i++) {
        const opt = sel.options[i];
        const text = opt.textContent.toLowerCase();
        if (!query || text.includes(query)) {
            opt.style.display = '';
        } else {
            opt.style.display = 'none';
        }
    }
}

function openPinCustomerWithCoords(lat, lng) {
    window.tempCoordsForPin = { lat, lng };
    safeShowModal('modalPinCustomer');
}

function startCustomerPinning() {
    const sel = document.getElementById('pinCustomerId');
    if (!sel || !sel.value) {
        Swal.fire({ icon: 'warning', title: 'Pilih Pelanggan', text: 'Silakan pilih pelanggan terlebih dahulu dari dropdown.' });
        return;
    }
    const opt = sel.options[sel.selectedIndex];
    pinningCustomerTarget = {
        id: sel.value,
        name: opt.getAttribute('data-name'),
        code: opt.getAttribute('data-code')
    };

    safeHideModal('modalPinCustomer');

    // Jika sudah ada koordinat dari klik kanan
    if (window.tempCoordsForPin) {
        const coords = window.tempCoordsForPin;
        window.tempCoordsForPin = null;
        handleCustomerPinLocation(coords);
        return;
    }

    document.getElementById('customerMap').style.cursor = 'crosshair';
    const banner = document.getElementById('drawingAlertBanner');
    banner.classList.remove('d-none');
    banner.classList.add('d-flex');
    document.getElementById('drawingAlertTitle').textContent = `Tandai Rumah: ${pinningCustomerTarget.name}`;
    document.getElementById('drawingAlertDesc').textContent = 'Perbesar citra satelit lalu klik tepat di atas atap rumah pelanggan.';
    document.getElementById('btnFinishDrawing').classList.add('d-none');
    const btnUndo = document.getElementById('btnUndoPoint');
    if (btnUndo) btnUndo.classList.add('d-none');

    Swal.fire({
        icon: 'info',
        title: 'Tandai Rumah Pelanggan',
        text: `Klik tepat di atas atap rumah "${pinningCustomerTarget.name}" pada citra satelit.`,
        timer: 3000,
        showConfirmButton: false,
        toast: true,
        position: 'top-end'
    });
}

function handleCustomerPinLocation(latlng) {
    const target = pinningCustomerTarget;
    pinningCustomerTarget = null;
    document.getElementById('customerMap').style.cursor = '';
    const banner = document.getElementById('drawingAlertBanner');
    banner.classList.add('d-none');
    banner.classList.remove('d-flex');

    const latVal = typeof latlng.lat === 'function' ? latlng.lat() : latlng.lat;
    const lngVal = typeof latlng.lng === 'function' ? latlng.lng() : latlng.lng;

    Swal.fire({
        title: 'Konfirmasi Lokasi Rumah',
        html: `Tandai rumah pelanggan <strong>${escapeHtml(target.name)}</strong> pada koordinat:<br><code class="fs-6">${latVal.toFixed(6)}, ${lngVal.toFixed(6)}</code>?`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#10b981',
        confirmButtonText: 'Ya, Simpan Lokasi!',
        cancelButtonText: 'Batal'
    }).then(res => {
        if (res.isConfirmed) {
            fetch('/api/network/pin-customer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customer_id: target.id,
                    latitude: latVal,
                    longitude: lngVal
                })
            })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    loadNetworkData();
                    map.flyTo([latVal, lngVal], 19, { animate: true, duration: 1.2 });
                    Swal.fire({
                        icon: 'success',
                        title: 'Lokasi Berhasil Ditandai',
                        text: data.message,
                        timer: 2000,
                        showConfirmButton: false
                    });
                } else {
                    Swal.fire({ icon: 'error', title: 'Gagal', text: data.message });
                }
            })
            .catch(err => Swal.fire({ icon: 'error', title: 'Error', text: err.message }));
        }
    });
}

function unpinCustomer(id, name) {
    map.closePopup();
    Swal.fire({
        title: 'Hapus Pin Lokasi Rumah?',
        text: `Hapus tanda pin koordinat untuk pelanggan "${name}"?`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        confirmButtonText: 'Ya, Hapus Pin',
        cancelButtonText: 'Batal'
    }).then(res => {
        if (res.isConfirmed) {
            fetch(`/api/network/customers/${id}/unpin`, { method: 'POST' })
                .then(r => r.json())
                .then(data => {
                    if (data.success) {
                        loadNetworkData();
                        Swal.fire({ icon: 'success', title: 'Pin Dihapus', text: data.message, timer: 1500, showConfirmButton: false });
                    } else {
                        Swal.fire({ icon: 'error', title: 'Gagal', text: data.message });
                    }
                })
                .catch(err => Swal.fire({ icon: 'error', title: 'Error', text: err.message }));
        }
    });
}

// Fitur Geser / Pindahkan Marker dengan Drag-and-Drop
function enableMarkerDrag(id, type) {
    map.closePopup();

    let targetLayer = null;
    let targetGroup = (type === 'node') 
        ? [oltGroup, odcGroup, odpGroup, switchGroup] 
        : [ontGroup];

    for (const grp of targetGroup) {
        grp.eachLayer(layer => {
            // Cocokkan id dari popup atau data
            if (layer._latlng) {
                targetLayer = layer;
            }
        });
    }

    Swal.fire({
        icon: 'info',
        title: 'Mode Geser Aktif',
        text: 'Silakan drag & drop pin ke posisi yang lebih akurat pada citra satelit.',
        timer: 3000,
        showConfirmButton: false,
        toast: true,
        position: 'top-end'
    });

    // Cari marker yang sesuai
    let foundMarker = null;
    const allGroups = [oltGroup, odcGroup, odpGroup, switchGroup, ontGroup];
    allGroups.forEach(grp => {
        grp.eachLayer(layer => {
            const popupContent = layer.getPopup() ? layer.getPopup().getContent() : '';
            if (popupContent.includes(`enableMarkerDrag(${id}, '${type}')`)) {
                foundMarker = layer;
            }
        });
    });

    if (!foundMarker) {
        Swal.fire({ icon: 'warning', title: 'Perhatian', text: 'Silakan klik pin pada peta untuk menggeser.' });
        return;
    }

    const origPos = foundMarker.getLatLng();
    foundMarker.dragging.enable();

    // Beri styling pulsing
    const iconEl = foundMarker.getElement();
    if (iconEl) iconEl.style.filter = 'drop-shadow(0 0 8px #f59e0b)';

    foundMarker.once('dragend', function(e) {
        foundMarker.dragging.disable();
        if (iconEl) iconEl.style.filter = '';
        const newPos = foundMarker.getLatLng();

        Swal.fire({
            title: 'Simpan Posisi Baru?',
            html: `Pindahkan ke koordinat baru:<br><code>${newPos.lat.toFixed(6)}, ${newPos.lng.toFixed(6)}</code>?`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonColor: '#10b981',
            confirmButtonText: 'Ya, Simpan!',
            cancelButtonText: 'Batal'
        }).then(res => {
            if (res.isConfirmed) {
                const endpoint = (type === 'node') ? `/api/network/nodes/${id}/move` : `/api/network/customers/${id}/move`;
                fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        latitude: newPos.lat,
                        longitude: newPos.lng
                    })
                })
                .then(r => r.json())
                .then(data => {
                    if (data.success) {
                        loadNetworkData();
                        Swal.fire({ icon: 'success', title: 'Berhasil Dipindahkan', text: data.message, timer: 1500, showConfirmButton: false });
                    } else {
                        foundMarker.setLatLng(origPos);
                        Swal.fire({ icon: 'error', title: 'Gagal', text: data.message });
                    }
                })
                .catch(err => {
                    foundMarker.setLatLng(origPos);
                    Swal.fire({ icon: 'error', title: 'Error', text: err.message });
                });
            } else {
                foundMarker.setLatLng(origPos);
            }
        });
    });
}

// ==========================================================================
// 7. FILTER CHECKBOXES & UTILITIES
// ==========================================================================
function toggleLayerFilter() {
    const chkOLT = document.getElementById('chkOLT') ? document.getElementById('chkOLT').checked : true;
    const chkODC = document.getElementById('chkODC') ? document.getElementById('chkODC').checked : true;
    const chkODP = document.getElementById('chkODP') ? document.getElementById('chkODP').checked : true;
    const chkSwitch = document.getElementById('chkSwitch') ? document.getElementById('chkSwitch').checked : true;
    const chkONT = document.getElementById('chkONT') ? document.getElementById('chkONT').checked : true;
    const chkCables = document.getElementById('chkCables') ? document.getElementById('chkCables').checked : true;
    const chkRadius = document.getElementById('chkRadius') ? document.getElementById('chkRadius').checked : false;

    if (chkOLT) map.addLayer(oltGroup); else map.removeLayer(oltGroup);
    if (chkODC) map.addLayer(odcGroup); else map.removeLayer(odcGroup);
    if (chkODP) map.addLayer(odpGroup); else map.removeLayer(odpGroup);
    if (chkSwitch) map.addLayer(switchGroup); else map.removeLayer(switchGroup);
    if (chkONT) map.addLayer(ontGroup); else map.removeLayer(ontGroup);
    if (chkCables) map.addLayer(cablesGroup); else map.removeLayer(cablesGroup);
    if (chkRadius) map.addLayer(radiusGroup); else map.removeLayer(radiusGroup);
}

function fitAllMarkers() {
    const allLayers = [oltGroup, odcGroup, odpGroup, switchGroup, ontGroup, cablesGroup];
    const bounds = [];
    allLayers.forEach(grp => {
        grp.eachLayer(layer => {
            if (layer.getLatLng) {
                bounds.push(layer.getLatLng());
            } else if (layer.getLatLngs) {
                const pts = layer.getLatLngs();
                pts.forEach(p => bounds.push(p));
            }
        });
    });

    if (bounds.length > 0) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
    } else {
        const defaultLat = parseFloat(document.getElementById('customerMap').getAttribute('data-lat')) || -7.020892;
        const defaultLng = parseFloat(document.getElementById('customerMap').getAttribute('data-lng')) || 107.72796;
        map.setView([defaultLat, defaultLng], 15);
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Bind all global functions to window so inline onclick handlers never throw undefined
window.safeShowModal = safeShowModal;
window.safeHideModal = safeHideModal;
window.openAddNodeModal = openAddNodeModal;
window.openEditNodeModal = openEditNodeModal;
window.handleSaveNode = handleSaveNode;
window.deleteNode = deleteNode;
window.enableMarkerDrag = enableMarkerDrag;
window.toggleCableDrawingMode = toggleCableDrawingMode;
window.startCableDrawing = startCableDrawing;
window.cancelCableDrawing = cancelCableDrawing;
window.finishCableDrawing = finishCableDrawing;
window.undoCablePoint = undoCablePoint;
window.handleSaveCableSubmit = handleSaveCableSubmit;
window.deleteCable = deleteCable;
window.startCustomerPinning = startCustomerPinning;
window.unpinCustomer = unpinCustomer;
window.filterCustomerDropdown = filterCustomerDropdown;
window.openPinCustomerWithCoords = openPinCustomerWithCoords;
window.startPickingNodeLocation = startPickingNodeLocation;
window.toggleLayerFilter = toggleLayerFilter;
window.fitAllMarkers = fitAllMarkers;
window.handleNodeTypeChange = handleNodeTypeChange;
window.handleCableTypeChange = handleCableTypeChange;
