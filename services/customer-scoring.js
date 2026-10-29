// Service: Customer Payment Scoring & Ranking
// Menghitung skor kedisiplinan pembayaran pelanggan berdasarkan tanggal pembayaran tagihan:
// 1. Sebelum Tanggal 1 atau pas Tanggal 1 -> "Pelanggan Loyal" (Emas Bersinar-sinar)
// 2. Tanggal 2 s/d Tanggal 5              -> "Pelanggan Disiplin"
// 3. Tanggal 6 s/d Tanggal 8              -> "Pelanggan Tepat Waktu"
// 4. Lewat Tanggal 8 (Tgl 9 dst / Nunggak)-> "Pelanggan Macet"

const moment = require('moment');
try { require('moment/locale/id'); moment.locale('id'); } catch (e) {}

const TIER_DEFINITIONS = {
    loyal: {
        key: 'loyal',
        order: 1,
        label: 'Pelanggan Loyal',
        shortLabel: 'Loyal (≤ Tgl 1)',
        ruleText: 'Bayar sebelum atau tepat Tanggal 1',
        description: 'Luar biasa! Anda selalu membayar tagihan internet sebelum atau tepat pada Tanggal 1 setiap bulannya.',
        adminNote: 'Selalu membayar sebelum / tepat Tanggal 1',
        icon: 'fa-crown',
        stars: 5,
        badgeClass: 'badge-score-loyal',
        cardClass: 'card-score-loyal',
        colorHex: '#f59e0b'
    },
    disiplin: {
        key: 'disiplin',
        order: 2,
        label: 'Pelanggan Disiplin',
        shortLabel: 'Disiplin (Tgl 2-5)',
        ruleText: 'Bayar pada Tanggal 2 s/d 5',
        description: 'Sangat baik! Anda rutin menyelesaikan pembayaran tagihan lebih awal pada Tanggal 2 hingga Tanggal 5.',
        adminNote: 'Membayar awal waktu (Tanggal 2 - 5)',
        icon: 'fa-medal',
        stars: 4,
        badgeClass: 'badge-score-disiplin',
        cardClass: 'card-score-disiplin',
        colorHex: '#0284c7'
    },
    tepat_waktu: {
        key: 'tepat_waktu',
        order: 3,
        label: 'Pelanggan Tepat Waktu',
        shortLabel: 'Tepat Waktu (Tgl 6-8)',
        ruleText: 'Bayar pada Tanggal 6 s/d 8',
        description: 'Terima kasih! Anda membayar tagihan tepat waktu sebelum batas jatuh tempo Tanggal 8.',
        adminNote: 'Membayar sebelum jatuh tempo (Tanggal 6 - 8)',
        icon: 'fa-check-circle',
        stars: 3,
        badgeClass: 'badge-score-tepat',
        cardClass: 'card-score-tepat',
        colorHex: '#10b981'
    },
    macet: {
        key: 'macet',
        order: 4,
        label: 'Pelanggan Macet',
        shortLabel: 'Macet (> Tgl 8)',
        ruleText: 'Lewat jatuh tempo Tanggal 8',
        description: 'Perhatian: Pembayaran melewati batas jatuh tempo Tanggal 8 atau terdapat tagihan yang belum dilunasi lewat jatuh tempo.',
        adminNote: 'Melewati jatuh tempo Tanggal 8 / Menunggak',
        icon: 'fa-exclamation-triangle',
        stars: 1,
        badgeClass: 'badge-score-macet',
        cardClass: 'card-score-macet',
        colorHex: '#ef4444'
    }
};

/**
 * Hitung "effective day" (hari ke-berapa dalam bulan periode tagihan) sebuah invoice dibayar/ditunggak.
 * - Jika periode = '2026-10', maka Tanggal 1 = '2026-10-01' (effectiveDay = 1).
 * - Jika dibayar pada '2026-09-28' (sebelum tgl 1), effectiveDay = -2 (<= 1 -> Loyal).
 * - Jika dibayar pada '2026-10-01', effectiveDay = 1 (<= 1 -> Loyal).
 * - Jika dibayar pada '2026-10-04', effectiveDay = 4 (2..5 -> Disiplin).
 * - Jika dibayar pada '2026-10-07', effectiveDay = 7 (6..8 -> Tepat Waktu).
 * - Jika dibayar pada '2026-10-12', effectiveDay = 12 (> 8 -> Macet).
 */
