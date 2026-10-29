/**
 * Service: Rekap Pengerjaan Teknisi (Hari Ini, Minggu Ini, Bulan Ini, & Custom Range)
 * Menghitung jumlah tiket yang berhasil diselesaikan ("beres") oleh masing-masing teknisi
 * baik untuk Tiket Gangguan (tickets) maupun Tiket Pemasangan Baru / PSB (psb_tickets).
 */

const moment = require('moment');

/**
 * Hitung rekap pengerjaan teknisi untuk periode Hari Ini, Minggu Ini, Bulan Ini, dan Custom Range
 * @param {object} db - Instance better-sqlite3
 * @param {object} options - { range: 'today'|'week'|'month'|'custom', startDate, endDate, technicianId }
 */
function getTechnicianWorkRecap(db, options = {}) {
    const now = moment();
    const todayStr = now.format('YYYY-MM-DD');

    // Senin s/d Minggu pada minggu berjalan
    const weekStart = now.clone().startOf('isoWeek');
    const weekEnd = now.clone().endOf('isoWeek');
    const weekStartStr = weekStart.format('YYYY-MM-DD');
    const weekEndStr = weekEnd.format('YYYY-MM-DD');

    // Awal s/d Akhir bulan berjalan
    const monthStart = now.clone().startOf('month');
    const monthEnd = now.clone().endOf('month');
    const monthStartStr = monthStart.format('YYYY-MM-DD');
    const monthEndStr = monthEnd.format('YYYY-MM-DD');

    // Tentukan filter range aktif
    let selectedRange = (options.range || 'today').toLowerCase();
    if (!['today', 'week', 'month', 'custom'].includes(selectedRange)) {
        selectedRange = 'today';
    }

    let selStartStr = todayStr;
    let selEndStr = todayStr;
    let selLabel = 'Hari Ini';
    let selSubLabel = now.format('DD MMM YYYY');

    if (selectedRange === 'today') {
        selStartStr = todayStr;
        selEndStr = todayStr;
        selLabel = 'Hari Ini';
        selSubLabel = now.format('DD MMM YYYY');
    } else if (selectedRange === 'week') {
        selStartStr = weekStartStr;
        selEndStr = weekEndStr;
        selLabel = 'Minggu Ini';
        selSubLabel = `${weekStart.format('DD MMM')} - ${weekEnd.format('DD MMM YYYY')}`;
    } else if (selectedRange === 'month') {
        selStartStr = monthStartStr;
        selEndStr = monthEndStr;
        selLabel = 'Bulan Ini';
        selSubLabel = now.format('MMMM YYYY');
    } else if (selectedRange === 'custom') {
        const validStart = options.startDate && /^\d{4}-\d{2}-\d{2}$/.test(options.startDate)
            ? options.startDate
            : monthStartStr;
        const validEnd = options.endDate && /^\d{4}-\d{2}-\d{2}$/.test(options.endDate)
            ? options.endDate
            : todayStr;

        if (validStart <= validEnd) {
            selStartStr = validStart;
            selEndStr = validEnd;
        } else {
            selStartStr = validEnd;
            selEndStr = validStart;
        }
        selLabel = 'Rentang Tanggal';
        selSubLabel = `${moment(selStartStr).format('DD MMM YYYY')} - ${moment(selEndStr).format('DD MMM YYYY')}`;
    }

    // Ambil daftar semua teknisi dari tabel technicians
    let technicians = [];
    try {
        technicians = db.prepare('SELECT * FROM technicians ORDER BY is_active DESC, name ASC').all();
    } catch (e) {
        technicians = [];
    }

    // Ambil semua tiket gangguan
    let allTickets = [];
    try {
        allTickets = db.prepare(`
            SELECT t.*, c.customer_id as customer_code
            FROM tickets t
            LEFT JOIN customers c ON t.customer_id = c.id
            ORDER BY COALESCE(t.resolved_at, t.updated_at, t.created_at) DESC
        `).all();
    } catch (e) {
        allTickets = [];
    }

    // Ambil semua tiket PSB (Pemasangan Baru)
    let allPsb = [];
    try {
        allPsb = db.prepare(`
            SELECT p.*, pkg.name as package_name
            FROM psb_tickets p
            LEFT JOIN packages pkg ON p.package_id = pkg.id
            ORDER BY COALESCE(p.completed_at, p.updated_at, p.created_at) DESC
        `).all();
    } catch (e) {
        allPsb = [];
    }

    // Map per teknisi (key: 'id:X' atau 'name:nama')
    const techMap = new Map();
    const nameToKeyMap = new Map();

    function createEmptyTechStat(techObj) {
        return {
            key: techObj.key,
            id: techObj.id || null,
            name: techObj.name || 'Teknisi Umum / Belum Ditentukan',
            username: techObj.username || '-',
            phone: techObj.phone || '-',
            role: techObj.role || 'Teknisi Lapangan',
            is_active: techObj.is_active !== undefined ? techObj.is_active : 1,
            today: { gangguan: 0, psb: 0, total: 0 },
            week: { gangguan: 0, psb: 0, total: 0 },
            month: { gangguan: 0, psb: 0, total: 0 },
            selected: { gangguan: 0, psb: 0, total: 0 },
            allTime: { gangguan: 0, psb: 0, total: 0 },
            active: { gangguan: 0, psb: 0, total: 0 }
        };
    }

    for (const tech of technicians) {
        const key = `id:${tech.id}`;
        techMap.set(key, createEmptyTechStat({
            key,
            id: tech.id,
            name: tech.name,
            username: tech.username,
            phone: tech.phone,
            role: tech.role,
            is_active: tech.is_active
        }));
        if (tech.name) {
            nameToKeyMap.set(tech.name.trim().toLowerCase(), key);
        }
    }

    function resolveTechEntry(techId, techName, techPhone) {
        if (techId && techMap.has(`id:${techId}`)) {
            return techMap.get(`id:${techId}`);
        }
        const cleanName = (techName || '').trim();
        if (cleanName) {
            const lower = cleanName.toLowerCase();
            if (nameToKeyMap.has(lower)) {
                return techMap.get(nameToKeyMap.get(lower));
            }
            const adhocKey = `name:${lower}`;
            if (!techMap.has(adhocKey)) {
                techMap.set(adhocKey, createEmptyTechStat({
                    key: adhocKey,
                    id: null,
                    name: cleanName,
                    username: '-',
                    phone: techPhone || '-',
                    role: 'Teknisi',
                    is_active: 1
                }));
                nameToKeyMap.set(lower, adhocKey);
            }
            return techMap.get(adhocKey);
        }
        const unassignedKey = 'unassigned';
        if (!techMap.has(unassignedKey)) {
            techMap.set(unassignedKey, createEmptyTechStat({
                key: unassignedKey,
                id: null,
                name: 'Tim Teknisi (Umum)',
                username: '-',
                phone: '-',
                role: 'Tim Lapangan',
                is_active: 1
            }));
        }
        return techMap.get(unassignedKey);
    }

    // Ringkasan Global
    const summary = {
        today: {
            gangguan: 0,
            psb: 0,
            total: 0,
            label: 'Hari Ini',
            subLabel: now.format('DD MMM YYYY'),
            startDate: todayStr,
            endDate: todayStr
        },
        week: {
            gangguan: 0,
            psb: 0,
            total: 0,
            label: 'Minggu Ini',
            subLabel: `${weekStart.format('DD MMM')} - ${weekEnd.format('DD MMM YYYY')}`,
            startDate: weekStartStr,
            endDate: weekEndStr
        },
        month: {
            gangguan: 0,
            psb: 0,
            total: 0,
            label: 'Bulan Ini',
            subLabel: now.format('MMMM YYYY'),
            startDate: monthStartStr,
            endDate: monthEndStr
        },
        selected: {
            range: selectedRange,
            gangguan: 0,
            psb: 0,
            total: 0,
            label: selLabel,
            subLabel: selSubLabel,
            startDate: selStartStr,
            endDate: selEndStr
        },
        allTime: {
            gangguan: 0,
            psb: 0,
            total: 0
        },
        activeWork: {
            gangguan: 0,
            psb: 0,
            total: 0
        }
    };

    const completedItems = [];

    // 1. Proses Tiket Gangguan
    for (const t of allTickets) {
        const entry = resolveTechEntry(t.technician_id, t.technician_name, t.technician_phone);

        if (t.status === 'resolved') {
            const rawDoneAt = t.resolved_at || t.updated_at || t.created_at;
            const doneMoment = rawDoneAt ? moment(rawDoneAt) : now;
            const doneDateStr = doneMoment.isValid() ? doneMoment.format('YYYY-MM-DD') : todayStr;

            const inToday = doneDateStr === todayStr;
            const inWeek = doneDateStr >= weekStartStr && doneDateStr <= weekEndStr;
            const inMonth = doneDateStr >= monthStartStr && doneDateStr <= monthEndStr;
            const inSelected = doneDateStr >= selStartStr && doneDateStr <= selEndStr;

            // Update global summary
            summary.allTime.gangguan++;
            summary.allTime.total++;
            entry.allTime.gangguan++;
            entry.allTime.total++;

            if (inToday) {
                summary.today.gangguan++;
                summary.today.total++;
                entry.today.gangguan++;
                entry.today.total++;
            }
            if (inWeek) {
                summary.week.gangguan++;
                summary.week.total++;
                entry.week.gangguan++;
                entry.week.total++;
            }
            if (inMonth) {
                summary.month.gangguan++;
                summary.month.total++;
                entry.month.gangguan++;
                entry.month.total++;
            }
            if (inSelected) {
                summary.selected.gangguan++;
                summary.selected.total++;
                entry.selected.gangguan++;
                entry.selected.total++;
            }

            completedItems.push({
                type: 'gangguan',
                typeLabel: 'Tiket Gangguan',
                badgeClass: 'bg-danger',
                id: t.id,
                number: t.ticket_number,
                detailUrl: `/tickets/${t.id}`,
                customerName: t.customer_name || '-',
                customerCode: t.customer_code || '-',
                customerPhone: t.customer_phone || '-',
                customerAddress: t.customer_address || '-',
                categoryOrPackage: t.category || 'Gangguan Internet',
                subject: t.subject || t.description || '-',
                notes: t.resolution_notes || t.description || '-',
                technicianId: entry.id,
                technicianKey: entry.key,
                technicianName: entry.name,
                technicianPhone: t.technician_phone || entry.phone || '-',
                completedAt: rawDoneAt,
                completedDate: doneDateStr,
                inToday,
                inWeek,
                inMonth,
                inSelected
            });
        } else {
            // Tiket masih aktif (open / accepted / in_progress)
            summary.activeWork.gangguan++;
            summary.activeWork.total++;
            if (t.technician_id || t.technician_name) {
                entry.active.gangguan++;
                entry.active.total++;
            }
        }
    }

    // 2. Proses Tiket PSB (Pemasangan Baru)
    for (const p of allPsb) {
        const entry = resolveTechEntry(p.technician_id, p.technician_name, p.technician_phone);

        if (p.status === 'completed') {
            const rawDoneAt = p.completed_at || p.updated_at || p.created_at;
            const doneMoment = rawDoneAt ? moment(rawDoneAt) : now;
            const doneDateStr = doneMoment.isValid() ? doneMoment.format('YYYY-MM-DD') : todayStr;

            const inToday = doneDateStr === todayStr;
            const inWeek = doneDateStr >= weekStartStr && doneDateStr <= weekEndStr;
            const inMonth = doneDateStr >= monthStartStr && doneDateStr <= monthEndStr;
            const inSelected = doneDateStr >= selStartStr && doneDateStr <= selEndStr;

            summary.allTime.psb++;
            summary.allTime.total++;
            entry.allTime.psb++;
            entry.allTime.total++;

            if (inToday) {
                summary.today.psb++;
                summary.today.total++;
                entry.today.psb++;
                entry.today.total++;
            }
            if (inWeek) {
                summary.week.psb++;
                summary.week.total++;
                entry.week.psb++;
                entry.week.total++;
            }
            if (inMonth) {
                summary.month.psb++;
                summary.month.total++;
                entry.month.psb++;
                entry.month.total++;
            }
            if (inSelected) {
                summary.selected.psb++;
                summary.selected.total++;
                entry.selected.psb++;
                entry.selected.total++;
            }

            completedItems.push({
                type: 'psb',
                typeLabel: 'Pasang Baru (PSB)',
                badgeClass: 'bg-primary',
                id: p.id,
                number: p.psb_number,
                detailUrl: `/psb/${p.id}`,
                customerName: p.customer_name || '-',
                customerCode: 'PSB Baru',
                customerPhone: p.customer_phone || '-',
                customerAddress: p.customer_address || '-',
                categoryOrPackage: p.package_name ? `Paket ${p.package_name}` : 'Pemasangan Baru',
                subject: `Instalasi ${p.connection_type ? p.connection_type.toUpperCase() : 'PPPoE'}`,
                notes: p.notes || 'Instalasi & aktivasi pelanggan baru selesai',
                technicianId: entry.id,
                technicianKey: entry.key,
                technicianName: entry.name,
                technicianPhone: p.technician_phone || entry.phone || '-',
                completedAt: rawDoneAt,
                completedDate: doneDateStr,
                inToday,
                inWeek,
                inMonth,
                inSelected
            });
        } else {
            summary.activeWork.psb++;
            summary.activeWork.total++;
            if (p.technician_id || p.technician_name) {
                entry.active.psb++;
                entry.active.total++;
            }
        }
    }

    // Urutkan completedItems berdasarkan waktu selesai terbaru
    completedItems.sort((a, b) => {
        const tA = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        const tB = b.completedAt ? new Date(b.completedAt).getTime() : 0;
        return tB - tA;
    });

    // Konversi techMap menjadi array dan urutkan berdasarkan performa
    const perTechnician = Array.from(techMap.values())
        .filter(item => item.key !== 'unassigned' || item.allTime.total > 0 || item.active.total > 0)
        .sort((a, b) => {
            if (b.selected.total !== a.selected.total) return b.selected.total - a.selected.total;
            if (b.month.total !== a.month.total) return b.month.total - a.month.total;
            if (b.week.total !== a.week.total) return b.week.total - a.week.total;
            if (b.today.total !== a.today.total) return b.today.total - a.today.total;
            return (a.name || '').localeCompare(b.name || '');
        });

    return {
        summary,
        perTechnician,
        completedItems,
        filters: {
            range: selectedRange,
            startDate: selStartStr,
            endDate: selEndStr
        }
    };
}

module.exports = {
    getTechnicianWorkRecap
};
