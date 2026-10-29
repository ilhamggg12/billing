/**
 * Script CLI untuk Reset atau Cek Password Admin ISP Manager
 * Cara pakai di server:
 * node reset-admin.js [username_opsional] [password_baru_opsional]
 * Contoh:
 * node reset-admin.js admin admin123
 */

const db = require('./database/init');
const bcrypt = require('bcryptjs');

const targetUser = (process.argv[2] || 'admin').trim();
const newPassword = (process.argv[3] || 'admin123').trim();

try {
    const hashed = bcrypt.hashSync(newPassword, 10);
    const existing = db.prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?)").get(targetUser);

    console.log('\n========================================================');
    if (existing) {
        db.prepare("UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?")
            .run(hashed, existing.id);
        console.log(`  [BERHASIL] Password untuk akun '${existing.username}' telah direset!`);
        console.log(`  Role     : ${existing.role}`);
    } else {
        db.prepare("INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)")
            .run(targetUser, hashed, 'Administrator', 'admin');
        console.log(`  [BERHASIL] Akun admin '${targetUser}' berhasil dibuat!`);
    }

    console.log(`  Username : ${targetUser}`);
    console.log(`  Password : ${newPassword}`);
    console.log('========================================================');
    console.log('  Silakan coba login di: /login-admin\n');
} catch (err) {
    console.error('\n[ERROR]:', err.message);
}
