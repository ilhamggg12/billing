const axios = require('axios');

class GenieACSService {
    constructor() {
        this.baseUrl = '';
    }

    configure(url) {
        if (!url) return;
        this.baseUrl = url.replace(/\/$/, '');
    }

    /**
     * Mengambil daftar perangkat dari GenieACS
     */
    async getDevices(query = {}) {
        const params = new URLSearchParams();
        if (Object.keys(query).length > 0) {
            params.append('query', JSON.stringify(query));
        }
        // Ambil data lengkap untuk kebutuhan remote device
        const res = await axios.get(`${this.baseUrl}/devices?${params.toString()}`, { timeout: 15000 });
        return (res.data || []).map(device => this.parseDevice(device));
    }

    /**
     * Mengambil data detail satu perangkat berdasarkan _id
     * Catatan: GenieACS NBI v1.2+ menggunakan query ?query={"_id":"..."} karena GET /devices/:id menghasilkan 405
     */
    async getDevice(id) {
        const query = JSON.stringify({ _id: id });
        const res = await axios.get(`${this.baseUrl}/devices?query=${encodeURIComponent(query)}`, { timeout: 15000 });
        if (!res.data || res.data.length === 0) {
            throw new Error(`Perangkat "${id}" tidak ditemukan di GenieACS`);
        }
        const rawDevice = res.data[0];
        return {
            raw: rawDevice,
            parsed: this.parseDevice(rawDevice)
        };
    }

    /**
     * Mengirim task ke perangkat di GenieACS
     * Mencoba dengan ?connection_request terlebih dahulu agar ONT langsung mengeksekusi.
     * Jika connection request timeout (ONT sedang offline/lambat), otomatis fallback simpan ke task queue.
     */
    async addTask(id, taskData, triggerConnectionRequest = true) {
        const encodedId = encodeURIComponent(id);
        
        if (triggerConnectionRequest) {
            try {
                const res = await axios.post(`${this.baseUrl}/devices/${encodedId}/tasks?connection_request`, taskData, {
                    timeout: 7000
                });
                return { success: true, immediate: true, status: res.status, data: res.data };
            } catch (err) {
                // Jika connection request timeout atau gagal, fallback antrekan task biasa
                console.warn(`[GenieACS] Connection request ke ${id} lambat/timeout (${err.message}). Mengantrekan task ke database...`);
            }
        }

        // Simpan langsung ke antrean task GenieACS (status 202)
        const res = await axios.post(`${this.baseUrl}/devices/${encodedId}/tasks`, taskData, { timeout: 8000 });
        return { success: true, immediate: false, status: res.status, data: res.data };
    }

    /**
     * Reboot ONT
     */
    async rebootDevice(id) {
        return await this.addTask(id, { name: 'reboot' }, true);
    }

    /**
     * Reset Pabrik (Factory Reset) ONT
     */
    async factoryResetDevice(id) {
        return await this.addTask(id, { name: 'factoryReset' }, true);
    }

    /**
     * Refresh / Tarik parameter terbaru dari ONT (getParameterValues)
     */
    async refreshDevice(id, parameterNames = null) {
        const defaultNames = [
            'InternetGatewayDevice.LANDevice.1.WLANConfiguration.',
            'InternetGatewayDevice.LANDevice.1.Hosts.',
            'InternetGatewayDevice.WANDevice.',
            'InternetGatewayDevice.DeviceInfo.',
            'VirtualParameters.'
        ];
        return await this.addTask(id, {
            name: 'getParameterValues',
            parameterNames: parameterNames || defaultNames
        }, true);
    }

    /**
     * Ganti Nama WiFi (SSID) dan/atau Password WiFi
     */
    async setWifi(id, { ssid, password, enable, channel }) {
        const parameterValues = [];

        // 1. Nama WiFi (SSID)
        if (ssid && ssid.trim()) {
            parameterValues.push([
                'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
                ssid.trim(),
                'xsd:string'
            ]);
        }

        // 2. Password WiFi (WPA PreSharedKey & Passphrase)
        if (password && password.trim()) {
            parameterValues.push([
                'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
                password.trim(),
                'xsd:string'
            ]);
            parameterValues.push([
                'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
                password.trim(),
                'xsd:string'
            ]);
            parameterValues.push([
                'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.BeaconType',
                'WPAand11i',
                'xsd:string'
            ]);
        }

        // 3. Status WiFi Aktif/Nonaktif
        if (enable !== undefined && enable !== null && enable !== '') {
            const isEnable = (enable === true || enable === 'true' || enable === '1');
            parameterValues.push([
                'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable',
                isEnable,
                'xsd:boolean'
            ]);
        }

        // 4. Channel WiFi (opsional)
        if (channel !== undefined && channel !== null && channel !== '') {
            parameterValues.push([
                'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel',
                parseInt(channel) || 0,
                'xsd:unsignedInt'
            ]);
        }

        if (parameterValues.length === 0) {
            throw new Error('Tidak ada parameter WiFi yang diubah.');
        }

        return await this.addTask(id, {
            name: 'setParameterValues',
            parameterValues
        }, true);
    }

