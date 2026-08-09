// لوحة الإدارة — كل شيء قابل للتعديل بدون مبرمج
const { Hono } = require('hono');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { db, now, today, getSetting, setSetting, audit, getRules, getSlots, slotLabel, backupNow, getCategories, DEFAULT_CATEGORIES } = require('./db');
const { requireLevel, ROLE_NAMES, isAdmin, deny } = require('./auth');
const { supervisorsOfRoom } = require('./auth');
const { layout, esc, rolePill, catPill, supBadge } = require('./views');
const { fetchRange, savePrayers, getPrayers } = require('./prayers');
const { encrypt, decrypt, pinHash } = require('./secure');
const { getCookie, setCookie } = require('hono/cookie');

const WEEK = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
// تصنيفات التكرار المعتمدة — «مرة في الموسم» أُلغيت بقرار الإدارة
const REPEATS = {
  daily:  { label: 'يومية', pill: 'g' },
  alt:    { label: 'يوم وترك', pill: 'o' },
  weekly: { label: 'أسبوعية', pill: 'o' },
  twice:  { label: 'مرتين في الأسبوع', pill: 'o' },
  once:   { label: 'مرة واحدة', pill: 'm' },
};
// المتكررة تُسجَّل يوماً بيوم؛ «مرة واحدة» تُسجَّل مرة للأبد
// يوم الأسبوع: الأحد = 0 وهي قيمة مشروعة — «|| افتراضي» كان يبتلعها ويحوّلها للجمعة
function wdOf(v, dflt) {
  const x = Number(v);
  return Number.isInteger(x) && x >= 0 && x <= 6 ? x : dflt;
}
const PER_DAY = new Set(['daily', 'alt', 'weekly', 'twice']);
// هل تستحق هذه المهمة الظهور اليوم؟ «يوم وترك» تُحسب من يوم انطلاق الرحلة
function taskDueToday(t, d = today()) {
  const dow = new Date(d + 'T00:00:00Z').getUTCDay();
  if (t.kind === 'alt') {
    const s = getSetting('trip_start', '2026-08-15');
    const diff = Math.round((new Date(d + 'T00:00:00Z') - new Date(s + 'T00:00:00Z')) / 86400000);
    return (((diff % 2) + 2) % 2) === 0;
  }
  if (t.kind === 'weekly') return dow === (t.weekday ?? 5);
  if (t.kind === 'twice') return dow === (t.weekday ?? 0) || dow === (t.weekday2 ?? 3);
  return true;
}
const repeatBadge = (k, wd, wd2) => {
  const r = REPEATS[k] || REPEATS.once;
  const day = k === 'weekly' ? ' — ' + WEEK[wd ?? 5]
    : k === 'twice' ? ' — ' + WEEK[wd ?? 0] + ' و' + WEEK[wd2 ?? 3] : '';
  return `<span class="pill ${r.pill}">${r.label}${day}</span>`;
};
// يُلحق بأي صفحة فيها منتقي تكرار — يُظهر حقول الأيام عند الحاجة فقط
const RP_SCRIPT = `<script>
function rpSync(s){var w=s.closest('form'),k=s.value;
  var a=w.querySelector('.rp1'),b=w.querySelector('.rp2');if(!a)return;
  a.style.display=(k==='weekly'||k==='twice')?'':'none';
  b.style.display=(k==='twice')?'':'none';
  var L=a.querySelector('label');if(L)L.textContent=(k==='twice')?'اليوم الأول':'اليوم';}
<\/script>`;
const admin = new Hono();
admin.use('*', requireLevel('manager'));

// بوابة PIN: طبقة ثانية للوحة الإدارة — مرة واحدة لكل جهاز، تُبطل تلقائياً عند تغيير الـ PIN
admin.use('*', async (c, next) => {
  if (c.req.path.startsWith('/admin/pin')) return next();
  const pin = getSetting('admin_pin');
  if (!pin || getCookie(c, 'apin') === pinHash(pin)) return next();
  return c.redirect('/admin/pin');
});
admin.get('/pin', (c) => c.html(layout('رمز الإدارة', `
  <div class="card" style="text-align:center;padding:30px 20px">
    <div style="font-size:40px">🛡️</div>
    <h3>هذا الجهاز يدخل لوحة الإدارة لأول مرة</h3>
    <p style="color:var(--muted);font-size:13px">أدخل رمز الإدارة (PIN) — تجده في «الأمان والنسخ» من جهاز معتمد سابقاً</p>
    <form method="post" action="/admin/pin">
      <input name="pin" inputmode="numeric" autocomplete="one-time-code" required style="text-align:center;font-size:24px;letter-spacing:8px" maxlength="6">
      <button class="btn block" style="margin-top:12px">دخول</button>
    </form>
  </div>`, { user: c.get('user') })));
admin.post('/pin', async (c) => {
  const b = await c.req.parseBody();
  const pin = getSetting('admin_pin');
  if (pin && String(b.pin).trim() === pin) {
    setCookie(c, 'apin', pinHash(pin), { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60 * 60 * 24 * 60, secure: c.req.url.startsWith('https') });
    audit(c.get('user').id, 'admin_pin_ok', 'جهاز جديد اعتُمد للوحة الإدارة');
    return c.redirect('/admin');
  }
  audit(c.get('user').id, 'admin_pin_fail', 'محاولة PIN خاطئة');
  return c.redirect('/admin/pin');
});

const newToken = () => crypto.randomBytes(6).toString('base64url');
const baseUrl = (c) => (getSetting('base_url') || new URL(c.req.url).origin).replace(/\/$/, '');
const back = (c, path, msg) => c.redirect(path + (msg ? `?m=${encodeURIComponent(msg)}` : ''));

// ===== الرئيسية =====
admin.get('/', (c) => {
  const u = c.get('user');
  const d = today();
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  const nPeople = q('SELECT COUNT(*) c FROM people WHERE active=1').c;
  const nNoRoom = q("SELECT COUNT(*) c FROM people WHERE active=1 AND room_id IS NULL AND role='student'").c;
  const attToday = q('SELECT COUNT(*) c FROM attendance WHERE date=?', d).c;
  const absToday = q("SELECT COUNT(*) c FROM attendance WHERE date=? AND status='absent'", d).c;
  const newReqs = q("SELECT COUNT(*) c FROM requests WHERE status='new'").c;
  const pendPhotos = q("SELECT COUNT(*) c FROM people WHERE active=1 AND photo_status='pending'").c;
  const activeStage = db.prepare('SELECT * FROM bus_stages WHERE active=1').get();
  const msg = db.prepare('SELECT * FROM daily_messages WHERE date=?').get(d);
  // أقسام مرتّبة بعناوين — كل مجموعة تخدم غرضاً واحداً
  const sections = [
    {
      title: '👥 الناس والسكن', items: [
        ['/admin/people', '👥', 'الأشخاص', 'إضافة وتعديل وروابط الدخول'],
        ['/admin/rooms', '🛏️', 'الغرف والأجنحة', 'التسكين والسعة والمشرفون'],
        ['/admin/groups', '📿', 'تحضير الحلقات', 'توزيع الطلاب على الحلقات'],
        ['/admin/photos', '📷', `اعتماد الصور${pendPhotos ? ` (${pendPhotos})` : ''}`, 'مراجعة صور المشاركين'],
      ]
    },
    {
      title: '📅 اليوم والبرنامج', items: [
        ['/admin/schedule', '📅', 'جدول اليوم', 'فقرات اليوم وأوقاتها'],
        ['/admin/slots', '⏰', 'مواعيد التحضير', 'أوقات تحضير الحلقات والغرف'],
        ['/admin/prayers', '🕌', 'أوقات الصلاة', 'تلقائية مع تعديل يدوي'],
        ['/admin/message', '📨', 'الرسالة اليومية', 'كلمة تصل كل المشاركين'],
        ['/admin/quiz', '❓', 'السؤال اليومي', 'سؤال تفاعلي بنقاط'],
        ['/admin/media', '📣', 'الإعلامية', 'روابط النشر ومتابعة التفاعل'],
        ['/admin/checklist', '✅', 'رفيقي اليومي', 'بنود عامة تصل الجميع'],
      ]
    },
    {
      title: '🏅 التحفيز والتقييم', items: [
        ['/admin/honor', '🏅', 'لوحات الشرف', 'القرآن والمتميزون'],
        ['/admin/benefits', '✍️', 'فوائد الطلاب', 'اعتمد ما يُنشر للجميع'],
        ['/admin/points', '🎯', 'قواعد النقاط', 'قيَم الحضور والسلوك'],
        ['/admin/checkitems', '✅', 'بنود جاهزية الغرفة', 'معايير التقييم اليومي'],
      ]
    },
    {
      title: '🤝 اللجان والطلبات', items: [
        ['/admin/committees', '🤝', 'اللجان والمهام', 'الأعضاء وchecklist اليوم'],
        ['/admin/requests', '📥', `الطلبات${newReqs ? ` (${newReqs} جديد)` : ''}`, 'طلبات واقتراحات وبلاغات'],
      ]
    },
    {
      title: '🚌 التنقّل', items: [
        ['/admin/buses', '🚌', 'مراحل الباصات', 'تفعيل المرحلة ومتابعة الركوب'],
      ]
    },
    {
      title: '💰 المال والتقارير', items: [
        ['/admin/money', '💰', 'المصروفات', 'تسجيل والتقرير المالي'],
        ['/admin/dashboard', '📊', 'لوحة التحكم الشاملة', 'كل الإحصائيات'],
        ['/admin/export', '📤', 'تصدير Excel', 'كل السجلات'],
      ]
    },
    ...(isAdmin(u) ? [{
      title: '🔒 خاص بك', items: [
        ['/admin/perms', '🔑', 'الصلاحيات', 'من يفتح أين — وتغيير الأدوار والفئات'],
        ['/admin/analytics', '🔬', 'التحليلات', 'الأجهزة والأمان — لك وحدك'],
        ['/admin/security', '🛡️', 'الأمان والنسخ', 'الرمز والشعار والنسخ الاحتياطي'],
        ['/admin/audit', '🧾', 'سجل التدقيق', 'كل عملية ومن نفّذها'],
      ]
    }] : [{
      title: '🧾 السجلات', items: [['/admin/audit', '🧾', 'سجل التدقيق', 'كل عملية ومن نفّذها']]
    }]),
  ];
  return c.html(layout('لوحة الإدارة', `
    <div class="grid2 g4">
      <div class="stat"><div class="v num">${nPeople}</div><div class="l">المشاركون</div></div>
      <div class="stat ${nNoRoom ? 'warn' : ''}"><div class="v num">${nNoRoom}</div><div class="l">بدون سكن</div></div>
      <div class="stat"><div class="v num">${attToday}</div><div class="l">تحضير اليوم</div></div>
      <div class="stat ${absToday ? 'warn' : ''}"><div class="v num">${absToday}</div><div class="l">غياب اليوم</div></div>
    </div>
    ${activeStage ? `<div class="card" style="border:2px solid var(--gold)"><b>🚌 مرحلة جارية:</b> ${esc(activeStage.name)} — <a href="/bus?stage=${activeStage.id}">فتح لوحة المتابعة</a></div>` : ''}
    ${(() => {
      // إنجاز checklist اللجان اليوم — يرجع لك بنظرة واحدة
      const stats = db.prepare(`SELECT c.id, c.name,
        COUNT(t.id) AS total,
        SUM(CASE WHEN (t.kind='daily' AND EXISTS(SELECT 1 FROM task_done td WHERE td.task_id=t.id AND td.date=?))
                   OR (t.kind='once' AND t.done=1) THEN 1 ELSE 0 END) AS dn
        FROM committees c LEFT JOIN committee_tasks t ON t.committee_id = c.id
        GROUP BY c.id HAVING total > 0 ORDER BY c.name`).all(d);
      if (!stats.length) return '';
      return `<div class="card"><h3>📋 إنجاز اللجان اليوم</h3>${stats.map(s =>
        `<div class="row" style="padding:4px 0"><div class="grow">${esc(s.name)}</div>
         <span class="pill ${s.dn >= s.total ? 'g' : s.dn > 0 ? 'o' : 'r'} num">${s.dn}/${s.total}</span></div>`).join('')}
        <a href="/admin/committees" style="font-size:12px">إدارة المهام ←</a></div>`;
    })()}
    ${!msg ? `<div class="card" style="border:1px solid var(--gold)">⚠️ ما في رسالة يومية لليوم — <a href="/admin/message">اكتبها الآن</a></div>` : ''}
    <div class="searchbox"><input data-filter="#adminsec" placeholder="🔍 ابحث في أقسام الإدارة..." autocomplete="off"></div>
    <div id="adminsec">
    ${sections.map(sec => `<div data-search="${esc(sec.title + ' ' + sec.items.map(i => i[2] + ' ' + i[3]).join(' '))}">
      <h2 class="sec">${sec.title}</h2>
      <div class="grid2 g3">
        ${sec.items.map(([href, icon, label, desc]) => `<a class="card" href="${href}"
          style="display:flex;align-items:center;gap:10px;text-decoration:none">
          <span style="font-size:24px;flex:none">${icon}</span>
          <div style="min-width:0">
            <div style="font-weight:700;font-size:14px;color:var(--ink)">${esc(label)}</div>
            <div style="font-size:11px;color:var(--muted);line-height:1.4">${esc(desc)}</div>
          </div></a>`).join('')}
      </div></div>`).join('')}
    </div>
  `, { user: u, active: '/admin' }));
});

