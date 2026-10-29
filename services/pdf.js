const fs = require('fs');
const puppeteer = require('puppeteer');
const ejs = require('ejs');
const path = require('path');
const moment = require('moment');
const db = require('../database/init');

class PdfService {
    /**
     * Generate PDF Buffer untuk Invoice tertentu berdasarkan ID atau objek invoice
     * @param {number|string|object} invoiceOrId 
     * @returns {Promise<Buffer>}
     */
    async generateInvoicePdf(invoiceOrId) {
        const invoiceId = (typeof invoiceOrId === 'object' && invoiceOrId !== null) ? invoiceOrId.id : invoiceOrId;
        let invoice = null;

        if (invoiceId) {
            invoice = db.prepare(`
                SELECT i.*, 
                       c.name as customer_name, c.customer_id, c.phone as customer_phone, c.address as customer_address,
                       c.connection_type, c.ip_address, c.pppoe_username,
                       p.name as package_name, p.speed_down, p.speed_up
                FROM invoices i
                JOIN customers c ON i.customer_id = c.id
                LEFT JOIN packages p ON c.package_id = p.id
                WHERE i.id = ?
            `).get(invoiceId);
        }

        if (!invoice && typeof invoiceOrId === 'object' && invoiceOrId !== null) {
            invoice = { ...invoiceOrId };
            if (invoice.customer_code) {
                invoice.customer_id = invoice.customer_code;
            }
        }

        if (!invoice) {
            throw new Error('Data invoice tidak ditemukan untuk pembuatan PDF');
        }

        // Ambil riwayat pembayaran jika ada
        const payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY payment_date DESC').all(invoice.id);

        // Ambil info perusahaan dari settings
        const companyName = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_name')?.value || 'ISP Manager';
        const companyPhone = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_phone')?.value || '';
        const companyAddress = db.prepare("SELECT value FROM settings WHERE key = ?").get('company_address')?.value || '';

        // Ambil logo perusahaan dalam bentuk base64
        let companyLogo = null;
        try {
            const pngPath = path.join(__dirname, '../public/img/logo.png');
            const jpgPath = path.join(__dirname, '../public/img/logo.jpg');
            if (fs.existsSync(pngPath)) {
                const logoBuffer = fs.readFileSync(pngPath);
                companyLogo = `data:image/png;base64,${logoBuffer.toString('base64')}`;
            } else if (fs.existsSync(jpgPath)) {
                const logoBuffer = fs.readFileSync(jpgPath);
                companyLogo = `data:image/jpeg;base64,${logoBuffer.toString('base64')}`;
            }
        } catch (e) {}

        // Ambil pengaturan metode pembayaran
        const paymentSettingsRows = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all('payment_%');
        const paymentSettings = {};
        paymentSettingsRows.forEach(r => paymentSettings[r.key] = r.value);

        // Render template EJS ke string HTML
        const templatePath = path.join(__dirname, '../views/invoice-print.ejs');
        const html = await ejs.renderFile(templatePath, {
            invoice,
            payments,
            companyName,
            companyPhone,
            companyAddress,
            companyLogo,
            paymentSettings,
            moment,
            isPdf: true
        });

        // Opsi puppeteer headless
        const puppeteerOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote'
            ]
        };

        try {
            if (typeof puppeteer.executablePath === 'function') {
                const execPath = puppeteer.executablePath();
                if (execPath) puppeteerOptions.executablePath = execPath;
            }
        } catch (pErr) {}

        const browser = await puppeteer.launch(puppeteerOptions);
        try {
            const page = await browser.newPage();
            await page.setViewport({ width: 1200, height: 1600 });
            try {
                await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
            } catch (loadErr) {
                await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10000 });
            }
            
            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: {
                    top: '8mm',
                    right: '8mm',
                    bottom: '8mm',
                    left: '8mm'
                }
            });

            return Buffer.from(pdfBuffer);
        } finally {
            await browser.close().catch(() => {});
        }
    }

    /**
     * Generate PDF Buffer untuk Laporan Rekapitulasi Pembayaran
     * @param {object} reportData 
     * @returns {Promise<Buffer>}
     */
    async generateReportPdf(reportData) {
        const templatePath = path.join(__dirname, '../views/report-print.ejs');
        const html = await ejs.renderFile(templatePath, {
            ...reportData,
            isPdf: true
        });

        const puppeteerOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote'
            ]
        };

        try {
            if (typeof puppeteer.executablePath === 'function') {
                const execPath = puppeteer.executablePath();
                if (execPath) puppeteerOptions.executablePath = execPath;
            }
        } catch (pErr) {}

        const browser = await puppeteer.launch(puppeteerOptions);
        try {
            const page = await browser.newPage();
            await page.setViewport({ width: 1400, height: 900 });
            await page.setContent(html, { waitUntil: 'load', timeout: 20000 });

            const pdfBuffer = await page.pdf({
                format: 'A4',
                landscape: true,
                printBackground: true,
                margin: {
                    top: '8mm',
                    right: '8mm',
                    bottom: '8mm',
                    left: '8mm'
                }
            });

            return Buffer.from(pdfBuffer);
        } finally {
            await browser.close().catch(() => {});
        }
    }
}

module.exports = new PdfService();