    /**
     * Toggle On/Off WiFi ONT
     */
    async setWifiEnable(id, enable = true) {
        return await this.addTask(id, {
            name: 'setParameterValues',
            parameterValues: [
                ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable', Boolean(enable), 'xsd:boolean']
            ]
        }, true);
    }

    /**
     * Konfigurasi Akun PPPoE pada WAN ONT
     */
    async setWanPppoe(id, { username, password }) {
        const parameterValues = [];
        if (username && username.trim()) {
            parameterValues.push([
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
                username.trim(),
                'xsd:string'
            ]);
            parameterValues.push([
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
                username.trim(),
                'xsd:string'
            ]);
        }
        if (password && password.trim()) {
            parameterValues.push([
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password',
                password.trim(),
                'xsd:string'
            ]);
            parameterValues.push([
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Password',
                password.trim(),
                'xsd:string'
            ]);
        }

        if (parameterValues.length === 0) {
            throw new Error('Username atau Password PPPoE tidak boleh kosong.');
        }

        return await this.addTask(id, {
            name: 'setParameterValues',
            parameterValues
        }, true);
    }

    /**
     * Jalankan Diagnostik Ping dari ONT
     */
    async runPingDiagnostics(id, host = '8.8.8.8') {
        const parameterValues = [
            ['InternetGatewayDevice.IPPingDiagnostics.Host', host.trim(), 'xsd:string'],
            ['InternetGatewayDevice.IPPingDiagnostics.DiagnosticsState', 'Requested', 'xsd:string']
        ];
        return await this.addTask(id, {
            name: 'setParameterValues',
            parameterValues
        }, true);
    }

    /**
     * Hapus perangkat dari GenieACS
     */
    async deleteDevice(id) {
        const encodedId = encodeURIComponent(id);
        return await axios.delete(`${this.baseUrl}/devices/${encodedId}`, { timeout: 10000 });
    }

