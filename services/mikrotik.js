const { RouterOSAPI } = require('node-routeros');
const net = require('net');

class MikroTikService {
    constructor() {
        // Map penyimpan koneksi per router: routerId -> { conn, connected, config, idleTimer }
        this.connections = new Map();
        this.idleTimeoutMs = 20000; // 20 detik idle sebelum otomatis disconnect secara bersih per router
    }

    // Ambil konfigurasi router dari database
    getRouterConfig(routerId = null) {
        const db = require('../database/init');
        let router = null;

        if (routerId) {
            router = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId);
        }

        if (!router) {
            // Ambil router default yang aktif
            router = db.prepare('SELECT * FROM routers WHERE is_default = 1 AND is_active = 1 LIMIT 1').get();
        }

        if (!router) {
            // Ambil router aktif pertama
            router = db.prepare('SELECT * FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
        }

        if (!router) {
            // Fallback ke tabel settings jika tabel routers kosong
            const getSetting = (k) => {
                try {
                    return db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
                } catch (e) {
                    return '';
                }
            };
            const host = getSetting('mikrotik_host');
            if (host) {
                router = {
                    id: 0,
                    name: 'MikroTik Utama',
                    host: host,
                    port: parseInt(getSetting('mikrotik_port'), 10) || 8728,
                    username: getSetting('mikrotik_username') || 'admin',
                    password: getSetting('mikrotik_password') || '',
                    isolir_address_list: getSetting('isolir_address_list') || 'Expired',
                    is_active: 1,
                    is_default: 1
                };
            }
        }

        return router;
    }

    // Ambil daftar semua router dari database
    getAllRouters() {
        const db = require('../database/init');
        try {
            return db.prepare('SELECT * FROM routers ORDER BY is_default DESC, id ASC').all();
        } catch (e) {
            return [];
        }
    }