function evaluateSingleInvoice(invoice, todayMoment = moment().startOf('day')) {
    let periodStart;
    if (invoice.period && /^\d{4}-\d{2}$/.test(invoice.period)) {
        periodStart = moment(invoice.period + '-01', 'YYYY-MM-DD').startOf('day');
    } else if (invoice.due_date) {
        periodStart = moment(invoice.due_date).startOf('month');
    } else {
        periodStart = moment(invoice.created_at).startOf('month');
    }

    const dueMoment = periodStart.clone().date(8).endOf('day');

    if (invoice.status === 'paid') {
        const rawPaid = invoice.paid_date || invoice.payment_date || invoice.updated_at || invoice.created_at;
        const paidMoment = moment(rawPaid).startOf('day');
        const effectiveDay = 1 + paidMoment.diff(periodStart, 'days');

        let tierKey = 'macet';
        if (effectiveDay <= 1) {
            tierKey = 'loyal';
        } else if (effectiveDay <= 5) {
            tierKey = 'disiplin';
        } else if (effectiveDay <= 8) {
            tierKey = 'tepat_waktu';
        } else {
            tierKey = 'macet';
        }

        let timingText = '';
        if (effectiveDay < 1) {
            timingText = `Dibayar ${Math.abs(effectiveDay - 1)} hari sebelum Tgl 1 (${paidMoment.format('DD MMM YYYY')})`;
        } else if (effectiveDay === 1) {
            timingText = `Dibayar tepat Tanggal 1 (${paidMoment.format('DD MMM YYYY')})`;
        } else if (effectiveDay <= 8) {
            timingText = `Dibayar Tanggal ${effectiveDay} (${paidMoment.format('DD MMM YYYY')})`;
        } else {
            timingText = `Terlambat ${effectiveDay - 8} hari - Dibayar Tgl ${paidMoment.format('DD MMM YYYY')}`;
        }

        return {
            invoice_id: invoice.id,
            invoice_number: invoice.invoice_number,
            period: invoice.period,
            status: 'paid',
            effectiveDay,
            isOverdueUnpaid: false,
            overdueDays: Math.max(0, effectiveDay - 8),
            tierKey,
            tier: TIER_DEFINITIONS[tierKey],
            timingText,
            paidDateFormatted: paidMoment.format('DD MMM YYYY')
        };
    }

    // Jika status !== 'paid' (unpaid)
    const currentEffectiveDay = 1 + todayMoment.diff(periodStart, 'days');
    const isPastDue8 = currentEffectiveDay > 8 || todayMoment.isAfter(dueMoment);

    if (isPastDue8) {
        const overdueDays = Math.max(1, currentEffectiveDay - 8);
        return {
            invoice_id: invoice.id,
            invoice_number: invoice.invoice_number,
            period: invoice.period,
            status: 'unpaid',
            effectiveDay: Math.max(9, currentEffectiveDay),
            isOverdueUnpaid: true,
            overdueDays,
            tierKey: 'macet',
            tier: TIER_DEFINITIONS.macet,
            timingText: `Belum dibayar (Lewat ${overdueDays} hari dari jatuh tempo Tgl 8)`,
            paidDateFormatted: null
        };
    }

    // Belum dibayar tapi masih dalam masa Tgl 1 - 8 (belum lewat jatuh tempo)
    return {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        period: invoice.period,
        status: 'unpaid',
        effectiveDay: null,
        isOverdueUnpaid: false,
        overdueDays: 0,
        tierKey: 'pending',
        tier: null,
        timingText: `Menunggu pembayaran (Batas jatuh tempo: 08 ${periodStart.format('MMM YYYY')})`,
        paidDateFormatted: null
    };
}

/**
 * Hitung poin skor numerik (0 - 100) dari rata-rata tanggal pembayaran & tunggakan
 */
function calculateNumericPoints(tierKey, avgEffectiveDay, overdueUnpaidCount, totalOverdueDays) {
    if (tierKey === 'loyal') {
        // <= Tanggal 1: 96 - 100 poin
        const bonus = avgEffectiveDay < 1 ? Math.min(4, Math.abs(avgEffectiveDay - 1)) : 2;
        return Math.min(100, Math.round(96 + bonus));
    }
    if (tierKey === 'disiplin') {
        // Tanggal 2 - 5: 82 - 94 poin
        const clamped = Math.max(2, Math.min(5, avgEffectiveDay));
        return Math.round(94 - ((clamped - 2) * 4));
    }
    if (tierKey === 'tepat_waktu') {
        // Tanggal 6 - 8: 68 - 78 poin
        const clamped = Math.max(6, Math.min(8, avgEffectiveDay));
        return Math.round(78 - ((clamped - 6) * 5));
    }
    // Macet (> Tanggal 8 atau nunggak)
    const penaltyDays = Math.max(1, (avgEffectiveDay || 9) - 8) + (totalOverdueDays || 0);
    const unpaidPenalty = (overdueUnpaidCount || 0) * 12;
    return Math.max(5, Math.min(55, Math.round(58 - (penaltyDays * 2) - unpaidPenalty)));
}