    /**
     * Helper parsing data perangkat mentah dari GenieACS menjadi struktur yang bersih dan mudah diakses
     */
    parseDevice(d) {
        if (!d) return null;

        const deviceId = d._id || '-';
        const manufacturer = d._deviceId?._Manufacturer
            || d.InternetGatewayDevice?.DeviceInfo?.Manufacturer?._value
            || d['Device.DeviceInfo.Manufacturer']?._value
            || 'Unknown';

        const model = d._deviceId?._ProductClass
            || d.InternetGatewayDevice?.DeviceInfo?.ModelName?._value
            || d['Device.DeviceInfo.ModelName']?._value
            || 'Unknown';

        const serial = d._deviceId?._SerialNumber
            || d.VirtualParameters?.getSerialNumber?._value
            || d.InternetGatewayDevice?.DeviceInfo?.SerialNumber?._value
            || '-';

        const hardwareVersion = d.InternetGatewayDevice?.DeviceInfo?.HardwareVersion?._value
            || d.InternetGatewayDevice?.DeviceInfo?.ModemFirmwareVersion?._value
            || '-';

        const softwareVersion = d.InternetGatewayDevice?.DeviceInfo?.SoftwareVersion?._value || '-';

        // Status Online (Last inform kurang dari 24 jam)
        const lastInformRaw = d._lastInform;
        const lastInformDate = lastInformRaw ? new Date(lastInformRaw) : null;
        const isOnline = lastInformDate ? (Date.now() - lastInformDate.getTime() < 24 * 3600 * 1000) : false;

        // Optical / Sinyal Fiber
        const rxRaw = d.VirtualParameters?.RXPower?._value
            || d.InternetGatewayDevice?.WANDevice?.['1']?.X_CT_COM_EponInterfaceConfig?.RXPower?._value
            || d.InternetGatewayDevice?.WANDevice?.['1']?.X_CT_COM_GponInterfaceConfig?.RXPower?._value
            || d.InternetGatewayDevice?.WANDevice?.['1']?.WANGPONInterfaceConfig?.RXPower?._value
            || null;

        let rxPower = null;
        let opticalStatus = 'unknown'; // normal, warning, critical
        if (rxRaw !== null && rxRaw !== undefined && rxRaw !== '') {
            const rxNum = parseFloat(rxRaw);
            if (!isNaN(rxNum)) {
                rxPower = rxNum;
                if (rxNum >= -24.5) {
                    opticalStatus = 'normal'; // Hijau: sinyal bagus
                } else if (rxNum >= -27.0) {
                    opticalStatus = 'warning'; // Kuning: redaman mulai tinggi
                } else {
                    opticalStatus = 'critical'; // Merah: redaman terlalu tinggi
                }
            }
        }

        const ponMode = d.VirtualParameters?.getponmode?._value || 'EPON / GPON';
        const temp = d.VirtualParameters?.gettemp?._value || '-';

        // WiFi Parameters
        const wlan1 = d.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.['1'] || {};
        const ssid = wlan1.SSID?._value || d.VirtualParameters?.WlanSSID?._value || '-';
        const wifiPassword = wlan1.KeyPassphrase?._value
            || wlan1.PreSharedKey?.['1']?.PreSharedKey?._value
            || d.VirtualParameters?.WlanPassword?._value
            || '';
        const wifiEnabled = wlan1.Enable?._value !== undefined ? Boolean(wlan1.Enable?._value) : true;
        const channel = wlan1.Channel?._value || 0;
        const beaconType = wlan1.BeaconType?._value || 'WPA/WPA2';

        // WAN / PPPoE
        const pppUser = d.VirtualParameters?.pppoeUsername?._value
            || d.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.Username?._value
            || d.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['2']?.WANPPPConnection?.['1']?.Username?._value
            || '-';

        const pppIp = d.VirtualParameters?.pppoeIP?._value
            || d.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.ExternalIPAddress?._value
            || d.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['2']?.WANPPPConnection?.['1']?.ExternalIPAddress?._value
            || '-';

        const pppMac = d.VirtualParameters?.pppoeMac?._value || '-';
        const connectionRequestUrl = d.InternetGatewayDevice?.ManagementServer?.ConnectionRequestURL?._value || '';

        // Web GUI Admin Credentials
        const superAdmin = d.VirtualParameters?.superAdmin?._value || 'admin';
        const superPassword = d.VirtualParameters?.superPassword?._value || '';
        const userAdmin = d.VirtualParameters?.userAdmin?._value || 'admin';
        const userPassword = d.VirtualParameters?.userPassword?._value || '';

        // Active Devices Count
        const activeDevicesCount = d.VirtualParameters?.activedevices?._value || 0;

        // Connected Hosts (LAN & WiFi)
        const hosts = [];
        const hostRoot = d.InternetGatewayDevice?.LANDevice?.['1']?.Hosts?.Host;
        if (hostRoot && typeof hostRoot === 'object') {
            for (const key of Object.keys(hostRoot)) {
                if (key.startsWith('_')) continue;
                const h = hostRoot[key];
                if (h && typeof h === 'object') {
                    hosts.push({
                        hostName: h.HostName?._value || 'Perangkat Tanpa Nama',
                        ipAddress: h.IPAddress?._value || '-',
                        macAddress: h.MACAddress?._value || '-',
                        active: Boolean(h.Active?._value),
                        interfaceType: h.InterfaceType?._value || 'Ethernet / WiFi'
                    });
                }
            }
        }

        // Flatten all parameters for parameter explorer
        const allParameters = [];
        const traverse = (obj, prefix = '') => {
            if (!obj || typeof obj !== 'object') return;
            for (const key of Object.keys(obj)) {
                if (key === '_value' || key === '_timestamp' || key === '_type' || key === '_writable' || key === '_object') continue;
                const currentPath = prefix ? `${prefix}.${key}` : key;
                const valObj = obj[key];
                if (valObj && typeof valObj === 'object') {
                    if ('_value' in valObj) {
                        allParameters.push({
                            path: currentPath,
                            value: valObj._value,
                            type: valObj._type || 'xsd:string',
                            writable: Boolean(valObj._writable),
                            timestamp: valObj._timestamp || null
                        });
                    } else {
                        traverse(valObj, currentPath);
                    }
                }
            }
        };
        traverse(d.InternetGatewayDevice, 'InternetGatewayDevice');
        traverse(d.VirtualParameters, 'VirtualParameters');

        return {
            id: deviceId,
            manufacturer,
            model,
            serial,
            hardwareVersion,
            softwareVersion,
            lastInform: lastInformRaw,
            lastInformDate,
            isOnline,
            optical: {
                rxPower,
                rxRaw,
                opticalStatus,
                ponMode,
                temp
            },
            wifi: {
                ssid,
                password: wifiPassword,
                enabled: wifiEnabled,
                channel,
                beaconType
            },
            wan: {
                username: pppUser,
                ip: pppIp,
                mac: pppMac,
                connectionRequestUrl
            },
            credentials: {
                superAdmin,
                superPassword,
                userAdmin,
                userPassword
            },
            activeDevicesCount,
            hosts,
            allParametersCount: allParameters.length,
            allParameters
        };
    }