// ===== الأشخاص =====
function suggestRoom(category) {
  // اقتراح تلقائي: غرفة فيها أسرّة شاغرة — أولوية لغرفة فيها نفس الفئة، ثم الأكثر شغوراً
  const rooms = db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM people p WHERE p.room_id = r.id AND p.active=1) AS occ,
      (SELECT COUNT(*) FROM people p WHERE p.room_id = r.id AND p.active=1 AND p.category = ?) AS same_cat
    FROM rooms r`).all(category);
  const free = rooms.map(r => ({ ...r, freeBeds: r.beds + r.extra_beds - r.occ })).filter(r => r.freeBeds > 0);
  free.sort((a, b) => (b.same_cat - a.same_cat) || (b.freeBeds - a.freeBeds));
  return free[0] || null;
}

admin.get('/people', (c) => {
  const u = c.get('user');
  const qv = c.req.query('q') || '';
  const people = db.prepare(`
    SELECT p.*, r.name AS room_name FROM people p LEFT JOIN rooms r ON r.id = p.room_id
    WHERE p.active = 1 ${qv ? 'AND p.name LIKE ?' : ''} ORDER BY p.name`).all(...(qv ? [`%${qv}%`] : []));
  const rooms = db.prepare('SELECT id, name FROM rooms ORDER BY name').all();
  return c.html(layout('الأشخاص', `
    <div class="card"><h3>➕ إضافة شخص جديد</h3>
      <form method="post" action="/admin/people/add">
        <label>الاسم الرباعي</label><input name="name" required>
        <div class="grid2">
          <div><label>الفئة</label><select name="category">${getCategories().map(x => `<option>${x}</option>`).join('')}</select></div>
          <div><label>الدور</label><select name="role">${Object.entries(ROLE_NAMES)
            .filter(([k]) => k !== 'admin')
            .map(([k, v]) => `<option value="${k}" ${k === 'student' ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        </div>
        <div class="grid2">
          <div><label>الرقم المدني (اختياري)</label><input name="civil_id"></div>
          <div><label>الجوال (اختياري)</label><input name="phone"></div>
        </div>
        <div class="grid2">
          <div><label>السكن</label><select name="room_id"><option value="auto">🪄 اقتراح تلقائي</option><option value="">بدون سكن</option>
            ${rooms.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>
          <div><label>اللجنة (اختياري)</label><select name="committee_id"><option value="">— بلا لجنة —</option>
            ${db.prepare('SELECT id, name FROM committees ORDER BY name').all().map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>
        </div>
        <label class="row" style="margin-top:8px;font-size:13px"><input type="checkbox" name="is_head" style="width:auto"> رئيس هذه اللجنة</label>
        <button class="btn block" style="margin-top:10px">إضافة — يظهر الرابط والـ QR فوراً</button>
      </form></div>
    <form class="searchbox"><input name="q" value="${esc(qv)}" placeholder="🔍 بحث بالاسم..."></form>
    <div class="card"><table>
      <tr><th>الاسم</th><th>الفئة</th><th>الدور</th><th>السكن</th><th></th></tr>
      ${people.map(p => `<tr><td><a href="/admin/people/${p.id}">${esc(p.name)}</a></td>
        <td><form method="post" action="/admin/people/${p.id}/quick" style="margin:0">
          <select name="category" onchange="this.form.submit()" style="padding:4px 6px;font-size:12px;width:auto">
            ${getCategories().map(x => `<option ${x === p.category ? 'selected' : ''}>${x}</option>`).join('')}</select></form></td>
        <td>${p.role === 'admin' ? rolePill(p.role) : `<form method="post" action="/admin/people/${p.id}/quick" style="margin:0">
          <select name="role" onchange="this.form.submit()" style="padding:4px 6px;font-size:12px;width:auto">
            ${Object.entries(ROLE_NAMES).filter(([k]) => k !== 'admin').map(([k, v]) => `<option value="${k}" ${k === p.role ? 'selected' : ''}>${v}</option>`).join('')}</select></form>`}</td>
        <td style="font-size:12px">${p.room_name ? esc(p.room_name) : '<span class="pill r">بدون سكن</span>'}</td>
        <td><a class="btn sm ghost" href="/admin/people/${p.id}">فتح</a></td></tr>`).join('')}
    </table><div style="color:var(--muted);font-size:12px;margin-top:6px">${people.length} شخص</div></div>
    ${(() => {
      const inactive = db.prepare('SELECT id, name, category FROM people WHERE active = 0 ORDER BY name').all();
      if (!inactive.length) return '';
      return `<div class="card" style="opacity:.85"><h3>🚫 المستبعدون مؤقتاً (${inactive.length}) — خارج كل الإحصائيات والقوائم</h3>
        ${inactive.map(p => `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line)">
          <div class="grow">${esc(p.name)} ${catPill(p.category)}</div>
          <form method="post" action="/admin/people/${p.id}/restore"><button class="btn sm gold">↩️ إرجاع</button></form>
        </div>`).join('')}
        <div style="font-size:11.5px;color:var(--muted);margin-top:4px">الإرجاع يعيد الشخص بكل بياناته ورابطه كما كان</div></div>`;
    })()}
  `, { user: u, active: '/admin', wide: true }));
});
// تعديل سريع للفئة أو الدور من القائمة — بلا فتح صفحة
admin.post('/people/:id/quick', async (c) => {
  const u = c.get('user');
  const id = Number(c.req.param('id'));
  const b = await c.req.parseBody();
  const p = db.prepare('SELECT name, role, category FROM people WHERE id = ?').get(id);
  if (!p) return back(c, '/admin/people');
  if (b.category !== undefined && p.role !== 'admin') {
    const cats = getCategories();
    if (cats.includes(String(b.category)) && b.category !== p.category) {
      db.prepare('UPDATE people SET category = ? WHERE id = ?').run(String(b.category), id);
      audit(u.id, 'person_category', `${p.name}: ${p.category} → ${b.category}`);
    }
  }
  if (b.role !== undefined && p.role !== 'admin') {
    if (Object.keys(ROLE_NAMES).includes(String(b.role)) && b.role !== 'admin' && b.role !== p.role) {
      db.prepare('UPDATE people SET role = ? WHERE id = ?').run(String(b.role), id);
      audit(u.id, 'person_role', `${p.name}: ${ROLE_NAMES[p.role]} → ${ROLE_NAMES[b.role]}`);
    }
  }
  return back(c, '/admin/people');
});

admin.post('/people/:id/restore', (c) => {
  const id = Number(c.req.param('id'));
  const p = db.prepare('SELECT name FROM people WHERE id = ?').get(id);
  db.prepare('UPDATE people SET active = 1 WHERE id = ?').run(id);
  audit(c.get('user').id, 'person_restore', p ? p.name : `#${id}`);
  return back(c, '/admin/people');
});

