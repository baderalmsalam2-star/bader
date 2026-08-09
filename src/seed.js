// بذر بيانات البداية: 103 مشارك + 14 سكن + مراحل الباصات + اللجان
const { db, now, setSetting, audit } = require('./db');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed.json'), 'utf8'));

const newToken = () => crypto.randomBytes(6).toString('base64url'); // 8 أحرف غير قابلة للتخمين

const existing = db.prepare('SELECT COUNT(*) AS c FROM people').get().c;
if (existing > 0) {
  console.log(`قاعدة البيانات فيها ${existing} شخص — البذر تم سابقاً. للإعادة احذف data/rihla.db`);
  process.exit(0);
}

const insRoom = db.prepare('INSERT INTO rooms (name, type, beds, extra_beds, room_no, label) VALUES (?, ?, ?, ?, ?, ?)');
const insPerson = db.prepare('INSERT INTO people (name, category, role, room_id, token, notes) VALUES (?, ?, ?, ?, ?, ?)');

db.exec('BEGIN');
try {
  const roomIds = {};
  for (const r of seed.rooms) {
    const res = insRoom.run(r.name, r.type, r.beds, r.extra || 0, r.roomNo, r.label);
    roomIds[r.name] = Number(res.lastInsertRowid);
  }

  for (const p of seed.people) {
    // ملاحظات خاصة من مستند الغرف
    let note = null;
    if (p.name === 'خالد عادل عبدالله هادي') note = 'ملكي ٤ — أسبوع (١) فقط';
    if (p.name === 'خالد أحمد حسن الكندري') note = 'ملكي ٤ — أسبوع (٢) فقط';
    insPerson.run(p.name, p.category, 'student', p.room ? roomIds[p.room] : null, newToken(), note);
  }

  // الإشراف العام — بدر المسلم (عدّلها من لوحة الإدارة إن كان غير ذلك)
  db.prepare("UPDATE people SET role = 'admin' WHERE name LIKE '%بدر سعود بدر المسلم%'").run();

  // مراحل الباصات الأربع
  const insStage = db.prepare('INSERT INTO bus_stages (name, ord, active) VALUES (?, ?, 0)');
  ['١- المطار ← فندق المدينة', '٢- المدينة ← محطة القطار', '٣- محطة القطار ← فندق مكة', '٤- فندق مكة ← مطار جدة']
    .forEach((s, i) => insStage.run(s, i + 1));

  // اللجان الأساسية (تُعدَّل من لوحة الإدارة)
  const insCom = db.prepare('INSERT INTO committees (name) VALUES (?)');
  ['لجنة الجودة', 'اللجنة اللوجستية', 'لجنة الخدمات المساندة', 'اللجنة الطبية', 'اللجنة الثقافية'].forEach(c => insCom.run(c));

  // إعدادات عامة
  setSetting('trip_start', '2026-08-16');
  setSetting('trip_name', 'رحلة المدينة النبوية ١١ — ١٤٤٨هـ/٢٠٢٦م');
  setSetting('current_city', 'المدينة');
  setSetting('admin_pin', String(Math.floor(100000 + Math.random() * 900000))); // PIN إضافي للإدارة

  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

audit(null, 'seed', `بذر البيانات: ${seed.people.length} شخص، ${seed.rooms.length} سكن`);
const admin = db.prepare("SELECT name, token FROM people WHERE role = 'admin'").get();
console.log('تم البذر بنجاح ✓');
console.log('عدد الأشخاص:', db.prepare('SELECT COUNT(*) c FROM people').get().c);
console.log('عدد الغرف:', db.prepare('SELECT COUNT(*) c FROM rooms').get().c);
if (admin) console.log(`رابط دخول الإشراف العام (${admin.name}): /d/${admin.token}`);
console.log('PIN الإدارة:', db.prepare("SELECT value FROM settings WHERE key='admin_pin'").get().value);
if (seed.notes) seed.notes.forEach(n => console.log('ملاحظة:', n));