    /**
     * Cari perangkat (ONT) milik seorang pelanggan di GenieACS.
     * Prioritas pencocokan: Serial ONU -> Username PPPoE pada WAN ONT.
     * @returns {Promise<{raw: object, parsed: object}|null>}
     */
    async findDeviceForCustomer(customer) {
        if (!this.baseUrl) throw new Error('GenieACS belum dikonfigurasi');

        const serial = (customer.onu_serial || '').trim();
        if (serial) {
            const query = JSON.stringify({
                $or: [
                    { '_deviceId._SerialNumber': serial },
                    { 'InternetGatewayDevice.DeviceInfo.SerialNumber._value': serial },
                    { 'VirtualParameters.getSerialNumber._value': serial }
                ]
            });
            const res = await axios.get(`${this.baseUrl}/devices?query=${encodeURIComponent(query)}`, { timeout: 12000 });
            if (Array.isArray(res.data) && res.data.length > 0) {
                return { raw: res.data[0], parsed: this.parseDevice(res.data[0]) };
            }
        }

        const ppp = (customer.pppoe_username || '').trim().toLowerCase();
        if (ppp) {
            const res = await axios.get(`${this.baseUrl}/devices`, { timeout: 20000 });
            for (const raw of (res.data || [])) {
                const parsed = this.parseDevice(raw);
                if ((parsed.wan?.username || '').trim().toLowerCase() === ppp) {
                    return { raw, parsed };
                }
            }
        }
        return null;
    }

    /**
     * Ambil daftar band/SSID WiFi aktif dari data mentah perangkat.
     * @returns {Array<{index:number, ssid:string, enabled:boolean, band:string}>}
     */
    extractWifiBands(raw) {
        const wlans = raw?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
        const bands = [];
        Object.keys(wlans).forEach(key => {
            if (!/^\d+$/.test(key)) return;
            const w = wlans[key] || {};
            const ssid = w.SSID?._value;
            if (!ssid) return;
            const enabled = w.Enable?._value === true || w.Enable?._value === 'true' || w.Enable?._value === 1 || w.Enable?._value === '1';
            if (!enabled) return;
            const idx = parseInt(key, 10);
            const freq = String(w.OperatingFrequencyBand?._value || '');
            const channel = parseInt(w.Channel?._value, 10) || 0;
            let band = '2.4GHz';
            if (/5/.test(freq) || channel > 14 || idx >= 5) band = '5GHz';
            bands.push({ index: idx, ssid: String(ssid), enabled, band });
        });
        return bands.sort((a, b) => a.index - b.index);
    }

    /**
     * Ganti SSID dan/atau sandi WiFi pada satu atau beberapa band (index WLANConfiguration)
     */
    async setWifiBands(id, indexes, { ssid, password }) {
        const parameterValues = [];
        for (const idx of indexes) {
            const base = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}`;
            if (ssid && ssid.trim()) {
                parameterValues.push([`${base}.SSID`, ssid.trim(), 'xsd:string']);
            }
            if (password && password.trim()) {
                parameterValues.push([`${base}.KeyPassphrase`, password.trim(), 'xsd:string']);
                parameterValues.push([`${base}.PreSharedKey.1.PreSharedKey`, password.trim(), 'xsd:string']);
                parameterValues.push([`${base}.BeaconType`, 'WPAand11i', 'xsd:string']);
            }
        }
        if (parameterValues.length === 0) {
            throw new Error('Tidak ada parameter WiFi yang diubah.');
        }
        return await this.addTask(id, { name: 'setParameterValues', parameterValues }, true);
    }

    async getStatus() {
        if (!this.baseUrl) {
            return { configured: false, online: false, devicesCount: 0 };
        }
        try {
            const res = await axios.get(`${this.baseUrl}/devices?projection=_id`, { timeout: 3000 });
            return {
                configured: true,
                online: true,
                url: this.baseUrl,
                devicesCount: Array.isArray(res.data) ? res.data.length : 0
            };
        } catch (e) {
            return {
                configured: true,
                online: false,
                url: this.baseUrl,
                error: e.message
            };
        }
    }
}

module.exports = new GenieACSService();