admin.post('/people/add', async (c) => {
  const u = c.get('user');
  const b = await c.req.parseBody();
  let roomId = null, roomNote = '';
  if (b.room_id === 'auto') {
    const sug = suggestRoom(String(b.category));
    if (sug) { roomId = sug.id; roomNote = `سُكّن تلقائياً في ${sug.name} (${sug.freeBeds} سرير شاغر)`; }
    else roomNote = 'لا توجد أسرّة شاغرة — بقي بدون سكن';
  } else if (b.room_id) roomId = Number(b.room_id);
  // الإداري يعيّن كل الأدوار عدا «إشراف عام»
  // دور «المؤسس» لا يُمنَح لأحد إطلاقاً
  const requested = String(b.role || '');
  const role = ROLE_NAMES[requested] && requested !== 'admin' ? requested : 'student';
  const token = newToken();
  const r = db.prepare(`INSERT INTO people (name, category, role, room_id, civil_id, phone, token) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(String(b.name).trim(), String(b.category), role, roomId, encrypt(String(b.civil_id || '').trim() || null), String(b.phone || '') || null, token);
  // ضمّه للجنة من نموذج الإضافة نفسه — بلا فتح صفحة اللجان
  let comNote = '';
  if (b.committee_id) {
    const cm = db.prepare('SELECT name FROM committees WHERE id = ?').get(Number(b.committee_id));
    if (cm) {
      db.prepare('INSERT OR IGNORE INTO committee_members (committee_id, person_id, is_head) VALUES (?, ?, ?)')
        .run(Number(b.committee_id), r.lastInsertRowid, b.is_head ? 1 : 0);
      comNote = ` · ${cm.name}${b.is_head ? ' (رئيساً)' : ''}`;
    }
  }
  audit(u.id, 'person_add', `${b.name} (${b.category}/${role}) ${roomNote}${comNote}`);
  return c.redirect(`/admin/people/${r.lastInsertRowid}?new=1${roomNote || comNote ? `&rn=${encodeURIComponent(roomNote + comNote)}` : ''}`);
});

admin.get('/people/:id', (c) => {
  const u = c.get('user');
  const p = db.prepare('SELECT p.*, r.name AS room_name FROM people p LEFT JOIN rooms r ON r.id=p.room_id WHERE p.id = ?').get(Number(c.req.param('id')));
  if (!p) return c.text('غير موجود', 404);
  // الرقم المدني مشفّر بالتخزين — يفكّه النظام للإدارة (الإشراف العام والإداريين)
  const civilShown = decrypt(p.civil_id) || '';
  const rooms = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM people x WHERE x.room_id=r.id AND x.active=1) occ FROM rooms r ORDER BY name`).all();
  const link = `${baseUrl(c)}/d/${p.token}`;
  const pts = db.prepare('SELECT COALESCE(SUM(value),0) v FROM points WHERE person_id = ?').get(p.id).v;
  const isNew = c.req.query('new');
  const roomNote = c.req.query('rn');
  return c.html(layout(p.name, `
    ${isNew ? `<div class="flash">✅ تمت الإضافة${roomNote ? ' — ' + esc(roomNote) : ''}. سلّمه الرابط أو الـ QR أدناه.</div>` : ''}
    <div class="card qrbox"><h3>رابط الدخول الشخصي + QR</h3>
      <img src="/qr/${p.token}.png" alt="QR">
      <div style="margin:8px 0"><input readonly value="${esc(link)}" onclick="this.select()" style="direction:ltr;text-align:center;font-size:12px"></div>
      <div class="row" style="justify-content:center">
        <button class="btn sm gold" onclick="navigator.clipboard.writeText('${esc(link)}').then(()=>this.textContent='✓ نُسخ')">📋 نسخ الرابط</button>
        <a class="btn sm ghost" href="https://wa.me/?text=${encodeURIComponent('رابط دخولك لتطبيق رحلة المدينة: ' + link)}" target="_blank">واتساب</a>
        <form method="post" action="/admin/people/${p.id}/retoken" onsubmit="return confirm('إلغاء الرابط الحالي وتوليد جديد؟')" style="display:inline"><button class="btn sm sec">🔄 رابط جديد</button></form>
      </div>
      ${isAdmin(u) && p.id !== u.id ? `<a class="btn sm ghost block" href="/viewas/${p.id}" style="margin-top:8px">👁️ معاينة التطبيق بحسابه</a>` : ''}
      </div>
    <div class="card"><h3>البيانات ${pts ? `— <span class="pill g">${pts} نقطة</span>` : ''}</h3>
      <form method="post" action="/admin/people/${p.id}/edit">
        <label>الاسم</label><input name="name" value="${esc(p.name)}" required>
        <div class="grid2">
          <div><label>الفئة</label><select name="category">${getCategories().map(x => `<option ${x === p.category ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
          <div><label>الدور</label>${p.role === 'admin'
            ? `<input value="${esc(ROLE_NAMES.admin)}" disabled title="لا يُعدَّل"><input type="hidden" name="role" value="admin">`
            : `<select name="role">${Object.entries(ROLE_NAMES).filter(([k]) => k !== 'admin')
                .map(([k, v]) => `<option value="${k}" ${k === p.role ? 'selected' : ''}>${v}</option>`).join('')}</select>`}</div>
        </div>
        <div class="grid2">
          <div><label>الرقم المدني 🔒 (مشفّر)</label><input name="civil_id" value="${esc(civilShown)}"></div>
          <div><label>الجوال</label><input name="phone" value="${esc(p.phone || '')}"></div>
        </div>
        <div class="grid2">
          <div><label>رقم المستخدم (منصة خليل)</label><input name="user_no" value="${esc(p.user_no || '')}"></div>
          <div><label>نوع الحلقة / المنهج</label><select name="track">
            <option value="">حفظ (بدون تحديد)</option>
            ${['ختمة مراجعة', 'ختمة مراجعة - الوصل', 'سند'].map(t => `<option ${t === p.track ? 'selected' : ''}>${t}</option>`).join('')}
          </select></div>
        </div>
        <label>السكن</label><select name="room_id"><option value="">بدون سكن</option>
          ${rooms.map(r => `<option value="${r.id}" ${r.id === p.room_id ? 'selected' : ''}>${esc(r.name)} (${r.occ}/${r.beds + r.extra_beds})</option>`).join('')}</select>
        <label>ملاحظات</label><input name="notes" value="${esc(p.notes || '')}">
        <button class="btn block" style="margin-top:10px">حفظ التعديلات</button>
      </form></div>
    <form method="post" action="/admin/people/${p.id}/delete" onsubmit="return confirm('حذف ${esc(p.name)} نهائياً من الرحلة؟')">
      <button class="btn block" style="background:#b22">🗑️ حذف من الرحلة</button></form>
    <p style="text-align:center"><a href="/admin/people">← رجوع لقائمة الأشخاص</a></p>
  `, { user: u, active: '/admin' }));
});

// حسابات الإشراف العام محصّنة: لا يعدّلها/يحذفها/يلغي رابطها إلا إشراف عام
function protectAdminTarget(c, id) {
  const t = db.prepare('SELECT role FROM people WHERE id = ?').get(id);
  return t && t.role === 'admin' && !isAdmin(c.get('user'));
}

admin.post('/people/:id/edit', async (c) => {
  const u = c.get('user');
  const id = Number(c.req.param('id'));
  if (protectAdminTarget(c, id)) return deny(c);
  const b = await c.req.parseBody();
  const cur = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
  // الإشراف العام يعيّن كل الأدوار عدا «رئيس الوفد» — تلك لرئيس الوفد وحده
  // «المؤسس» لا يُمنَح ولا يُسحَب — يبقى كما هو دائماً
  const requested = String(b.role || '');
  const role = cur.role === 'admin' ? 'admin'
    : (ROLE_NAMES[requested] && requested !== 'admin' ? requested : cur.role);
  const civil = encrypt(String(b.civil_id || '').trim() || null);
  db.prepare('UPDATE people SET name=?, category=?, role=?, civil_id=?, phone=?, room_id=?, notes=?, user_no=?, track=? WHERE id=?')
    .run(String(b.name).trim(), String(b.category), role, civil, String(b.phone || '') || null, b.room_id ? Number(b.room_id) : null, String(b.notes || '') || null,
      String(b.user_no || '').trim() || null, String(b.track || '').trim() || null, id);
  audit(u.id, 'person_edit', `${b.name} (#${id})`);
  return back(c, `/admin/people/${id}`);
});
admin.post('/people/:id/retoken', (c) => {
  const id = Number(c.req.param('id'));
  if (protectAdminTarget(c, id)) return deny(c);
  db.prepare('UPDATE people SET token = ? WHERE id = ?').run(newToken(), id);
  audit(c.get('user').id, 'retoken', `#${id}`);
  return back(c, `/admin/people/${id}`);
});
admin.post('/people/:id/delete', (c) => {
  const id = Number(c.req.param('id'));
  if (protectAdminTarget(c, id)) return deny(c);
  const p = db.prepare('SELECT name FROM people WHERE id = ?').get(id);
  db.prepare('UPDATE people SET active = 0, room_id = NULL WHERE id = ?').run(id);
  audit(c.get('user').id, 'person_delete', p ? p.name : `#${id}`);
  return back(c, '/admin/people');
});

// ===== الغرف =====
admin.get('/rooms', (c) => {
  const u = c.get('user');
  const rooms = db.prepare(`SELECT r.*, s.name AS sup_name,
    (SELECT COUNT(*) FROM people p WHERE p.room_id = r.id AND p.active=1) AS occ
    FROM rooms r LEFT JOIN people s ON s.id = r.supervisor_id ORDER BY r.type, r.name`).all();
  const people = db.prepare("SELECT id, name FROM people WHERE active=1 ORDER BY name").all();
  const noRoom = db.prepare("SELECT id, name, category FROM people WHERE active=1 AND room_id IS NULL ORDER BY name").all();
  return c.html(layout('الغرف والأجنحة', `
    <details class="fold"><summary><span class="ttl">➕ إضافة سكن جديد</span></summary><div class="foldbody">
      <form method="post" action="/admin/rooms/add">
        <div class="row" style="align-items:flex-end">
          <div class="grow"><label>الاسم</label><input name="name" placeholder="غرفة 1400" required></div>
          <div><label>النوع</label><select name="type" style="width:100px"><option>ملكي</option><option>رئاسي</option><option>رباعية</option></select></div>
        </div>
        <div class="row" style="align-items:flex-end;margin-top:6px">
          <div><label>رقم الغرفة بالفندق</label><input name="room_no" placeholder="1400" style="width:120px"></div>
          <div><label>عدد الأسرّة</label><input name="beds" type="number" min="1" value="4" style="width:90px"></div>
          <button class="btn sm">إضافة</button>
        </div></form>
      <div style="font-size:12px;color:var(--muted);line-height:1.8;margin-top:10px;border-top:1px solid var(--line);padding-top:8px">
        <b style="color:var(--ink)">شرح الأرقام:</b><br>
        • <b>الأسرّة الأساسية</b> = أسرّة الغرفة الثابتة في الفندق.<br>
        • <b>أسرّة إضافية</b> = أسرّة تُضاف عند الحاجة.<br>
        • <b>السعة</b> = الأساسية + الإضافية، و«٥ ساكن من ٦» تعني عدد الموجودين فعلاً من السعة.
      </div></div></details>
    <div class="searchbox"><input data-filter="#roomlist" placeholder="🔍 بحث بالغرف والأسماء..." autocomplete="off"></div>
    <div id="roomlist">
    ${rooms.map(r => {
      const members = db.prepare('SELECT id, name, category, role FROM people WHERE room_id = ? AND active=1 ORDER BY name').all(r.id);
      const cap = r.beds + r.extra_beds, free = cap - r.occ;
      return `<details class="fold" data-search="${esc([r.name, r.room_no, r.type, r.label, r.sup_name, ...members.map(m => m.name)].filter(Boolean).join(' '))}"><summary>
        <span class="ttl">${esc(r.name)}</span> <span class="pill g">${esc(r.type)}</span>
        ${r.label ? `<span class="pill o">${esc(r.label)}</span>` : ''}
        <span class="pill ${free < 0 ? 'r' : free === 0 ? 'o' : 'm'}">${r.occ} ساكن من ${cap}</span>
        ${free > 0 ? `<span class="pill g">${free} شاغر</span>` : free < 0 ? `<span class="pill r">زائد ${-free}</span>` : ''}
        ${(() => {
          const sups = supervisorsOfRoom(r.id);
          return sups.length ? sups.map(s => `<span class="pill b">${s.main ? '⭐' : '👤'} ${esc(s.name.split(' ')[0])} ${esc(s.name.split(' ').at(-1))}</span>`).join(' ')
            : '<span class="pill r">بلا مشرف</span>';
        })()}
      </summary><div class="foldbody">
      ${(() => {
        const extra = db.prepare('SELECT p.id, p.name FROM room_supervisors rs JOIN people p ON p.id = rs.person_id WHERE rs.room_id = ? ORDER BY p.name').all(r.id);
        return `<div style="margin:6px 0;padding:8px 10px;background:rgba(37,99,235,.05);border-radius:10px">
          <div style="font-size:12px;color:var(--muted);margin-bottom:5px">
            مشرفون مشاركون — أيّهم سجّل الرصد أو التقييم، سجّل عن الجميع (نفس الغرفة، نفس الشاشة)</div>
          ${extra.map(x => `<span class="pill b">${esc(x.name)}
            <a href="#" onclick="fetch('/admin/rooms/${r.id}/unsup?p=${x.id}',{method:'POST'}).then(()=>location.reload());return false" style="color:inherit">✕</a></span> `).join('')
            || '<span style="font-size:12px;color:var(--muted)">لا مشرف مشارك</span>'}
          <form method="post" action="/admin/rooms/${r.id}/addsup" class="row" style="margin-top:6px">
            <select name="person_id" class="grow" required><option value="">— اختر الاسم —</option>
              ${people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
            <button class="btn sm ghost">➕ ضم مشرفاً</button></form></div>`;
      })()}
      <form method="post" action="/admin/rooms/${r.id}/edit" style="margin:6px 0">
        <label>المشرف الأساسي</label>
        <select name="supervisor_id"><option value="">— بدون مشرف —</option>
          ${people.map(p => `<option value="${p.id}" ${p.id === r.supervisor_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <div class="row" style="margin-top:6px;align-items:flex-end">
          <div><label>الأسرّة الأساسية</label><input name="beds" type="number" min="0" value="${r.beds}" style="width:80px"></div>
          <div><label>أسرّة إضافية</label><input name="extra_beds" type="number" min="0" value="${r.extra_beds}" style="width:80px"></div>
          <div class="grow" style="font-size:11.5px;color:var(--muted);padding-bottom:11px">السعة = ${r.beds} + ${r.extra_beds} = <b>${cap}</b></div>
          <button class="btn sm">حفظ</button>
        </div></form>
      ${members.map(m => `<form method="post" action="/admin/rooms/assign" class="row" style="padding:4px 0;border-bottom:1px solid var(--line)">
        <input type="hidden" name="person_id" value="${m.id}">
        <div class="grow" style="font-size:13.5px">${esc(m.name)}${supBadge(m.role)} ${catPill(m.category)}</div>
        <select name="room_id" style="width:150px" onchange="this.form.submit()">
          <option value="">⬅ إخراج</option>${rooms.map(r2 => `<option value="${r2.id}" ${r2.id === r.id ? 'selected' : ''}>${esc(r2.name)}</option>`).join('')}</select>
      </form>`).join('') || '<div style="color:var(--muted);font-size:12px">فارغة</div>'}
      </div></details>`;
    }).join('')}
    </div>
  `, { user: u, active: '/admin', wide: true }));
});
// ضمّ مشرف مشارك للغرفة — الصلاحية نفسها داخل هذه الغرفة وحدها
admin.post('/rooms/:id/addsup', async (c) => {
  const u = c.get('user');
  const b = await c.req.parseBody();
  const rid = Number(c.req.param('id')), pid = Number(b.person_id);
  if (rid && pid) {
    db.prepare('INSERT OR IGNORE INTO room_supervisors (room_id, person_id) VALUES (?, ?)').run(rid, pid);
    db.prepare("UPDATE people SET role='room_supervisor' WHERE id=? AND role='student'").run(pid);
    audit(u.id, 'room_addsup', `غرفة ${rid} ← مشرف ${pid}`);
  }
  return back(c, '/admin/rooms');
});
admin.post('/rooms/:id/unsup', (c) => {
  const u = c.get('user');
  const rid = Number(c.req.param('id')), pid = Number(c.req.query('p'));
  db.prepare('DELETE FROM room_supervisors WHERE room_id=? AND person_id=?').run(rid, pid);
  audit(u.id, 'room_unsup', `غرفة ${rid} ✕ مشرف ${pid}`);
  return c.json({ ok: true });
});

admin.post('/rooms/add', async (c) => {
  const b = await c.req.parseBody();
  db.prepare('INSERT INTO rooms (name, type, beds, room_no) VALUES (?, ?, ?, ?)')
    .run(String(b.name).trim(), String(b.type), Number(b.beds) || 4, String(b.room_no || '') || null);
  audit(c.get('user').id, 'room_add', String(b.name));
  return back(c, '/admin/rooms');
});
admin.post('/rooms/:id/edit', async (c) => {
  const b = await c.req.parseBody();
  db.prepare('UPDATE rooms SET supervisor_id=?, beds=?, extra_beds=? WHERE id=?')
    .run(b.supervisor_id ? Number(b.supervisor_id) : null, Number(b.beds) || 4, Number(b.extra_beds) || 0, Number(c.req.param('id')));
  // مشرف الغرفة يأخذ دور مشرف غرفة تلقائياً إن كان طالباً
  if (b.supervisor_id) db.prepare("UPDATE people SET role='room_supervisor' WHERE id=? AND role='student'").run(Number(b.supervisor_id));
  audit(c.get('user').id, 'room_edit', `#${c.req.param('id')}`);
  return back(c, '/admin/rooms');
});
admin.post('/rooms/assign', async (c) => {
  const b = await c.req.parseBody();
  db.prepare('UPDATE people SET room_id = ? WHERE id = ?').run(b.room_id ? Number(b.room_id) : null, Number(b.person_id));
  audit(c.get('user').id, 'room_assign', `شخص #${b.person_id} ← غرفة ${b.room_id || 'بدون'}`);
  return back(c, '/admin/rooms');
});

// ===== تحضير الحلقات (فجر/عصر — حلقات المشايخ، لا علاقة لها بالغرف) =====
admin.get('/groups', (c) => {
  const u = c.get('user');
  const groups = db.prepare(`SELECT g.*,
    (SELECT COUNT(*) FROM att_group_members m WHERE m.group_id = g.id) AS n,
    (SELECT name FROM people WHERE id = g.supervisor_id) AS sup
    FROM att_groups g ORDER BY g.name`).all();
  const people = db.prepare("SELECT id, name, category FROM people WHERE active=1 ORDER BY name").all();
  const memberOf = {};
  db.prepare('SELECT group_id, person_id FROM att_group_members').all().forEach(r => memberOf[r.person_id] = r.group_id);
  const noCircle = people.filter(p => !memberOf[p.id]).length;
  return c.html(layout('تحضير الحلقات (فجر/عصر)', `
    <div class="card" style="font-size:13px;color:var(--muted)">📿 تحضير الفجر والعصر يتم <b>حلقةً حلقة</b> — كل حلقة لها مشرف يحضّر أعضاءها فقط. الحلقات مستقلة عن الغرف.
      ${noCircle ? `<div style="color:#b22;margin-top:4px">⚠️ ${noCircle} شخص بدون حلقة</div>` : ''}</div>
    <div class="card"><h3>➕ حلقة جديدة</h3>
      <form method="post" action="/admin/groups/add" class="row">
        <input name="name" placeholder="اسم الحلقة (حلقة الشيخ فلان)" required class="grow">
        <select name="supervisor_id" class="grow"><option value="">— مشرف الحلقة —</option>${people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <button class="btn sm">إضافة</button></form></div>
    ${groups.map(g => {
      const members = db.prepare(`SELECT p.id, p.name, p.category FROM att_group_members m
        JOIN people p ON p.id = m.person_id WHERE m.group_id = ? AND p.active = 1 ORDER BY p.name`).all(g.id);
      const others = people.filter(p => memberOf[p.id] !== g.id);
      return `<details class="fold" data-search="${esc([g.name, g.sup, ...members.map(m => m.name)].filter(Boolean).join(' '))}"><summary>
          <span class="ttl">📿 ${esc(g.name)}</span>
          <span class="pill ${g.sup ? 'b' : 'r'}">${g.sup ? '⭐ ' + esc(g.sup.split(' ')[0]) + ' ' + esc(g.sup.split(' ').at(-1)) : 'بلا مشرف'}</span>
          <span class="pill m">${members.length} طالب</span>
        </summary><div class="foldbody">
        <form method="post" action="/admin/groups/${g.id}/delete" onsubmit="return confirm('حذف الحلقة كاملة؟ (الأعضاء يرجعون بلا حلقة)')" style="text-align:left"><button class="btn sm" style="background:#b22">حذف الحلقة</button></form>

        <div class="searchbox" style="position:static;padding:6px 0"><input data-filter="#mem${g.id}" placeholder="🔍 بحث في أعضاء الحلقة..." autocomplete="off"></div>
        <div id="mem${g.id}">
          ${members.map(p => `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line)">
            <div class="grow" style="font-size:13.5px">${esc(p.name)} ${catPill(p.category)}</div>
            <form method="post" action="/admin/groups/${g.id}/remove"><input type="hidden" name="person_id" value="${p.id}">
              <button class="btn sm ghost" title="حذف من الحلقة">✗ حذف</button></form>
          </div>`).join('') || '<div style="color:var(--muted);font-size:12.5px">الحلقة فارغة</div>'}
        </div>

        <details style="margin-top:10px">
          <summary style="cursor:pointer;font-weight:600;color:var(--green);padding:8px 0">➕ إضافة طلاب لهذه الحلقة</summary>
          <form method="post" action="/admin/groups/${g.id}/addmembers">
            <div class="searchbox" style="position:static;padding:6px 0"><input data-filter="#add${g.id}" placeholder="🔍 بحث بالاسم..." autocomplete="off"></div>
            <div id="add${g.id}" style="max-height:340px;overflow-y:auto;border:1px solid var(--line);border-radius:10px;padding:6px">
              ${others.map(p => `<label class="row" style="padding:5px 4px;border-bottom:1px solid var(--line);cursor:pointer">
                <input type="checkbox" name="ids" value="${p.id}" style="width:auto;flex:none">
                <div class="grow" style="font-size:13.5px">${esc(p.name)} ${catPill(p.category)}
                  ${memberOf[p.id] ? `<span class="pill o">في: ${esc(groups.find(x => x.id === memberOf[p.id])?.name || '')}</span>` : '<span class="pill r">بلا حلقة</span>'}</div>
              </label>`).join('')}
            </div>
            <button class="btn block" style="margin-top:8px">إضافة المحدَّدين للحلقة</button>
            <div style="font-size:11px;color:var(--muted);text-align:center">من كان في حلقة أخرى يُنقل لهذه الحلقة</div>
          </form>
        </details>
      </div></details>`;
    }).join('')}
    ${noCircle ? `<details class="fold"><summary><span class="ttl">⚠️ بلا حلقة</span><span class="pill r">${noCircle}</span></summary><div class="foldbody">
      <div class="searchbox" style="position:static;padding:6px 0"><input data-filter="#nogrp" placeholder="🔍 بحث..." autocomplete="off"></div>
      <div id="nogrp">${people.filter(p => !memberOf[p.id]).map(p => `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line)">
        <div class="grow" style="font-size:13.5px">${esc(p.name)} ${catPill(p.category)}</div>
        <form method="post" action="/admin/groups/assign" class="row"><input type="hidden" name="person_id" value="${p.id}">
          <select name="group_id" onchange="this.form.submit()" style="width:170px"><option value="">— اختر حلقة —</option>
            ${groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></form>
      </div>`).join('')}</div></div></details>` : ''}
  `, { user: u, active: '/admin', wide: true }));
});
// حذف عضو من حلقة
admin.post('/groups/:id/remove', async (c) => {
  const b = await c.req.parseBody();
  db.prepare('DELETE FROM att_group_members WHERE group_id = ? AND person_id = ?').run(Number(c.req.param('id')), Number(b.person_id));
  audit(c.get('user').id, 'group_remove', `#${b.person_id} من حلقة #${c.req.param('id')}`);
  return back(c, '/admin/groups');
});
// إضافة عدة طلاب دفعة واحدة (ينقلهم من حلقاتهم السابقة)
admin.post('/groups/:id/addmembers', async (c) => {
  const gid = Number(c.req.param('id'));
  const b = await c.req.parseBody({ all: true });
  const ids = (Array.isArray(b.ids) ? b.ids : b.ids ? [b.ids] : []).map(Number).filter(Boolean);
  const del = db.prepare('DELETE FROM att_group_members WHERE person_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO att_group_members (group_id, person_id) VALUES (?, ?)');
  for (const id of ids) { del.run(id); ins.run(gid, id); }
  audit(c.get('user').id, 'group_addmembers', `${ids.length} طالب ← حلقة #${gid}`);
  return back(c, '/admin/groups');
});
admin.post('/groups/add', async (c) => {
  const b = await c.req.parseBody();
  db.prepare('INSERT INTO att_groups (name, supervisor_id) VALUES (?, ?)').run(String(b.name), b.supervisor_id ? Number(b.supervisor_id) : null);
  if (b.supervisor_id) db.prepare("UPDATE people SET role='attendance_supervisor' WHERE id=? AND role='student'").run(Number(b.supervisor_id));
  audit(c.get('user').id, 'group_add', String(b.name));
  return back(c, '/admin/groups');
});
admin.post('/groups/:id/delete', (c) => {
  db.prepare('DELETE FROM att_groups WHERE id = ?').run(Number(c.req.param('id')));
  return back(c, '/admin/groups');
});
admin.post('/groups/assign', async (c) => {
  const b = await c.req.parseBody();
  db.prepare('DELETE FROM att_group_members WHERE person_id = ?').run(Number(b.person_id));
  if (b.group_id) db.prepare('INSERT INTO att_group_members (group_id, person_id) VALUES (?, ?)').run(Number(b.group_id), Number(b.person_id));
  return back(c, '/admin/groups');
});

// ===== مواعيد التحضير =====
admin.get('/slots', (c) => {
  const u = c.get('user');
  const slots = getSlots();
  const m = c.req.query('m');
  const whoName = { attendance: 'مشرفو الحلقات (تحضير عام)', room: 'مشرفو الغرف (تحضير داخل الغرفة)' };
  return c.html(layout('مواعيد التحضير', `
    ${m ? `<div class="flash">${esc(m)}</div>` : ''}
    <form method="post" action="/admin/slots">
    ${slots.map((s, i) => `<div class="card">
      <div class="row"><h3 class="grow" style="margin:0">${esc(s.label)}</h3><span class="pill ${s.who === 'room' ? 'o' : 'g'}">${whoName[s.who]}</span></div>
      <input type="hidden" name="key_${i}" value="${esc(s.key)}">
      <div class="grid2">
        <div><label>الاسم الظاهر</label><input name="label_${i}" value="${esc(s.label)}" required></div>
        <div><label>الوقت</label><input type="time" name="time_${i}" value="${esc(s.time)}" required></div>
      </div>
      <label class="row" style="margin-top:8px"><input type="checkbox" name="enabled_${i}" ${s.enabled ? 'checked' : ''} style="width:auto"> مفعّل</label>
    </div>`).join('')}
    <button class="btn block" style="margin-top:4px">حفظ كل المواعيد</button>
    </form>
    <div class="card" style="font-size:12.5px;color:var(--muted)">مواعيد «مشرفي الغرف» تظهر في شاشة التحضير عندهم، ومواعيد «مشرفي الحلقات» في شاشة التحضير. التعديل يسري فوراً.</div>
  `, { user: u, active: '/admin' }));
});
admin.post('/slots', async (c) => {
  const b = await c.req.parseBody();
  const slots = getSlots().map((s, i) => ({
    ...s,
    label: String(b[`label_${i}`] || s.label).trim(),
    time: String(b[`time_${i}`] || s.time),
    enabled: b[`enabled_${i}`] ? 1 : 0,
  }));
  setSetting('att_slots', JSON.stringify(slots));
  audit(c.get('user').id, 'slots_edit', slots.map(s => `${s.label}@${s.time}${s.enabled ? '' : ' (معطّل)'}`).join('، '));
  return back(c, '/admin/slots', 'حُفظت المواعيد');
});

// ===== الرسالة اليومية =====
admin.get('/message', (c) => {
  const u = c.get('user');
  const msgs = db.prepare('SELECT * FROM daily_messages ORDER BY date DESC LIMIT 15').all();
  const d = today();
  const cur = msgs.find(m => m.date === d);
  return c.html(layout('الرسالة اليومية', `
    <div class="card"><h3>رسالة يوم ${d}</h3>
      <form method="post" action="/admin/message">
        <input type="hidden" name="date" value="${d}">
        <textarea name="text" rows="4" required placeholder="الكلمة التحفيزية لليوم...">${esc(cur?.text || '')}</textarea>
        <button class="btn block" style="margin-top:10px">${cur ? 'تحديث' : 'نشر'} الرسالة</button>
      </form></div>
    <div class="card"><h3>رسالة ليوم قادم</h3>
      <form method="post" action="/admin/message">
        <label>التاريخ</label><input type="date" name="date" required>
        <label>النص</label><textarea name="text" rows="3" required></textarea>
        <button class="btn block sec" style="margin-top:10px">جدولة</button>
      </form></div>
    ${msgs.map(m => `<div class="card"><b class="num">${esc(m.date)}</b><br>${esc(m.text)}</div>`).join('')}
  `, { user: u, active: '/admin' }));
});
admin.post('/message', async (c) => {
  const b = await c.req.parseBody();
  db.prepare(`INSERT INTO daily_messages (date, text, author) VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET text = excluded.text, author = excluded.author`)
    .run(String(b.date), String(b.text).trim(), c.get('user').name);
  audit(c.get('user').id, 'daily_message', String(b.date));
  return back(c, '/admin/message');
});

// ===== السؤال اليومي =====
admin.get('/quiz', (c) => {
  const u = c.get('user');
  const d = c.req.query('d') || today();
  const cur = db.prepare('SELECT * FROM daily_quiz WHERE date = ?').get(d);
  const opts = cur ? JSON.parse(cur.options) : ['', '', '', ''];
  // إحصائية إجابات اليوم
  const stats = db.prepare('SELECT COUNT(*) n, SUM(correct) c FROM quiz_answers WHERE date = ?').get(d);
  const recent = db.prepare('SELECT * FROM daily_quiz ORDER BY date DESC LIMIT 10').all();
  return c.html(layout('السؤال اليومي', `
    <div class="card"><h3>❓ سؤال يوم ${esc(d)}</h3>
      <form method="post" action="/admin/quiz">
        <input type="hidden" name="date" value="${esc(d)}">
        <label>التاريخ (لجدولة يوم قادم غيّره)</label><input type="date" name="date" value="${esc(d)}">
        <label>السؤال</label><textarea name="question" rows="2" required placeholder="مثال: كم عدد أبواب المسجد النبوي؟">${esc(cur?.question || '')}</textarea>
        <label>الخيارات (اضغط دائرة الخيار الصحيح)</label>
        ${[0, 1, 2, 3].map(i => `<div class="row" style="margin:5px 0">
          <input type="radio" name="correct" value="${i}" ${cur && cur.correct === i ? 'checked' : i === 0 && !cur ? 'checked' : ''} style="width:auto;flex:none">
          <input name="opt${i}" value="${esc(opts[i] || '')}" placeholder="الخيار ${i + 1}" ${i < 2 ? 'required' : ''} class="grow">
        </div>`).join('')}
        <label>نقاط الإجابة الصحيحة</label><input type="number" name="points" value="${cur?.points || 5}" min="1" style="width:100px">
        <button class="btn block" style="margin-top:10px">${cur ? 'تحديث السؤال' : 'نشر السؤال'}</button>
      </form>
      ${cur ? `<div style="margin-top:8px;font-size:12.5px;color:var(--muted)">أجاب ${stats.n || 0} — منهم ${stats.c || 0} صحيح</div>
      <form method="post" action="/admin/quiz/${esc(d)}/delete" onsubmit="return confirm('حذف سؤال هذا اليوم وإجاباته؟')"><button class="btn sm" style="background:#b22;margin-top:6px">حذف السؤال</button></form>` : ''}
    </div>
    <div class="card"><h3>الأسئلة الأخيرة</h3>
      ${recent.map(q => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">
        <b class="num" style="width:80px">${esc(q.date)}</b><a href="/admin/quiz?d=${esc(q.date)}" class="grow">${esc(q.question.slice(0, 50))}</a></div>`).join('') || 'لا أسئلة بعد'}
    </div>
  `, { user: u, active: '/admin' }));
});
admin.post('/quiz', async (c) => {
  const b = await c.req.parseBody();
  const opts = [0, 1, 2, 3].map(i => String(b[`opt${i}`] || '').trim()).filter(Boolean);
  if (opts.length < 2) return back(c, '/admin/quiz', 'أدخل خيارين على الأقل');
  const correct = Math.min(opts.length - 1, Math.max(0, Number(b.correct) || 0));
  db.prepare(`INSERT INTO daily_quiz (date, question, options, correct, points, author) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET question=excluded.question, options=excluded.options, correct=excluded.correct, points=excluded.points`)
    .run(String(b.date), String(b.question).trim(), JSON.stringify(opts), correct, Number(b.points) || 5, c.get('user').name);
  audit(c.get('user').id, 'quiz_set', String(b.date));
  return back(c, '/admin/quiz?d=' + b.date);
});
admin.post('/quiz/:date/delete', (c) => {
  const d = c.req.param('date');
  db.prepare('DELETE FROM daily_quiz WHERE date = ?').run(d);
  db.prepare("DELETE FROM points WHERE date = ? AND source = 'quiz'").run(d);
  audit(c.get('user').id, 'quiz_delete', d);
  return back(c, '/admin/quiz');
});

// ===== جدول اليوم =====
admin.get('/schedule', (c) => {
  const u = c.get('user');
  const d = c.req.query('d') || today();
  const items = db.prepare('SELECT * FROM schedule WHERE date = ? ORDER BY time').all(d);
  return c.html(layout('جدول اليوم', `
    <div class="card"><form class="row"><input type="date" name="d" value="${esc(d)}" onchange="this.form.submit()"></form></div>
    <div class="card"><h3>➕ فقرة جديدة (${esc(d)})</h3>
      <form method="post" action="/admin/schedule/add" class="row">
        <input type="hidden" name="date" value="${esc(d)}">
        <input name="time" type="time" required style="width:110px">
        <input name="title" placeholder="الفقرة (الغداء، البرنامج الثقافي...)" required class="grow">
        <select name="scope" style="width:110px"><option>الجميع</option>${getCategories().map(x => `<option>${x}</option>`).join('')}<option>المشرفون</option></select>
        <button class="btn sm">إضافة</button></form></div>
    <div class="card">${items.map(s => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">
      <b class="num" style="width:54px">${esc(s.time)}</b><div class="grow">${esc(s.title)}</div><span class="pill g">${esc(s.scope)}</span>
      <form method="post" action="/admin/schedule/${s.id}/delete"><button class="btn sm ghost">🗑</button></form></div>`).join('') || 'لا فقرات لهذا اليوم'}</div>
    <form method="post" action="/admin/schedule/copy" class="card row">
      <input type="hidden" name="from" value="${esc(d)}"><label class="grow">نسخ جدول هذا اليوم إلى:</label>
      <input type="date" name="to" required><button class="btn sm sec">نسخ</button></form>
  `, { user: u, active: '/admin' }));
});
admin.post('/schedule/add', async (c) => {
  const b = await c.req.parseBody();
  db.prepare('INSERT INTO schedule (date, time, title, scope) VALUES (?, ?, ?, ?)').run(String(b.date), String(b.time), String(b.title), String(b.scope));
  return back(c, '/admin/schedule?d=' + b.date);
});
admin.post('/schedule/:id/delete', (c) => {
  db.prepare('DELETE FROM schedule WHERE id = ?').run(Number(c.req.param('id')));
  return back(c, '/admin/schedule');
});
admin.post('/schedule/copy', async (c) => {
  const b = await c.req.parseBody();
  const items = db.prepare('SELECT * FROM schedule WHERE date = ?').all(String(b.from));
  const ins = db.prepare('INSERT INTO schedule (date, time, title, scope) VALUES (?, ?, ?, ?)');
  items.forEach(s => ins.run(String(b.to), s.time, s.title, s.scope));
  return back(c, '/admin/schedule?d=' + b.to);
});

// ===== أوقات الصلاة =====
admin.get('/prayers', (c) => {
  const u = c.get('user');
  const city = getSetting('current_city', 'المدينة');
  const rows = db.prepare('SELECT * FROM prayer_times WHERE city = ? AND date >= ? ORDER BY date LIMIT 15').all(city, today());
  const m = c.req.query('m');
  return c.html(layout('أوقات الصلاة', `
    ${m ? `<div class="flash">${esc(m)}</div>` : ''}
    <div class="card"><div class="row">
      <div class="grow"><b>المدينة الحالية:</b></div>
      <form method="post" action="/admin/prayers/city" class="row">
        <select name="city">${['المدينة', 'مكة'].map(x => `<option ${x === city ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <button class="btn sm">تغيير</button></form></div>
      <form method="post" action="/admin/prayers/fetch" style="margin-top:8px">
        <button class="btn block gold">🌐 جلب أوقات ٢٠ يوماً من الإنترنت (أم القرى)</button>
        <div style="font-size:11px;color:var(--muted);text-align:center;margin-top:4px">لا يمس الأيام المعدَّلة يدوياً</div></form></div>
    <div class="card"><h3>تعديل/إدخال يدوي</h3>
      <form method="post" action="/admin/prayers/manual">
        <div class="row"><input type="date" name="date" value="${today()}" required></div>
        <div class="row" style="margin-top:6px">
          ${['fajr:الفجر', 'dhuhr:الظهر', 'asr:العصر', 'maghrib:المغرب', 'isha:العشاء'].map(x => { const [k, l] = x.split(':'); return `<div class="grow"><label>${l}</label><input type="time" name="${k}" required></div>`; }).join('')}
        </div><button class="btn block" style="margin-top:10px">حفظ يدوياً</button></form></div>
    <div class="card"><h3>الأيام القادمة — ${esc(city)}</h3><table>
      <tr><th>التاريخ</th><th>فجر</th><th>ظهر</th><th>عصر</th><th>مغرب</th><th>عشاء</th><th>المصدر</th></tr>
      ${rows.map(r => `<tr class="num"><td>${esc(r.date)}</td><td>${esc(r.fajr)}</td><td>${esc(r.dhuhr)}</td><td>${esc(r.asr)}</td><td>${esc(r.maghrib)}</td><td>${esc(r.isha)}</td>
        <td>${r.source === 'manual' ? '<span class="pill o">يدوي</span>' : '<span class="pill g">تلقائي</span>'}</td></tr>`).join('')}
    </table></div>
  `, { user: u, active: '/admin', wide: true }));
});
admin.post('/prayers/city', async (c) => {
  const b = await c.req.parseBody();
  setSetting('current_city', String(b.city));
  audit(c.get('user').id, 'city_change', String(b.city));
  return back(c, '/admin/prayers');
});
admin.post('/prayers/fetch', async (c) => {
  const city = getSetting('current_city', 'المدينة');
  try {
    const r = await fetchRange(today(), 20, city);
    return back(c, '/admin/prayers', `تم الجلب: ${r.ok} يوم ناجح${r.fail ? `، ${r.fail} فشل` : ''}`);
  } catch (e) {
    return back(c, '/admin/prayers', 'تعذّر الجلب — تأكد من الإنترنت');
  }
});
admin.post('/prayers/manual', async (c) => {
  const b = await c.req.parseBody();
  savePrayers(String(b.date), getSetting('current_city', 'المدينة'),
    { fajr: b.fajr, dhuhr: b.dhuhr, asr: b.asr, maghrib: b.maghrib, isha: b.isha }, 'manual');
  audit(c.get('user').id, 'prayers_manual', String(b.date));
  return back(c, '/admin/prayers', 'حُفظت الأوقات يدوياً');
});

// ===== مراحل الباصات =====
admin.get('/buses', (c) => {
  const u = c.get('user');
  const stages = db.prepare(`SELECT s.*,
    (SELECT COUNT(*) FROM boardings b WHERE b.stage_id = s.id AND b.status='boarded') AS boarded,
    (SELECT COUNT(*) FROM boardings b WHERE b.stage_id = s.id AND b.status='exempt') AS exempt
    FROM bus_stages s ORDER BY s.ord`).all();
  const total = db.prepare("SELECT COUNT(*) c FROM people WHERE active=1").get().c;
  return c.html(layout('مراحل الباصات', `
    <div class="card"><h3>➕ مرحلة انتقال جديدة</h3>
      <form method="post" action="/admin/buses/add" class="row">
        <input name="name" placeholder="مثال: فندق المدينة ← الحرم" required class="grow"><button class="btn sm">إضافة</button></form></div>
    ${stages.map(s => `<div class="card ${s.active ? '' : ''}" ${s.active ? 'style="border:2px solid var(--gold)"' : ''}>
      <div class="row"><h3 class="grow" style="margin:0">${esc(s.name)}</h3>${s.active ? '<span class="pill o">جارية الآن</span>' : ''}</div>
      <div class="row" style="margin:8px 0">
        <div class="stat grow"><div class="v num">${s.boarded}</div><div class="l">ركبوا</div></div>
        <div class="stat grow ${total - s.boarded - s.exempt > 0 ? 'warn' : ''}"><div class="v num">${total - s.boarded - s.exempt}</div><div class="l">متبقّي</div></div>
        <div class="stat grow"><div class="v num">${s.exempt}</div><div class="l">مستأذن</div></div></div>
      <div class="row">
        <a class="btn sm grow" href="/bus?stage=${s.id}">فتح لوحة المتابعة</a>
        <form method="post" action="/admin/buses/${s.id}/toggle"><button class="btn sm ${s.active ? 'sec' : 'gold'}">${s.active ? 'إنهاء المرحلة' : 'تفعيل الآن'}</button></form>
        <form method="post" action="/admin/buses/${s.id}/reset" onsubmit="return confirm('مسح كل تسجيلات هذه المرحلة؟')"><button class="btn sm ghost">تصفير</button></form>
      </div></div>`).join('')}
  `, { user: u, active: '/admin' }));
});
admin.post('/buses/add', async (c) => {
  const b = await c.req.parseBody();
  const mx = db.prepare('SELECT COALESCE(MAX(ord),0) m FROM bus_stages').get().m;
  db.prepare('INSERT INTO bus_stages (name, ord, active) VALUES (?, ?, 0)').run(String(b.name), mx + 1);
  audit(c.get('user').id, 'stage_add', String(b.name));
  return back(c, '/admin/buses');
});
admin.post('/buses/:id/toggle', (c) => {
  const id = Number(c.req.param('id'));
  const cur = db.prepare('SELECT active FROM bus_stages WHERE id = ?').get(id);
  db.prepare('UPDATE bus_stages SET active = 0').run(); // مرحلة واحدة جارية فقط
  if (!cur.active) db.prepare('UPDATE bus_stages SET active = 1 WHERE id = ?').run(id);
  audit(c.get('user').id, 'stage_toggle', `#${id} ${cur.active ? 'إنهاء' : 'تفعيل'}`);
  return back(c, '/admin/buses');
});
admin.post('/buses/:id/reset', (c) => {
  db.prepare('DELETE FROM boardings WHERE stage_id = ?').run(Number(c.req.param('id')));
  audit(c.get('user').id, 'stage_reset', `#${c.req.param('id')}`);
  return back(c, '/admin/buses');
});

// ===== اللجان =====
admin.get('/committees', (c) => {
  const u = c.get('user');
  const coms = db.prepare("SELECT * FROM committees ORDER BY CASE branch WHEN 'الإشراف الفني والتنسيق' THEN 0 WHEN 'الإدارة العامة لشؤون الرحلة' THEN 1 ELSE 2 END, name").all();
  const people = db.prepare("SELECT id, name FROM people WHERE active=1 ORDER BY name").all();
  return c.html(layout('اللجان والمهام', `
    <div class="card"><form method="post" action="/admin/committees/add" class="row">
      <input name="name" placeholder="لجنة جديدة" required class="grow"><button class="btn sm">إضافة</button></form></div>
    <div class="searchbox"><input data-filter="#comlist" placeholder="🔍 بحث باللجان والأسماء والمهام..." autocomplete="off"></div>
    <div id="comlist">
    ${coms.map(cm => {
      const members = db.prepare(`SELECT p.id, p.name, m.is_head FROM committee_members m JOIN people p ON p.id = m.person_id WHERE m.committee_id = ?`).all(cm.id);
      const tasks = db.prepare(`SELECT t.*, (SELECT 1 FROM task_done td WHERE td.task_id = t.id AND td.date = ?) AS done_today
        FROM committee_tasks t WHERE t.committee_id = ? ORDER BY t.id DESC LIMIT 20`).all(today(), cm.id)
        .map(t => ({ ...t, isDone: PER_DAY.has(t.kind) ? !!t.done_today : !!t.done }))
        .filter(t => taskDueToday(t));
      const doneN = tasks.filter(t => t.isDone).length;
      const head = members.find(m => m.is_head);
      return `<details class="fold" data-search="${esc([cm.name, cm.branch, ...members.map(m => m.name), ...tasks.map(t => t.title)].filter(Boolean).join(' '))}"><summary>
        <span class="ttl">${esc(cm.name)}</span>
        ${cm.branch ? `<span class="pill ${cm.branch.includes('الفني') ? 'm' : 'b'}" style="font-weight:400">${esc(cm.branch)}</span>` : ''}
        ${head ? `<span class="pill o">👑 ${esc(head.name.split(' ')[0])} ${esc(head.name.split(' ').at(-1))}</span>` : '<span class="pill r">بلا رئيس</span>'}
        <span class="pill m">${members.length} عضو</span>
        <span class="pill ${!tasks.length ? 'r' : doneN >= tasks.length ? 'g' : 'o'}">${tasks.length ? `${doneN}/${tasks.length} مهمة اليوم` : 'لا مهام'}</span>
      </summary><div class="foldbody">
      <div style="margin:6px 0">${members.map(m => `<span class="pill ${m.is_head ? 'o' : 'g'}">${esc(m.name)}${m.is_head ? ' 👑' : ''}
        <a href="#" onclick="fetch('/admin/committees/${cm.id}/unmember?p=${m.id}',{method:'POST'}).then(()=>location.reload());return false" style="color:inherit">✕</a></span> `).join('')}</div>
      <form method="post" action="/admin/committees/${cm.id}/member" class="row">
        <select name="person_id" class="grow" required><option value="">— اختر الاسم —</option>
          ${people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <label class="row" style="margin:0;font-size:12px"><input type="checkbox" name="is_head" style="width:auto"> رئيس</label>
        <button class="btn sm">ضم</button></form>
      <form method="post" action="/admin/committees/${cm.id}/task" class="row" style="margin-top:6px">
        <input name="title" placeholder="مهمة جديدة..." required class="grow">
        ${RP_SCRIPT}<select name="kind" style="width:140px" onchange="rpSync(this)">
          ${Object.entries(REPEATS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
        <span class="rp1" style="display:none"><select name="weekday" style="width:100px">${WEEK.map((w, i) => `<option value="${i}" ${i === 5 ? 'selected' : ''}>${w}</option>`).join('')}</select></span>
        <span class="rp2" style="display:none"><select name="weekday2" style="width:100px">${WEEK.map((w, i) => `<option value="${i}" ${i === 3 ? 'selected' : ''}>${w}</option>`).join('')}</select></span>
        <button class="btn sm sec">إضافة</button></form>
      ${tasks.map(t => `<div class="row" style="padding:4px 0;border-bottom:1px solid var(--line);font-size:13px">
        <span>${t.isDone ? '✅' : '⬜'}</span><div class="grow" style="${t.isDone ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(t.title)} ${repeatBadge(t.kind, t.weekday, t.weekday2)}</div>
        <form method="post" action="/admin/tasks/${t.id}/toggle"><button class="btn sm ghost">${t.isDone ? 'إرجاع' : 'تم'}</button></form>
        <form method="post" action="/admin/tasks/${t.id}/delete" onsubmit="return confirm('حذف المهمة نهائياً؟')"><button class="btn sm ghost">🗑</button></form></div>`).join('')}
      </div></details>`;
    }).join('')}
    </div>
  `, { user: u, active: '/admin', wide: true }));
});
admin.post('/tasks/:id/delete', (c) => {
  db.prepare('DELETE FROM committee_tasks WHERE id = ?').run(Number(c.req.param('id')));
  audit(c.get('user').id, 'task_delete', `#${c.req.param('id')}`);
  return back(c, '/admin/committees');
});
admin.post('/committees/add', async (c) => {
  const b = await c.req.parseBody();
  db.prepare('INSERT INTO committees (name) VALUES (?)').run(String(b.name));
  return back(c, '/admin/committees');
});
admin.post('/committees/:id/member', async (c) => {
  const b = await c.req.parseBody();
  db.prepare('INSERT OR REPLACE INTO committee_members (committee_id, person_id, is_head) VALUES (?, ?, ?)')
    .run(Number(c.req.param('id')), Number(b.person_id), b.is_head ? 1 : 0);
  return back(c, '/admin/committees');
});
admin.post('/committees/:id/unmember', (c) => {
  db.prepare('DELETE FROM committee_members WHERE committee_id = ? AND person_id = ?')
    .run(Number(c.req.param('id')), Number(c.req.query('p')));
  return c.json({ ok: true });
});
admin.post('/committees/:id/task', async (c) => {
  const b = await c.req.parseBody();
  const kind = REPEATS[String(b.kind)] ? String(b.kind) : 'once';
  const needsDay = kind === 'weekly' || kind === 'twice';
  const wd = needsDay ? wdOf(b.weekday, 5) : null;
  const wd2 = kind === 'twice' ? wdOf(b.weekday2, 3) : null;
  db.prepare('INSERT INTO committee_tasks (committee_id, title, kind, date, weekday, weekday2) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Number(c.req.param('id')), String(b.title), kind, today(), wd, wd2);
  return back(c, '/admin/committees');
});
admin.post('/tasks/:id/toggle', (c) => {
  const id = Number(c.req.param('id'));
  const t = db.prepare('SELECT done, kind FROM committee_tasks WHERE id = ?').get(id);
  if (PER_DAY.has(t.kind)) {
    const d = today();
    const doneToday = db.prepare('SELECT 1 FROM task_done WHERE task_id = ? AND date = ?').get(id, d);
    if (doneToday) db.prepare('DELETE FROM task_done WHERE task_id = ? AND date = ?').run(id, d);
    else db.prepare('INSERT INTO task_done (task_id, date, done_by, done_at) VALUES (?, ?, ?, ?)').run(id, d, c.get('user').id, now());
  } else {
    db.prepare('UPDATE committee_tasks SET done = ?, done_by = ?, done_at = ? WHERE id = ?')
      .run(t.done ? 0 : 1, c.get('user').id, now(), id);
  }
  return back(c, '/admin/committees');
});

// ===== الطلبات =====
admin.get('/requests', (c) => {
  const u = c.get('user');
  const reqs = db.prepare(`SELECT r.*, p.name AS person, cm.name AS committee FROM requests r
    LEFT JOIN people p ON p.id = r.person_id LEFT JOIN committees cm ON cm.id = r.committee_id
    ORDER BY CASE r.status WHEN 'new' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END, r.id DESC LIMIT 100`).all();
  const stName = { new: 'جديد', processing: 'قيد المعالجة', done: 'تم' };
  return c.html(layout('الطلبات والاقتراحات', `
    <div class="searchbox"><input data-filter="#reqlist" placeholder="🔍 بحث بالأسماء والنصوص..." autocomplete="off"></div>
    <div id="reqlist">
    ${reqs.map(r => `<div class="card"><div class="row">
      <span class="pill ${r.category === 'بلاغ طبي' ? 'r' : 'm'}">${esc(r.category || '')}</span>
      <div class="grow" style="font-size:12px;color:var(--muted)">${esc(r.person || '؟')} ← ${esc(r.committee || 'عام')}</div>
      <span class="pill ${r.status === 'done' ? 'g' : r.status === 'processing' ? 'o' : 'r'}">${stName[r.status]}</span></div>
      <div style="margin:6px 0">${esc(r.text)}</div>
      <div class="row">${['new', 'processing', 'done'].filter(s => s !== r.status).map(s =>
        `<form method="post" action="/admin/requests/${r.id}/status" class="grow"><input type="hidden" name="status" value="${s}">
        <button class="btn sm block ${s === 'done' ? '' : 'ghost'}">${stName[s]}</button></form>`).join('')}</div>
    </div>`).join('') || '<div class="card">لا طلبات بعد</div>'}
    </div>
  `, { user: u, active: '/admin' }));
});
admin.post('/requests/:id/status', async (c) => {
  const b = await c.req.parseBody();
  db.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run(String(b.status), now(), Number(c.req.param('id')));
  audit(c.get('user').id, 'request_status', `#${c.req.param('id')} ← ${b.status}`);
  return back(c, '/admin/requests');
});

// ===== قواعد النقاط =====
admin.get('/points', (c) => {
  const u = c.get('user');
  const rules = getRules();
  const people = db.prepare("SELECT id, name FROM people WHERE active=1 ORDER BY name").all();
  const labels = { attendance_present: 'نقاط الحضور (للموعد الواحد)', attendance_late: 'نقاط التأخير ⏱', cleanliness_star: 'نقاط الغرفة لكل نجمة جاهزية', behavior_max: 'أقصى نقاط سلوك بالمرة (±)', behavior_person_cap: 'سقف الطالب اليومي — وبه تُحسب ميزانية كل غرفة' };
  return c.html(layout('قواعد النقاط', `
    <div class="card"><h3>القيَم (تسري فوراً)</h3>
      <form method="post" action="/admin/points/rules">
        ${Object.entries(labels).map(([k, l]) => `<label>${l}</label><input type="number" name="${k}" value="${rules[k]}">`).join('')}
        <button class="btn block" style="margin-top:10px">حفظ القواعد</button></form></div>
    <div class="card"><h3>منح نقاط يدوياً</h3>
      <form method="post" action="/admin/points/grant">
        <label>الشخص</label><select name="person_id">${people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <div class="grid2"><div><label>القيمة (±)</label><input type="number" name="value" required></div>
        <div><label>السبب</label><input name="note" required></div></div>
        <button class="btn block sec" style="margin-top:10px">منح</button></form></div>
  `, { user: u, active: '/admin' }));
});
admin.post('/points/rules', async (c) => {
  const b = await c.req.parseBody();
  const rules = {};
  for (const k of ['attendance_present', 'attendance_late', 'cleanliness_star', 'behavior_max', 'behavior_person_cap']) rules[k] = Number(b[k]) || 0;
  setSetting('points_rules', JSON.stringify(rules));
  audit(c.get('user').id, 'points_rules', JSON.stringify(rules));
  return back(c, '/admin/points');
});
admin.post('/points/grant', async (c) => {
  const b = await c.req.parseBody();
  db.prepare(`INSERT INTO points (person_id, source, value, note, date, added_by, ts) VALUES (?, 'other', ?, ?, ?, ?, ?)`)
    .run(Number(b.person_id), Number(b.value), String(b.note), today(), c.get('user').id, now());
  audit(c.get('user').id, 'points_grant', `#${b.person_id}: ${b.value} (${b.note})`);
  return back(c, '/admin/points');
});

// ===== تصدير Excel =====
admin.get('/export', (c) => {
  const u = c.get('user');
  const items = [
    ['people', '👥 كشف المشاركين الكامل'], ['attendance', '✅ سجل الحضور'], ['boardings', '🚌 سجلات الباصات'],
    ['points', '🎯 النقاط التفصيلية'], ['boards', '🏆 لوحات الشرف'], ['requests', '📥 الطلبات'], ['links', '🔗 روابط الدخول (سرّي)'],
  ];
  return c.html(layout('تصدير Excel', `
    <div class="card">${items.map(([k, l]) => `<a class="btn block ghost" style="margin:6px 0" href="/admin/export/${k}.xlsx">${l}</a>`).join('')}
    <div style="font-size:11.5px;color:var(--muted)">التصدير الكامل (روابط/أرقام مدنية) محصور بالإدارة — كل تصدير يُسجَّل في التدقيق.</div></div>
  `, { user: u, active: '/admin' }));
});
admin.get('/export/:what{.+\\.xlsx}', (c) => {
  const u = c.get('user');
  const what = c.req.param('what').replace('.xlsx', ''); // كل التصديرات متاحة للإدارة (إشراف عام + إداريين)
  const wb = XLSX.utils.book_new();
  const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31));
  if (what === 'people') {
    add('المشاركون', db.prepare(`SELECT p.name, p.category, p.role, p.civil_id, p.phone, p.notes, p.user_no, p.track, r.name AS room, r.room_no
      FROM people p LEFT JOIN rooms r ON r.id=p.room_id WHERE p.active=1 ORDER BY p.name`).all()
      .map(p => ({
        الاسم: p.name, الفئة: p.category, الدور: ROLE_NAMES[p.role] || p.role, السكن: p.room, رقم_الغرفة: p.room_no,
        الرقم_المدني: decrypt(p.civil_id), رقم_المستخدم: p.user_no, المنهج: p.track || 'حفظ', الجوال: p.phone, ملاحظات: p.notes,
      })));
  } else if (what === 'attendance') {
    add('الحضور', db.prepare(`SELECT a.date, a.slot, p.name AS person,
      CASE a.status WHEN 'present' THEN 'حاضر' WHEN 'late' THEN 'متأخر' WHEN 'excused' THEN 'مستأذن' ELSE 'غائب' END AS status,
      m.name AS marker FROM attendance a JOIN people p ON p.id=a.person_id LEFT JOIN people m ON m.id=a.marked_by ORDER BY a.date, a.slot, p.name`).all()
      .map(r => ({ التاريخ: r.date, الموعد: slotLabel(r.slot), الاسم: r.person, الحالة: r.status, حضّره: r.marker })));
  } else if (what === 'boardings') {
    for (const s of db.prepare('SELECT * FROM bus_stages ORDER BY ord').all()) {
      add(s.name.slice(0, 28), db.prepare(`SELECT p.name AS الاسم, CASE b.status WHEN 'boarded' THEN 'ركب' WHEN 'exempt' THEN 'مستأذن (بعذر)' ELSE 'لم يركب' END AS الحالة,
        b.bus_no AS الباص, b.note AS ملاحظة, b.ts AS الوقت FROM people p
        LEFT JOIN boardings b ON b.person_id=p.id AND b.stage_id=${s.id} WHERE p.active=1 ORDER BY p.name`).all());
    }
  } else if (what === 'points') {
    add('النقاط', db.prepare(`SELECT pt.date, p.name AS person, r.name AS room, pt.source, pt.value, pt.note
      FROM points pt LEFT JOIN people p ON p.id=pt.person_id LEFT JOIN rooms r ON r.id=pt.room_id ORDER BY pt.id DESC`).all()
      .map(x => {
        let note = x.note;
        if (note && note.startsWith('رصد:')) note = 'رصد: ' + slotLabel(note.slice(4));
        
        return { التاريخ: x.date, الاسم: x.person, الغرفة: x.room, المصدر: x.source, القيمة: x.value, السبب: note };
      }));
  } else if (what === 'boards') {
    const { roomsBoard, individualBoard } = require('./boards');
    add('الغرف', roomsBoard().map((r, i) => ({ الترتيب: i + 1, السكن: r.name, نجوم_الجاهزية: r.avg_stars ? Number(r.avg_stars).toFixed(1) : '', نقاط_للفرد: r.per_capita, الدرجة: r.score })));
    add('الأفراد', individualBoard(200).map((r, i) => ({ الترتيب: i + 1, الاسم: r.name, الفئة: r.category, النقاط: r.total })));
  } else if (what === 'requests') {
    add('الطلبات', db.prepare(`SELECT r.ts AS الوقت, p.name AS مقدمه, r.category AS النوع, cm.name AS اللجنة, r.text AS النص, r.status AS الحالة
      FROM requests r LEFT JOIN people p ON p.id=r.person_id LEFT JOIN committees cm ON cm.id=r.committee_id ORDER BY r.id DESC`).all());
  } else if (what === 'links') {
    const base = baseUrl(c);
    add('روابط الدخول', db.prepare(`SELECT name, category, phone, token FROM people WHERE active=1 ORDER BY name`).all()
      .map(r => ({ الاسم: r.name, الفئة: r.category, الجوال: r.phone, الرابط: `${base}/d/${r.token}` })));
  } else return c.text('غير معروف', 404);
  audit(u.id, 'export', what);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  c.header('Content-Disposition', `attachment; filename="rihla-${what}-${today()}.xlsx"`);
  return c.body(buf);
});

// ===== اعتماد الصور الشخصية =====
admin.get('/photos', (c) => {
  const u = c.get('user');
  const pending = db.prepare("SELECT id, name, category FROM people WHERE active=1 AND photo_status='pending' ORDER BY name").all();
  const approved = db.prepare("SELECT COUNT(*) c FROM people WHERE active=1 AND photo_status='approved'").get().c;
  return c.html(layout('اعتماد الصور', `
    <div class="card" style="font-size:13px;color:var(--muted)">📷 الصور المرفوعة تظهر بجانب الأسماء بعد اعتمادك — المعتمدة حتى الآن: <b>${approved}</b></div>
    ${pending.map(p => `<div class="card row">
      <img class="avat lg" src="/photo/${p.id}.jpg" alt="">
      <div class="grow"><b>${esc(p.name)}</b><br>${catPill(p.category)}</div>
      <form method="post" action="/admin/photos/${p.id}/approve"><button class="btn sm">✅ اعتماد</button></form>
      <form method="post" action="/admin/photos/${p.id}/reject" onsubmit="return confirm('رفض الصورة وحذفها؟')"><button class="btn sm" style="background:#b22">رفض</button></form>
    </div>`).join('') || '<div class="card">لا صور بانتظار الاعتماد 🎉</div>'}
  `, { user: u, active: '/admin' }));
});
admin.post('/photos/:id/approve', (c) => {
  const id = Number(c.req.param('id'));
  db.prepare("UPDATE people SET photo_status='approved' WHERE id=? AND photo_status='pending'").run(id);
  audit(c.get('user').id, 'photo_approve', `#${id}`);
  return back(c, '/admin/photos');
});
admin.post('/photos/:id/reject', (c) => {
  const id = Number(c.req.param('id'));
  const fs3 = require('fs'); const path3 = require('path');
  const f = path3.join(__dirname, '..', 'data', 'photos', `${id}.jpg`);
  try { fs3.unlinkSync(f); } catch {}
  db.prepare("UPDATE people SET photo_status='none' WHERE id=?").run(id);
  audit(c.get('user').id, 'photo_reject', `#${id}`);
  return back(c, '/admin/photos');
});

// ===== بنود «رفيقي اليومي» العامة (تصل كل المشاركين) =====
admin.get('/checklist', (c) => {
  const u = c.get('user');
  const items = db.prepare('SELECT * FROM checklist_items WHERE person_id IS NULL ORDER BY ord, id').all();
  const d = today();
  const stats = items.map(i => ({
    ...i, n: db.prepare('SELECT COUNT(*) c FROM checklist_done WHERE item_id=? AND date=?').get(i.id, d).c,
  }));
  const total = db.prepare("SELECT COUNT(*) c FROM people WHERE active=1").get().c;
  const ownCount = db.prepare('SELECT COUNT(*) c FROM checklist_items WHERE person_id IS NOT NULL').get().c;
  return c.html(layout('رفيقي اليومي — البنود العامة', `
    <div class="card" style="font-size:12.5px;color:var(--muted)">
      البنود التي تضيفها هنا تصل <b style="color:var(--ink)">كل المشاركين</b> في صفحاتهم، ولكل شخص أن يضيف بنوده الخاصة فوقها.
      <div style="margin-top:6px">🔒 <b style="color:var(--ink)">بلا نقاط ولا ترتيب ولا مقارنة</b> — عمل بين العبد وربه، ولا يرى أحدٌ إنجاز غيره.</div>
    </div>
    <div class="card"><h3>➕ بند عام جديد</h3>
      <form method="post" action="/admin/checklist/add">
        <input name="title" placeholder="مثال: أذكار الصباح والمساء" required>
        <div class="row" style="margin-top:6px;align-items:flex-end">
          <div><label>التكرار</label>
            ${RP_SCRIPT}<select name="repeat_kind" onchange="rpSync(this)">
              ${Object.entries(REPEATS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></div>
          <div class="rp1" style="display:none"><label>اليوم</label>
            <select name="weekday">${WEEK.map((w, i) => `<option value="${i}" ${i === 5 ? 'selected' : ''}>${w}</option>`).join('')}</select></div>
          <div class="rp2" style="display:none"><label>اليوم الثاني</label>
            <select name="weekday2">${WEEK.map((w, i) => `<option value="${i}" ${i === 3 ? 'selected' : ''}>${w}</option>`).join('')}</select></div>
          <button class="btn sm">إضافة للجميع</button>
        </div></form></div>
    <div class="card"><h3>البنود العامة (${items.length})</h3>
      ${stats.map(i => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)">
        <div class="grow" style="${i.active ? '' : 'opacity:.45;text-decoration:line-through'}">${esc(i.title)}
          ${repeatBadge(i.repeat_kind, i.weekday, i.weekday2)}</div>
        <span class="pill ${i.n ? 'g' : 'r'} num" title="من أتمّه اليوم">${i.n}/${total}</span>
        <form method="post" action="/admin/checklist/${i.id}/toggle"><button class="btn sm ghost">${i.active ? 'تعطيل' : 'تفعيل'}</button></form>
        <form method="post" action="/admin/checklist/${i.id}/delete" onsubmit="return confirm('حذف البند من الجميع؟')"><button class="btn sm ghost">🗑</button></form>
      </div>`).join('') || '<div style="color:var(--muted)">لا بنود عامة — كل شخص يضيف بنوده وحده</div>'}
      <div style="font-size:12px;color:var(--muted);margin-top:8px">أضاف المشاركون <b>${ownCount}</b> بنداً خاصاً بهم</div>
    </div>
  `, { user: u, active: '/admin' }));
});
admin.post('/checklist/add', async (c) => {
  const b = await c.req.parseBody();
  const mx = db.prepare('SELECT COALESCE(MAX(ord),0) m FROM checklist_items WHERE person_id IS NULL').get().m;
  const rk = REPEATS[String(b.repeat_kind)] ? String(b.repeat_kind) : 'daily';
  const wd = (rk === 'weekly' || rk === 'twice') ? wdOf(b.weekday, 5) : null;
  const wd2 = rk === 'twice' ? wdOf(b.weekday2, 3) : null;
  db.prepare('INSERT INTO checklist_items (person_id, title, ord, created_by, ts, repeat_kind, weekday, weekday2) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)')
    .run(String(b.title).trim().slice(0, 120), mx + 1, c.get('user').id, now(), rk, wd, wd2);
  audit(c.get('user').id, 'checklist_add', String(b.title));
  return back(c, '/admin/checklist');
});
admin.post('/checklist/:id/toggle', (c) => {
  db.prepare('UPDATE checklist_items SET active = 1 - active WHERE id = ? AND person_id IS NULL').run(Number(c.req.param('id')));
  return back(c, '/admin/checklist');
});
admin.post('/checklist/:id/delete', (c) => {
  db.prepare('DELETE FROM checklist_items WHERE id = ? AND person_id IS NULL').run(Number(c.req.param('id')));
  audit(c.get('user').id, 'checklist_delete', `#${c.req.param('id')}`);
  return back(c, '/admin/checklist');
});

// ===== لوحات الشرف اليدوية =====
admin.route('/honor', require('./honor').honor);
admin.route('/perms', require('./perms').perms);

// ===== التحليلات (للمؤسس وحده) =====
admin.route('/analytics', require('./analytics'));

// ===== لوحة التحكم الشاملة =====
admin.get('/dashboard', (c) => require('./dashboard').render(c, c.get('user')));

// ===== بنود جاهزية الغرفة =====
admin.get('/checkitems', (c) => {
  const u = c.get('user');
  const items = db.prepare('SELECT * FROM room_check_items ORDER BY ord, id').all();
  const rules = getRules();
  return c.html(layout('بنود جاهزية الغرفة', `
    <div class="card" style="font-size:12.5px;color:var(--muted)">
      يمرّ المقيّم على هذه البنود في جولته ويعلّم المتحقق منها. <b style="color:var(--ink)">الدرجة = عدد البنود المتحققة</b>،
      وكل بند = <b style="color:var(--ink)">${rules.cleanliness_star}</b> نقطة (تُعدَّل من «قواعد النقاط»).
      فيصير التقييم على معايير محسوسة يراها الجميع، لا على تقدير شخصي.</div>
    <div class="card"><h3>➕ بند جديد</h3>
      <form method="post" action="/admin/checkitems/add" class="row">
        <input name="title" placeholder="مثال: النوافذ مغلقة والمكيّف مضبوط" required class="grow">
        <button class="btn sm">إضافة</button></form></div>
    <div class="card">${items.map(it => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)">
      <div class="grow" style="font-size:13.5px;${it.active ? '' : 'opacity:.45;text-decoration:line-through'}">${esc(it.title)}</div>
      <form method="post" action="/admin/checkitems/${it.id}/toggle"><button class="btn sm ghost">${it.active ? 'تعطيل' : 'تفعيل'}</button></form>
      <form method="post" action="/admin/checkitems/${it.id}/delete" onsubmit="return confirm('حذف البند نهائياً؟')"><button class="btn sm ghost">🗑</button></form>
    </div>`).join('')}
    <div style="font-size:12px;color:var(--muted);margin-top:8px">البنود المفعّلة: <b>${items.filter(i => i.active).length}</b> — وهي الدرجة الكاملة للغرفة</div></div>
  `, { user: u, active: '/admin' }));
});
admin.post('/checkitems/add', async (c) => {
  const b = await c.req.parseBody();
  const mx = db.prepare('SELECT COALESCE(MAX(ord),0) m FROM room_check_items').get().m;
  db.prepare('INSERT INTO room_check_items (title, ord) VALUES (?, ?)').run(String(b.title).trim(), mx + 1);
  audit(c.get('user').id, 'checkitem_add', String(b.title));
  return back(c, '/admin/checkitems');
});
admin.post('/checkitems/:id/toggle', (c) => {
  db.prepare('UPDATE room_check_items SET active = 1 - active WHERE id = ?').run(Number(c.req.param('id')));
  return back(c, '/admin/checkitems');
});
admin.post('/checkitems/:id/delete', (c) => {
  db.prepare('DELETE FROM room_check_items WHERE id = ?').run(Number(c.req.param('id')));
  audit(c.get('user').id, 'checkitem_delete', `#${c.req.param('id')}`);
  return back(c, '/admin/checkitems');
});

// ===== المصروفات والتقرير المالي =====
admin.route('/money', require('./money'));
admin.route('/media', require('./media').adminMedia);

// ===== الأمان والنسخ الاحتياطي (لرئيس الوفد فقط) =====
admin.get('/security', (c) => {
  const u = c.get('user');
  if (!isAdmin(u)) return deny(c);
  const pin = getSetting('admin_pin') || '';
  const baseUrlV = getSetting('base_url') || '';
  const m = c.req.query('m');
  const logins = db.prepare(`SELECT a.ts, a.action, a.detail FROM audit a
    WHERE a.action IN ('login_new_device','login_fail','admin_pin_ok','admin_pin_fail') ORDER BY a.id DESC LIMIT 20`).all();
  const path2 = require('path');
  const fs2 = require('fs');
  const bdir = path2.join(__dirname, '..', 'data', 'backups');
  const backups = fs2.existsSync(bdir) ? fs2.readdirSync(bdir).filter(x => x.endsWith('.db')).sort().reverse() : [];
  return c.html(layout('الأمان والنسخ', `
    ${m ? `<div class="flash">${esc(m)}</div>` : ''}
    <div class="card"><h3>🔑 رمز الإدارة (PIN)</h3>
      <p style="font-size:13px;color:var(--muted)">يُطلب مرة واحدة من كل جهاز جديد يدخل لوحة الإدارة. تغييره يُخرج كل الأجهزة المعتمدة.</p>
      <form method="post" action="/admin/security/pin" class="row">
        <input name="pin" value="${esc(pin)}" inputmode="numeric" maxlength="6" required style="text-align:center;font-size:20px;letter-spacing:6px;width:140px">
        <button class="btn sm">تغيير</button></form></div>
    <div class="card"><h3>🎨 شعار الرحلة</h3>
      <div style="text-align:center;padding:10px">
        <img src="/logo.png" alt="" style="max-width:220px;max-height:110px;border-radius:10px;border:1px solid var(--line);background:#fff;padding:8px"
          onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
        <div style="display:none;color:var(--muted);font-size:13px;padding:20px">لم يُرفع الشعار بعد</div>
      </div>
      <input type="file" id="logoIn" accept="image/png,image/jpeg" style="display:none">
      <button class="btn block ghost" onclick="logoIn.click()">📤 رفع/تغيير الشعار</button>
      <div style="font-size:11.5px;color:var(--muted);text-align:center;margin-top:4px">يظهر في الترويسة والقائمة الجانبية وصفحة الباركودات</div>
      <script>
      logoIn.onchange=async()=>{const f=logoIn.files[0];if(!f)return;
        try{
          const img=await createImageBitmap(f);
          const s=Math.min(1,400/Math.max(img.width,img.height));
          const cv=document.createElement('canvas');cv.width=Math.round(img.width*s);cv.height=Math.round(img.height*s);
          cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
          cv.toBlob(async b=>{
            const r=await fetch('/api/logo',{method:'POST',headers:{'Content-Type':'image/png'},body:b});
            if(r.ok)location.reload();else alert('تعذّر الرفع');
          },'image/png');
        }catch(e){alert('تعذّرت معالجة الصورة');}};
      </script>
    </div>
    <div class="card"><h3>🌐 رابط التطبيق الأساسي</h3>
      <p style="font-size:13px;color:var(--muted)">يُستخدم عند تصدير روابط الدخول — عبّئه بعد الاستضافة (مثال: https://rihla.example.com)</p>
      <form method="post" action="/admin/security/baseurl" class="row">
        <input name="base_url" value="${esc(baseUrlV)}" placeholder="https://..." style="direction:ltr" class="grow">
        <button class="btn sm">حفظ</button></form></div>
    <div class="card"><h3>💾 النسخ الاحتياطي</h3>
      <p style="font-size:13px;color:var(--muted)">تلقائي يومياً (يحتفظ بآخر ١٤ نسخة) في data/backups — آخر النسخ:</p>
      ${backups.slice(0, 5).map(b => `<span class="pill g num">${esc(b)}</span> `).join('') || 'لا نسخ بعد'}
      <form method="post" action="/admin/security/backup" style="margin-top:8px"><button class="btn block gold">أخذ نسخة الآن</button></form></div>
    <div class="card"><h3>🕵️ آخر أحداث الدخول المهمة</h3><table>
      ${logins.map(l => `<tr><td class="num" style="font-size:11px">${esc(l.ts.slice(0, 16).replace('T', ' '))}</td>
        <td><span class="pill ${l.action.includes('fail') ? 'r' : 'o'}">${esc(l.action)}</span></td>
        <td style="font-size:11.5px">${esc((l.detail || '').slice(0, 60))}</td></tr>`).join('') || '<tr><td>لا أحداث</td></tr>'}
    </table></div>
  `, { user: u, active: '/admin', wide: true }));
});
admin.post('/security/pin', async (c) => {
  if (!isAdmin(c.get('user'))) return deny(c);
  const b = await c.req.parseBody();
  const pin = String(b.pin).replace(/\D/g, '').slice(0, 6);
  if (pin.length < 4) return back(c, '/admin/security', 'الرمز لازم ٤-٦ أرقام');
  setSetting('admin_pin', pin);
  setCookie(c, 'apin', pinHash(pin), { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60 * 60 * 24 * 60 });
  audit(c.get('user').id, 'pin_change', 'تغيير رمز الإدارة');
  return back(c, '/admin/security', 'تغيّر الرمز — بقية الأجهزة تحتاج إعادة اعتماد');
});
admin.post('/security/baseurl', async (c) => {
  if (!isAdmin(c.get('user'))) return deny(c);
  const b = await c.req.parseBody();
  setSetting('base_url', String(b.base_url || '').trim());
  audit(c.get('user').id, 'baseurl_change', String(b.base_url || ''));
  return back(c, '/admin/security', 'حُفظ الرابط الأساسي');
});
admin.post('/security/backup', (c) => {
  if (!isAdmin(c.get('user'))) return deny(c);
  const f = backupNow(true);   // force — بلا هذا يتخطّى النسخ إن كان ملف النصف الحالي موجوداً
  const nm = f && typeof f === 'string' ? f.split(/[\\/]/).pop() : '';
  const tm = (() => { const k = new Date(Date.now() + 3 * 3600 * 1000); const p = x => String(x).padStart(2, '0'); return `${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`; })();
  return back(c, '/admin/security', f ? `أُخذت النسخة الآن (${tm})${nm ? ' — ' + nm : ''}` : 'فشل النسخ — راجع السجلات');
});

// ===== سجل التدقيق =====
admin.get('/audit', (c) => {
  const u = c.get('user');
  const rows = db.prepare(`SELECT a.*, p.name FROM audit a LEFT JOIN people p ON p.id = a.who ORDER BY a.id DESC LIMIT 200`).all();
  return c.html(layout('سجل التدقيق', `
    <div class="card"><table><tr><th>الوقت</th><th>من</th><th>العملية</th><th>التفاصيل</th></tr>
      ${rows.map(r => `<tr><td class="num" style="font-size:11px">${esc(r.ts.slice(0, 16).replace('T', ' '))}</td>
        <td style="font-size:12px">${esc(r.name || 'النظام')}</td><td><span class="pill m">${esc(r.action)}</span></td>
        <td style="font-size:12px">${esc(r.detail || '')}</td></tr>`).join('')}
    </table></div>
  `, { user: u, active: '/admin', wide: true }));
});

module.exports = admin;
