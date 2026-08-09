// الدخول بالرابط الشخصي + الصلاحيات الهرمية
const { db, audit } = require('./db');
const { getCookie, setCookie } = require('hono/cookie');

// السلّم الهرمي للأدوار — الأعلى يملك صلاحيات الأدنى
const LEVELS = {
  admin: 100,               // الإشراف العام على الرحلة
  manager: 80,              // إداري
  room_supervisor: 50,      // مشرف غرفة
  attendance_supervisor: 50,// مشرف حضور
  student: 10,
};
const ROLE_NAMES = {
  admin: 'المؤسس',              // بلا مسمّى إداري — أعلى الصلاحيات
  manager: 'رئيس الوفد',         // الإشراف العام على الرحلة — بلا مهام تشغيلية يومية
  room_supervisor: 'مشرف غرفة',
  attendance_supervisor: 'مشرف حضور',
  student: 'طالب',
};

const level = (p) => (p ? (LEVELS[p.role] || 10) : 0);
const isAdmin = (p) => p && p.role === 'admin';
const isManager = (p) => p && level(p) >= LEVELS.manager;      // إداري فأعلى
const isSupervisor = (p) => p && level(p) >= LEVELS.room_supervisor; // أي مشرف فأعلى

function personByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM people WHERE token = ? AND active = 1').get(token) || null;
}

// يحمّل المستخدم من الكوكي في كل طلب (+ كشف وضع المعاينة)
async function loadUser(c, next) {
  c.set('user', personByToken(getCookie(c, 'rihla')));
  const real = personByToken(getCookie(c, 'rihla_real'));
  c.set('realUser', real);           // الحساب الأصلي أثناء «المعاينة كـ»
  await next();
}

// دخول عبر الرابط الشخصي /d/:token — يسجل الجهاز في التدقيق لكشف الدخول من جهاز جديد
function login(c, token) {
  const p = personByToken(token);
  if (!p) return null;
  const { getCookie: gc } = require('hono/cookie');
  const firstTime = gc(c, 'rihla') !== token;
  setCookie(c, 'rihla', token, {
    path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60 * 60 * 24 * 45,
    secure: c.req.url.startsWith('https'),
  });
  const ua = (c.req.header('user-agent') || '').slice(0, 200);
  const ip = (c.req.header('x-forwarded-for') || '').split(',')[0].trim()
    || c.req.header('x-real-ip') || c.req.header('cf-connecting-ip') || 'محلي';
  audit(p.id, firstTime ? 'login_new_device' : 'login', `${p.name} | ${ua.slice(0, 90)}`);
  recordSession(p.id, ua, ip);
  return p;
}

// تصنيف الجهاز من بصمة المتصفح
function deviceName(ua) {
  const s = String(ua || '');
  const m = s.match(/iPhone OS (\d+)/) || s.match(/Android (\d+)/);
  if (/iPhone/i.test(s)) return `آيفون${m ? ' iOS ' + m[1] : ''}`;
  if (/iPad/i.test(s)) return `آيباد${m ? ' iOS ' + m[1] : ''}`;
  if (/Android/i.test(s)) return `أندرويد${m ? ' ' + m[1] : ''}`;
  if (/Macintosh|Mac OS/i.test(s)) return 'ماك';
  if (/Windows/i.test(s)) return 'ويندوز';
  return s ? 'متصفح آخر' : 'غير معروف';
}

// تسجيل جلسة الجهاز (بصمة = المتصفح + العنوان) — أساس مراقبة الدخول
function recordSession(personId, ua, ip) {
  const crypto = require('crypto');
  const fp = crypto.createHash('sha256').update(String(ua) + '|' + String(ip)).digest('hex').slice(0, 16);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sessions (person_id, fingerprint, ua, ip, device, first_seen, last_seen, hits)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(person_id, fingerprint) DO UPDATE SET last_seen = excluded.last_seen, hits = hits + 1`)
    .run(personId, fp, String(ua).slice(0, 200), String(ip), deviceName(ua), now, now);
}

// تحضير الحلقات التي يشرف عليها الشخص — الصلاحية تُبنى على الإشراف الفعلي لا على الدور
function circlesSupervisedBy(personId) {
  return db.prepare('SELECT id, name FROM att_groups WHERE supervisor_id = ?').all(personId);
}

// تقييم الغرف (جاهزية/سلوك) محايد: الإدارة + أعضاء لجنة الجودة فقط — لا يقيّم مشرف غرفةً درجات غرفته
function canRateRooms(u) {
  if (!u) return false;
  if (isManager(u)) return true;
  return committeesOf(u.id).some(cm => cm.name.includes('الجودة'));  // «لجنة متابعة الجودة»
}

// الغرف التي يشرف عليها الشخص فعلياً: المسنَدة له + غرفته إن كان دوره مشرف غرفة
// (يسمح بجمع الأدوار: مشرف غرفة + مشرف حلقة + عضو لجنة بنفس الوقت)
// غرفة واحدة قد يشرف عليها أكثر من واحد — أيّهم سجّل، سجّل عن الجميع
function roomsSupervisedBy(u) {
  if (!u) return [];
  return db.prepare(`SELECT id, name FROM rooms WHERE supervisor_id = ?
    UNION SELECT r.id, r.name FROM rooms r JOIN room_supervisors rs ON rs.room_id = r.id WHERE rs.person_id = ?
    UNION SELECT id, name FROM rooms WHERE id = ? AND ? = 'room_supervisor'`)
    .all(u.id, u.id, u.room_id || 0, u.role);
}
// كل مشرفي الغرفة (الأساسي + المشاركون) — لعرضهم جنباً إلى جنب
function supervisorsOfRoom(roomId) {
  return db.prepare(`SELECT p.id, p.name, 1 AS main FROM people p JOIN rooms r ON r.supervisor_id = p.id WHERE r.id = ?
    UNION SELECT p.id, p.name, 0 AS main FROM people p JOIN room_supervisors rs ON rs.person_id = p.id WHERE rs.room_id = ?
    ORDER BY main DESC, name`).all(roomId, roomId);
}

// حارس صلاحية: requireLevel(c, 'manager') يرفض من هو أدنى
function deny(c) {
  return c.html('<div dir="rtl" style="font-family:sans-serif;padding:40px;text-align:center">ما عندك صلاحية لهذه الصفحة 🔒<br><br><a href="/">الرجوع</a></div>', 403);
}
function requireLevel(minRole) {
  return async (c, next) => {
    const u = c.get('user');
    if (!u || level(u) < LEVELS[minRole]) return deny(c);
    await next();
  };
}

// عضويات اللجان (صلاحيات إضافية فوق الدور الأساسي)
function committeesOf(personId) {
  return db.prepare(`SELECT cm.committee_id AS id, c.name, cm.is_head
                     FROM committee_members cm JOIN committees c ON c.id = cm.committee_id
                     WHERE cm.person_id = ?`).all(personId);
}

module.exports = { supervisorsOfRoom, LEVELS, ROLE_NAMES, level, isAdmin, isManager, isSupervisor, loadUser, login, requireLevel, deny, committeesOf, circlesSupervisedBy, roomsSupervisedBy, canRateRooms, deviceName, recordSession };