/**
 * Evaluasi profil scoring lengkap untuk 1 pelanggan beserta daftar invoice-nya
 */
function calculateCustomerScore(customer, invoices = []) {
    const todayMoment = moment().startOf('day');
    const evaluatedInvoices = invoices.map(inv => evaluateSingleInvoice(inv, todayMoment));

    const paidEvaluations = evaluatedInvoices.filter(e => e.status === 'paid');
    const overdueUnpaidEvaluations = evaluatedInvoices.filter(e => e.isOverdueUnpaid);
    const pendingUnpaidEvaluations = evaluatedInvoices.filter(e => e.status === 'unpaid' && !e.isOverdueUnpaid);

    const paidCount = paidEvaluations.length;
    const unpaidCount = overdueUnpaidEvaluations.length + pendingUnpaidEvaluations.length;
    const overdueUnpaidCount = overdueUnpaidEvaluations.length;

    const loyalCount = paidEvaluations.filter(e => e.tierKey === 'loyal').length;
    const disiplinCount = paidEvaluations.filter(e => e.tierKey === 'disiplin').length;
    const tepatWaktuCount = paidEvaluations.filter(e => e.tierKey === 'tepat_waktu').length;
    const latePaidCount = paidEvaluations.filter(e => e.tierKey === 'macet').length;

    let tierKey = 'tepat_waktu';
    let avgEffectiveDay = 6;
    let totalOverdueDays = overdueUnpaidEvaluations.reduce((acc, e) => acc + e.overdueDays, 0)
        + paidEvaluations.reduce((acc, e) => acc + e.overdueDays, 0);

    // Hitung rata-rata tanggal pembayaran dari tagihan yang sudah lunas + yang sedang menunggak lewat tgl 8
    const activeEvaluations = [...paidEvaluations, ...overdueUnpaidEvaluations];
    if (activeEvaluations.length > 0) {
        const sumDays = activeEvaluations.reduce((sum, e) => sum + e.effectiveDay, 0);
        avgEffectiveDay = Number((sumDays / activeEvaluations.length).toFixed(1));
    }

    // Penentuan Tier Pelanggan:
    // 1. Jika ada tagihan belum bayar yang sudah lewat Tanggal 8, atau status pelanggan suspended karena tagihan -> Pelanggan Macet
    if (overdueUnpaidCount > 0 || (customer.status === 'suspended' && unpaidCount > 0)) {
        tierKey = 'macet';
        if (activeEvaluations.length === 0) avgEffectiveDay = 15;
    } else if (paidCount > 0) {
        // Ambil pembayaran terakhir + rata-rata historis
        // Pelanggan Loyal: selalu membayar <= tanggal 1 (atau rata-rata <= 1.3 dan pembayaran terakhir <= 1)
        const latestPaid = paidEvaluations[0]; // invoices diurutkan terbaru dulu
        if (avgEffectiveDay <= 1.3 && latestPaid.effectiveDay <= 1 && latePaidCount === 0) {
            tierKey = 'loyal';
        } else if (avgEffectiveDay <= 5 && latePaidCount === 0) {
            tierKey = 'disiplin';
        } else if (avgEffectiveDay <= 8 && latePaidCount === 0) {
            tierKey = 'tepat_waktu';
        } else if (avgEffectiveDay <= 5) {
            tierKey = 'disiplin';
        } else if (avgEffectiveDay <= 8) {
            tierKey = 'tepat_waktu';
        } else {
            tierKey = 'macet';
        }
    } else {
        // Belum memiliki riwayat pembayaran sama sekali
        if (customer.status === 'suspended') {
            tierKey = 'macet';
            avgEffectiveDay = 12;
        } else {
            tierKey = 'tepat_waktu';
            avgEffectiveDay = 6;
        }
    }

    const tier = TIER_DEFINITIONS[tierKey];
    const scorePoints = calculateNumericPoints(tierKey, avgEffectiveDay, overdueUnpaidCount, totalOverdueDays);

    // Format deskripsi ringkas kebiasaan bayar pelanggan
    let habitSummary = '';
    if (overdueUnpaidCount > 0) {
        const maxOverdue = Math.max(...overdueUnpaidEvaluations.map(e => e.overdueDays));
        habitSummary = `Menunggak ${overdueUnpaidCount} tagihan (lewat ${maxOverdue} hari dari Tgl 8)`;
    } else if (paidCount > 0) {
        const roundedDay = Math.round(avgEffectiveDay);
        if (roundedDay < 1) {
            habitSummary = `Rata-rata bayar ${Math.abs(roundedDay - 1)} hari sebelum Tgl 1`;
        } else if (roundedDay === 1) {
            habitSummary = 'Selalu bayar tepat Tanggal 1';
        } else if (roundedDay <= 8) {
            habitSummary = `Rata-rata bayar sekitar Tanggal ${roundedDay}`;
        } else {
            habitSummary = `Rata-rata bayar terlambat (sekitar Tgl ${roundedDay})`;
        }
    } else {
        habitSummary = 'Pelanggan baru / belum ada riwayat jatuh tempo';
    }

    // Pilih invoice utama pelanggan untuk tombol "Lihat Tagihan" (prioritas: tagihan belum lunas terbaru, lalu tagihan terbaru)
    const targetInvoice = invoices.find(inv => inv.status === 'unpaid') || invoices[0] || null;

    return {
        customerId: customer.id,
        customerCode: customer.customer_id,
        customerName: customer.name,
        customerPhone: customer.phone,
        customerAddress: customer.address,
        customerStatus: customer.status,
        packageName: customer.package_name || '-',
        targetInvoiceId: targetInvoice ? targetInvoice.id : null,
        targetInvoiceNumber: targetInvoice ? targetInvoice.invoice_number : null,
        tierKey,
        tierOrder: tier.order,
        tier,
        scorePoints,
        avgEffectiveDay,
        habitSummary,
        paidCount,
        unpaidCount,
        overdueUnpaidCount,
        totalOverdueDays,
        breakdown: {
            loyalCount,
            disiplinCount,
            tepatWaktuCount,
            latePaidCount,
            overdueUnpaidCount
        },
        evaluatedInvoices
    };
}