    // Cek keterjangkauan socket TCP port MikroTik tanpa autentikasi login (0% log spam di RouterOS)
    async testReachability(host = null, port = null, timeoutMs = 1500, routerId = null) {
        if (!host) {
            const cfg = this.getRouterConfig(routerId);
            if (cfg) {
                host = cfg.host;
                port = cfg.port;
            }
        }

        if (!host || !String(host).trim()) return false;

        return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(timeoutMs);

            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('timeout', () => {
                socket.destroy();
                resolve(false);
            });
            socket.once('error', () => {
                socket.destroy();
                resolve(false);
            });

            socket.connect(parseInt(port, 10) || 8728, String(host).trim());
        });
    }

    // Tes koneksi lengkap (login & ambil resource) untuk tombol Uji Koneksi
    async testRouter(routerConfig, timeoutMs = 5000) {
        const host = (routerConfig.host || '').trim();
        const port = parseInt(routerConfig.port, 10) || 8728;
        const user = (routerConfig.username || '').trim();
        const pass = (routerConfig.password || '').trim();

        if (!host || !user) {
            return { success: false, message: 'Host IP dan Username wajib diisi' };
        }

        const isReachable = await this.testReachability(host, port, 2000);
        if (!isReachable) {
            return { success: false, message: `Tidak dapat menjangkau port TCP ${port} pada host ${host}` };
        }

        let testApi = null;
        try {
            testApi = new RouterOSAPI({
                host,
                port,
                user,
                password: pass,
                timeout: Math.ceil(timeoutMs / 1000)
            });

            await testApi.connect();
            const res = await testApi.write('/system/resource/print');
            const identity = await testApi.write('/system/identity/print').catch(() => []);
            await testApi.close().catch(() => {});

            const resData = res && res[0] ? res[0] : {};
            const routerName = identity && identity[0] ? identity[0].name : '';

            return {
                success: true,
                message: `Berhasil terhubung ke ${routerName || host} (ROS v${resData.version || '-'}, Uptime: ${resData.uptime || '-'})`,
                resource: resData,
                identity: routerName
            };
        } catch (err) {
            if (testApi) {
                try { await testApi.close(); } catch (e) {}
            }

            // Deteksi jika port yang diinput kemungkinan adalah port Winbox bukan API
            let extraHint = '';
            const isWinboxPort = [8290, 8291, 8292, 8293, 8294].includes(port);
            
            // Cek port API umum yang aktif (8738, 8788, 8728)
            const candidateApiPorts = [8738, 8788, 8728];
            for (const candPort of candidateApiPorts) {
                if (candPort !== port && await this.testReachability(host, candPort, 800)) {
                    extraHint = ` (Port ${port} terdeteksi sebagai port WinBox. Port API RouterOS yang aktif di router ini adalah port ${candPort}. Silakan ubah Port API menjadi ${candPort}).`;
                    break;
                }
            }

            if (!extraHint && isWinboxPort) {
                extraHint = ` (Perhatian: Port ${port} adalah port WinBox. Sistem memerlukan port service 'api' dari menu WinBox: IP > Services > api, bukan port WinBox).`;
            }

            return { success: false, message: `${err.message}${extraHint}` };
        }
    }

    _resetIdleTimer(routerId) {
        const entry = this.connections.get(routerId);
        if (!entry) return;

        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }

        entry.idleTimer = setTimeout(async () => {
            console.log(`[MikroTik] Idle timeout 30s tercapai untuk Router #${routerId} (${entry.config.name}), memutus sesi koneksi.`);
            await this.disconnect(routerId);
        }, this.idleTimeoutMs);
    }

    _clearIdleTimer(routerId) {
        const entry = this.connections.get(routerId);
        if (entry && entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
    }

    // Mendapatkan koneksi aktif untuk routerId tertentu atau default
    async getConnection(routerId = null, throwOnError = false) {
        const cfg = this.getRouterConfig(routerId);
        if (!cfg || !cfg.host || !cfg.username) {
            if (throwOnError) throw new Error('Konfigurasi router MikroTik belum tersedia');
            return null;
        }

        const effectiveId = cfg.id;
        let entry = this.connections.get(effectiveId);

        if (entry && entry.connected && entry.conn && entry.conn.connected === true) {
            this._resetIdleTimer(effectiveId);
            return entry;
        }

        // Jika ada koneksi lama yang mati/setengah mati, tutup dulu
        if (entry) {
            await this.disconnect(effectiveId);
        }

        try {
            const api = new RouterOSAPI({
                host: (cfg.host || '').trim(),
                user: (cfg.username || '').trim(),
                password: (cfg.password || '').trim(),
                port: parseInt(cfg.port, 10) || 8728,
                timeout: 30
            });

            api.on('error', (err) => {
                console.warn(`[MikroTik Router #${effectiveId} Error]:`, err.message);
                const curr = this.connections.get(effectiveId);
                if (curr) curr.connected = false;
            });
            api.on('close', () => {
                const curr = this.connections.get(effectiveId);
                if (curr) curr.connected = false;
            });
            api.on('end', () => {
                const curr = this.connections.get(effectiveId);
                if (curr) curr.connected = false;
            });

            await api.connect();

            entry = {
                routerId: effectiveId,
                config: cfg,
                conn: api,
                connected: true,
                idleTimer: null
            };

            this.connections.set(effectiveId, entry);
            this._resetIdleTimer(effectiveId);

            return entry;
        } catch (error) {
            this.connections.delete(effectiveId);
            if (throwOnError) throw error;
            return null;
        }
    }

    // Kompatibilitas connect eksplisit
    async connect(host, port, username, password, routerId = null) {
        const cfg = this.getRouterConfig(routerId) || {
            id: routerId || 0,
            name: 'MikroTik',
            host, port, username, password
        };
        cfg.host = host;
        cfg.port = port;
        cfg.username = username;
        cfg.password = password;

        if (this.connections.has(cfg.id)) {
            await this.disconnect(cfg.id);
        }

        const entry = await this.getConnection(cfg.id, true);
        return !!(entry && entry.connected);
    }

    async ensureConnection(throwOnError = false, routerId = null) {
        const entry = await this.getConnection(routerId, throwOnError);
        return !!(entry && entry.connected);
    }

    async disconnect(routerId = null) {
        if (routerId !== null && routerId !== undefined) {
            const entry = this.connections.get(routerId);
            if (entry) {
                this._clearIdleTimer(routerId);
                if (entry.conn) {
                    try { await entry.conn.close(); } catch (e) {}
                }
                this.connections.delete(routerId);
            }
        } else {
            // Disconnect semua router
            for (const [id, entry] of this.connections.entries()) {
                this._clearIdleTimer(id);
                if (entry.conn) {
                    try { await entry.conn.close(); } catch (e) {}
                }
            }
            this.connections.clear();
        }
    }

    isConnected(routerId = null) {
        const cfg = this.getRouterConfig(routerId);
        if (!cfg) return false;
        const entry = this.connections.get(cfg.id);
        return !!(entry && entry.connected && entry.conn && entry.conn.connected === true);
    }

    // Helper write terpadu untuk router tertentu
    async write(menu, words = [], routerId = null) {
        const entry = await this.getConnection(routerId, true);
        if (!entry || !entry.conn) throw new Error('Tidak dapat terhubung ke router MikroTik');

        const effectiveId = entry.routerId;
        this._resetIdleTimer(effectiveId);

        try {
            return await entry.conn.write(menu, words);
        } catch (err) {
            if (err.message && (err.message.includes('not connected') || err.message.includes('closed') || err.message.includes('timeout'))) {
                console.warn(`[MikroTik Router #${effectiveId}] Koneksi terputus saat write, mencoba reconnect...`, err.message);
                await this.disconnect(effectiveId);
                const fresh = await this.getConnection(effectiveId, true);
                this._resetIdleTimer(effectiveId);
                return await fresh.conn.write(menu, words);
            }
            throw err;
        }
    }

    // ============================================
    // Firewall Address List (Fitur Isolir Pelanggan)
    // ============================================

    async getAddressList(listName = null, routerId = null) {
        const cfg = this.getRouterConfig(routerId);
        const effectiveList = listName || (cfg ? cfg.isolir_address_list : null) || 'Expired';
        const query = effectiveList ? [`?list=${effectiveList}`] : [];
        return await this.write('/ip/firewall/address-list/print', query, routerId);
    }

    async addAddressList(address, listName = null, comment = '', routerId = null) {
        if (!address) return null;
        const cleanIp = String(address).replace(/\/.*$/, '').trim();
        if (!cleanIp) return null;

        const cfg = this.getRouterConfig(routerId);
        const effectiveListName = listName || (cfg ? cfg.isolir_address_list : null) || 'Expired';
        const safeComment = comment ? String(comment).replace(/[\r\n\t]+/g, ' ').substring(0, 80).trim() : '';

        // Cek jika sudah terdaftar di router
        const existing = await this.write('/ip/firewall/address-list/print', [
            `?list=${effectiveListName}`,
            `?address=${cleanIp}`
        ], routerId);

        if (existing && existing.length > 0) {
            if (existing[0].disabled === 'true' || existing[0].disabled === true) {
                await this.write('/ip/firewall/address-list/set', [
                    `=.id=${existing[0]['.id']}`,
                    '=disabled=no'
                ], routerId);
            }
            if (safeComment && existing[0].comment !== safeComment) {
                await this.write('/ip/firewall/address-list/set', [
                    `=.id=${existing[0]['.id']}`,
                    `=comment=${safeComment}`
                ], routerId).catch(() => {});
            }
            return existing[0];
        }

        const params = [
            `=list=${effectiveListName}`,
            `=address=${cleanIp}`
        ];
        if (safeComment) {
            params.push(`=comment=${safeComment}`);
        }

        return await this.write('/ip/firewall/address-list/add', params, routerId);
    }

    async removeAddressList(address, listName = null, customerIdOrComment = null, routerId = null) {
        const cfg = this.getRouterConfig(routerId);
        const effectiveListName = listName || (cfg ? cfg.isolir_address_list : null) || 'Expired';
        let foundIds = new Set();

        if (address) {
            const cleanIp = String(address).replace(/\/.*$/, '').trim();
            if (cleanIp) {
                const byIp = await this.write('/ip/firewall/address-list/print', [
                    `?list=${effectiveListName}`,
                    `?address=${cleanIp}`
                ], routerId);
                for (const item of (byIp || [])) {
                    if (item['.id']) foundIds.add(item['.id']);
                }
            }
        }

        if (customerIdOrComment) {
            const pattern = String(customerIdOrComment).trim();
            if (pattern) {
                const listEntries = await this.write('/ip/firewall/address-list/print', [
                    `?list=${effectiveListName}`
                ], routerId);
                for (const item of (listEntries || [])) {
                    if (item.comment && item.comment.includes(pattern)) {
                        if (item['.id']) foundIds.add(item['.id']);
                    }
                }
            }
        }

        for (const id of foundIds) {
            await this.write('/ip/firewall/address-list/remove', [`=.id=${id}`], routerId);
        }
        return true;
    }

    /**
     * Cari Simple Queue milik pelanggan IP Statik secara cerdas:
     * 1. Berdasarkan target IP (misal: 172.16.5.168/32)
     * 2. Berdasarkan nama pelanggan (case-insensitive / uppercase MikroTik)
     * 3. Berdasarkan kode customer_id (CUST-xxxx)
     */
    async findQueueForCustomer(customer, routerId = null) {
        try {
            const queues = await this.getSimpleQueues(routerId);
            if (!queues || queues.length === 0) return null;

            const cleanIp = customer.ip_address ? String(customer.ip_address).replace(/\/.*$/, '').trim() : null;
            const custName = customer.name ? customer.name.trim().toLowerCase() : null;
            const custCode = customer.customer_id ? customer.customer_id.trim().toLowerCase() : null;

            // 1. Cocokkan target IP
            if (cleanIp) {
                const byTarget = queues.find(q => {
                    if (!q.target) return false;
                    const targets = q.target.split(',').map(t => t.replace(/\/.*$/, '').trim());
                    return targets.includes(cleanIp);
                });
                if (byTarget) return byTarget;
            }

            // 2. Cocokkan nama queue dengan nama pelanggan
            if (custName) {
                const byName = queues.find(q => {
                    if (!q.name) return false;
                    const qn = q.name.trim().toLowerCase();
                    return qn === custName || qn.includes(custName) || custName.includes(qn);
                });
                if (byName) return byName;
            }

            // 3. Cocokkan dengan customer_id
            if (custCode) {
                const byCode = queues.find(q => q.name && q.name.toLowerCase().includes(custCode));
                if (byCode) return byCode;
            }
        } catch (e) {
            console.warn('[MikroTik] Gagal mencari simple queue pelanggan:', e.message);
        }
        return null;
    }

    /**
     * Isolir pelanggan secara terpadu di MikroTik:
     * - Deteksi IP (Active Connection -> DB -> PPPoE Secret remote-address -> DHCP Lease -> ARP)
     * - Simpan IP ke database customers jika ditemukan
     * - Tambahkan ke firewall address-list (Expired)
     * - Kick koneksi PPPoE aktif agar firewall langsung menjerat
     * - Disable Simple Queue jika static
     * - Update status di DB menjadi 'suspended'
     */
    async isolateCustomer(customer, reason = null) {
        if (!customer) return { success: false, message: 'Data pelanggan tidak valid' };

        let routerId = customer.router_id || null;
        let targetIp = null;
        const allCustomerIps = new Set();

        // Tambahkan IP yang tersimpan di database jika ada
        if (customer.ip_address) {
            const clean = String(customer.ip_address).replace(/\/.*$/, '').trim();
            if (clean) {
                targetIp = clean;
                allCustomerIps.add(clean);
            }
        }

        // 1. Cek dari koneksi aktif PPPoE jika PPPoE
        if (customer.pppoe_username) {
            try {
                const activeConn = await this.findActiveConnectionByName(customer.pppoe_username, routerId);
                if (activeConn && activeConn.address) {
                    const activeIp = String(activeConn.address).replace(/\/.*$/, '').trim();
                    if (activeIp) {
                        targetIp = activeIp;
                        allCustomerIps.add(activeIp);
                    }
                }
            } catch (e) {}
        }

        // 2. Cek dari remote-address di PPPoE secret
        if (customer.pppoe_username) {
            try {
                const secret = await this.findSecretByName(customer.pppoe_username, routerId);
                if (secret && secret['remote-address']) {
                    const secretIp = String(secret['remote-address']).replace(/\/.*$/, '').trim();
                    if (secretIp) {
                        if (!targetIp) targetIp = secretIp;
                        allCustomerIps.add(secretIp);
                    }
                }
            } catch (e) {}
        }

        // 3. Cek dari DHCP server leases jika belum ada IP
        if (!targetIp) {
            try {
                const leases = await this.write('/ip/dhcp-server/lease/print', [], routerId);
                if (leases && leases.length > 0) {
                    const match = leases.find(l => 
                        (customer.mac_address && l['mac-address'] && l['mac-address'].toLowerCase() === customer.mac_address.toLowerCase()) ||
                        (customer.name && l.comment && l.comment.toLowerCase().includes(customer.name.toLowerCase())) ||
                        (customer.customer_id && l.comment && l.comment.includes(customer.customer_id))
                    );
                    if (match && match.address) {
                        const leaseIp = String(match.address).replace(/\/.*$/, '').trim();
                        if (leaseIp) {
                            targetIp = leaseIp;
                            allCustomerIps.add(leaseIp);
                        }
                    }
                }
            } catch (e) {}
        }

        // 4. Cek dari ARP table jika belum ada IP
        if (!targetIp && customer.mac_address) {
            try {
                const arps = await this.write('/ip/arp/print', [
                    `?mac-address=${customer.mac_address}`
                ], routerId);
                if (arps && arps.length > 0 && arps[0].address) {
                    const arpIp = String(arps[0].address).replace(/\/.*$/, '').trim();
                    if (arpIp) {
                        targetIp = arpIp;
                        allCustomerIps.add(arpIp);
                    }
                }
            } catch (e) {}
        }

        const db = require('../database/init');

        // 5. Simpan IP yang ditemukan ke tabel customers jika sebelumnya kosong atau berbeda
        if (targetIp && customer.id && (!customer.ip_address || String(customer.ip_address).trim() !== targetIp)) {
            try {
                db.prepare('UPDATE customers SET ip_address = ? WHERE id = ?').run(targetIp, customer.id);
            } catch (e) {}
        }

        // 6. Ubah status customer di database menjadi suspended
        if (customer.id && customer.status !== 'suspended') {
            try {
                db.prepare("UPDATE customers SET status = 'suspended', updated_at = datetime('now') WHERE id = ?").run(customer.id);
            } catch (e) {}
        }

        const cfg = this.getRouterConfig(routerId);
        const listName = (cfg ? cfg.isolir_address_list : null) || 'Expired';

        // 7. Masukkan IP ke firewall address-list MikroTik
        if (targetIp || allCustomerIps.size > 0) {
            const comment = reason || `Isolir: ${customer.name || customer.customer_id}`;
            const ipsToAdd = allCustomerIps.size > 0 ? Array.from(allCustomerIps) : [targetIp];

            for (const ip of ipsToAdd) {
                await this.addAddressList(ip, listName, comment, routerId);
                console.log(`[MikroTik Router #${routerId || 'default'}] Pelanggan ${customer.name} (${ip}) dimasukkan ke address-list ${listName}`);
            }

            // Kick active PPPoE connection jika PPPoE agar koneksi terputus dan langsung kena filter isolir
            if (customer.pppoe_username) {
                try {
                    await this.kickActiveConnection(customer.pppoe_username, routerId);
                } catch (e) {}
            }

            // Jika tipe static (atau tanpa pppoe_username), cari dan nonaktifkan Simple Queue
            if (customer.connection_type === 'static' || !customer.pppoe_username) {
                try {
                    const queue = await this.findQueueForCustomer(customer, routerId);
                    if (queue && queue['.id']) {
                        await this.disableSimpleQueue(queue['.id'], routerId);
                        console.log(`[MikroTik Router #${routerId || 'default'}] Simple queue "${queue.name}" dinonaktifkan (Isolir static: ${customer.name})`);
                    }
                } catch (e) {}
            }

            return { success: true, ip: targetIp, listName, routerId };
        } else {
            const msg = `IP pelanggan "${customer.name}" belum terdeteksi. Silakan lengkapi IP di data pelanggan.`;
            console.warn(`[MikroTik Router #${routerId || 'default'}] ${msg}`);
            return { success: false, message: msg, routerId };
        }
    }

    /**
     * Buka Isolir pelanggan secara terpadu di MikroTik:
     * - Deteksi IP
     * - Hapus dari firewall address-list (Expired)
     * - Enable kembali PPPoE secret jika sempat disabled
     * - Kick koneksi PPPoE aktif agar koneksi baru langsung bersih
     * - Enable kembali Simple Queue jika static
     * - Update status di DB menjadi 'active'
     */
    async unIsolateCustomer(customer) {
        if (!customer) return { success: false, message: 'Data pelanggan tidak valid' };

        const routerId = customer.router_id || null;
        const cfg = this.getRouterConfig(routerId);
        const listName = (cfg ? cfg.isolir_address_list : null) || 'Expired';

        const allCustomerIps = new Set();
        let targetIp = customer.ip_address ? String(customer.ip_address).trim() : null;
        if (targetIp) allCustomerIps.add(targetIp);

        if (customer.pppoe_username) {
            try {
                const activeConn = await this.findActiveConnectionByName(customer.pppoe_username, routerId);
                if (activeConn && activeConn.address) {
                    const aIp = String(activeConn.address).trim();
                    allCustomerIps.add(aIp);
                    if (!targetIp) targetIp = aIp;
                }
            } catch (e) {}
        }

        if (customer.pppoe_username) {
            try {
                const secret = await this.findSecretByName(customer.pppoe_username, routerId);
                if (secret && secret['remote-address']) {
                    const sIp = String(secret['remote-address']).trim();
                    allCustomerIps.add(sIp);
                    if (!targetIp) targetIp = sIp;
                }
            } catch (e) {}
        }

        const db = require('../database/init');
        if (customer.id && customer.status !== 'active') {
            try {
                db.prepare("UPDATE customers SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(customer.id);
            } catch (e) {}
        }

        // Hapus semua IP pelanggan dari address-list
        const ipsToRemove = allCustomerIps.size > 0 ? Array.from(allCustomerIps) : (targetIp ? [targetIp] : []);
        for (const ip of ipsToRemove) {
            await this.removeAddressList(ip, listName, customer.customer_id, routerId);
        }
        if (customer.customer_id) {
            await this.removeAddressList(null, listName, customer.customer_id, routerId);
        }
        console.log(`[MikroTik Router #${routerId || 'default'}] Pelanggan ${customer.name} dihapus dari address-list ${listName}`);

        // Re-enable PPPoE secret jika sempat disabled dan kick koneksi aktif
        if (customer.pppoe_username) {
            try {
                const secret = await this.findSecretByName(customer.pppoe_username, routerId);
                if (secret && (secret.disabled === 'true' || secret.disabled === true)) {
                    await this.enablePPPoESecret(secret['.id'], routerId);
                }
                // Kick session agar terhubung ulang secara fresh tanpa status isolir
                await this.kickActiveConnection(customer.pppoe_username, routerId);
            } catch (e) {}
        }

        // Re-enable Simple Queue jika static
        if (customer.connection_type === 'static' || !customer.pppoe_username) {
            try {
                const queue = await this.findQueueForCustomer(customer, routerId);
                if (queue && queue['.id']) {
                    await this.enableSimpleQueue(queue['.id'], routerId);
                    console.log(`[MikroTik Router #${routerId || 'default'}] Simple queue "${queue.name}" diaktifkan kembali (Buka isolir static: ${customer.name})`);
                }
            } catch (e) {}
        }

        return { success: true, ip: targetIp, listName, routerId };
    }

    // ============================================
    // PPPoE Secret & Profile Management
    // ============================================

    async getPPPoESecrets(routerId = null) {
        return await this.write('/ppp/secret/print', [], routerId);
    }

    async addPPPoESecret(name, password, profile, service = 'pppoe', routerId = null) {
        return await this.write('/ppp/secret/add', [
            `=name=${name}`,
            `=password=${password}`,
            `=service=${service}`,
            `=profile=${profile}`
        ], routerId);
    }

    async removePPPoESecret(id, routerId = null) {
        return await this.write('/ppp/secret/remove', [`=.id=${id}`], routerId);
    }

    async disablePPPoESecret(id, routerId = null) {
        return await this.write('/ppp/secret/set', [`=.id=${id}`, '=disabled=yes'], routerId);
    }

    async enablePPPoESecret(id, routerId = null) {
        return await this.write('/ppp/secret/set', [`=.id=${id}`, '=disabled=no'], routerId);
    }

    async getActiveConnections(routerId = null) {
        return await this.write('/ppp/active/print', [], routerId);
    }

    async getProfiles(routerId = null) {
        return await this.write('/ppp/profile/print', [], routerId);
    }

    async addProfile(name, rateLimit, routerId = null) {
        return await this.write('/ppp/profile/add', [
            `=name=${name}`,
            `=rate-limit=${rateLimit}`
        ], routerId);
    }

    async getSystemResource(routerId = null) {
        const result = await this.write('/system/resource/print', [], routerId);
        return result && result[0] ? result[0] : {};
    }

    async getInterfaces(routerId = null) {
        return await this.write('/interface/print', [], routerId);
    }

    // ============================================
    // Simple Queue (IP Statik)
    // ============================================

    async getSimpleQueues(routerId = null) {
        return await this.write('/queue/simple/print', [], routerId);
    }

    async addSimpleQueue(name, targetIp, maxLimit, routerId = null) {
        return await this.write('/queue/simple/add', [
            `=name=${name}`,
            `=target=${targetIp}`,
            `=max-limit=${maxLimit}`
        ], routerId);
    }

    async removeSimpleQueue(id, routerId = null) {
        return await this.write('/queue/simple/remove', [`=.id=${id}`], routerId);
    }

    async disableSimpleQueue(id, routerId = null) {
        return await this.write('/queue/simple/set', [`=.id=${id}`, '=disabled=yes'], routerId);
    }

    async enableSimpleQueue(id, routerId = null) {
        return await this.write('/queue/simple/set', [`=.id=${id}`, '=disabled=no'], routerId);
    }

    async findQueueByName(name, routerId = null) {
        const queues = await this.write('/queue/simple/print', [`?name=${name}`], routerId);
        return queues && queues.length > 0 ? queues[0] : null;
    }

    async findSecretByName(name, routerId = null) {
        const secrets = await this.write('/ppp/secret/print', [`?name=${name}`], routerId);
        return secrets && secrets.length > 0 ? secrets[0] : null;
    }

    async findActiveConnectionByName(name, routerId = null) {
        const active = await this.write('/ppp/active/print', [`?name=${name}`], routerId);
        return active && active.length > 0 ? active[0] : null;
    }

    async kickActiveConnection(name, routerId = null) {
        try {
            const active = await this.findActiveConnectionByName(name, routerId);
            if (active && active['.id']) {
                await this.write('/ppp/active/remove', [`=.id=${active['.id']}`], routerId);
                return true;
            }
        } catch (e) {}
        return false;
    }

    async disconnectAll() {
        for (const [id, entry] of this.connections.entries()) {
            try {
                if (entry.idleTimer) clearTimeout(entry.idleTimer);
                if (entry.conn) await entry.conn.close();
            } catch (e) {}
        }
        this.connections.clear();
        return true;
    }

    getStatus() {
        const routers = this.getAllRouters();
        let connectedCount = 0;
        routers.forEach(r => {
            const entry = this.connections.get(r.id);
            if (entry && entry.connected) connectedCount++;
        });
        return {
            totalRouters: routers.length,
            connectedRouters: connectedCount,
            activeConnections: this.connections.size
        };
    }
}

module.exports = new MikroTikService();