/**
 * Ambil seluruh pelanggan beserta ranking pembayaran dari yang paling tepat waktu (Loyal)
 * sampai yang paling telat & bermasalah (Macet).
 */
function getAllCustomerRankings(db) {
    const customers = db.prepare(`
        SELECT c.*, p.name as package_name, p.price as package_price
        FROM customers c
        LEFT JOIN packages p ON c.package_id = p.id
        ORDER BY c.id ASC
    `).all();

    const allInvoices = db.prepare(`
        SELECT i.*,
               (SELECT payment_date FROM payments pm WHERE pm.invoice_id = i.id ORDER BY pm.payment_date DESC, pm.id DESC LIMIT 1) as payment_date,
               (SELECT payment_method FROM payments pm WHERE pm.invoice_id = i.id ORDER BY pm.payment_date DESC, pm.id DESC LIMIT 1) as payment_method
        FROM invoices i
        ORDER BY i.period DESC, i.created_at DESC
    `).all();

    const invoicesByCust = {};
    for (const inv of allInvoices) {
        if (!invoicesByCust[inv.customer_id]) invoicesByCust[inv.customer_id] = [];
        invoicesByCust[inv.customer_id].push(inv);
    }

    const rankings = customers.map(cust => {
        const custInvoices = invoicesByCust[cust.id] || [];
        return calculateCustomerScore(cust, custInvoices);
    });

    // Urutkan dari yang paling tepat waktu (Loyal -> Disiplin -> Tepat Waktu -> Macet)
    rankings.sort((a, b) => {
        // 1. Berdasarkan tierOrder (1 = Loyal, 2 = Disiplin, 3 = Tepat Waktu, 4 = Macet)
        if (a.tierOrder !== b.tierOrder) return a.tierOrder - b.tierOrder;

        // 2. Yang tidak punya tunggakan lewat tgl 8 lebih unggul
        if (a.overdueUnpaidCount !== b.overdueUnpaidCount) {
            return a.overdueUnpaidCount - b.overdueUnpaidCount;
        }

        // 3. Rata-rata tanggal bayar lebih awal lebih unggul
        if (a.avgEffectiveDay !== b.avgEffectiveDay) {
            return a.avgEffectiveDay - b.avgEffectiveDay;
        }

        // 4. Skor poin lebih tinggi lebih unggul
        if (b.scorePoints !== a.scorePoints) {
            return b.scorePoints - a.scorePoints;
        }

        // 5. Jumlah pembayaran lunas lebih banyak lebih unggul
        return b.paidCount - a.paidCount;
    });

    // Tambahkan nomor peringkat (rank)
    rankings.forEach((item, index) => {
        item.rank = index + 1;
    });

    const summary = {
        total: rankings.length,
        loyal: rankings.filter(r => r.tierKey === 'loyal').length,
        disiplin: rankings.filter(r => r.tierKey === 'disiplin').length,
        tepat_waktu: rankings.filter(r => r.tierKey === 'tepat_waktu').length,
        macet: rankings.filter(r => r.tierKey === 'macet').length
    };

    return {
        rankings,
        summary,
        TIER_DEFINITIONS
    };
}

module.exports = {
    TIER_DEFINITIONS,
    evaluateSingleInvoice,
    calculateCustomerScore,
    getAllCustomerRankings
};
