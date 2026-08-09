// خادم تطبيق رحلة المدينة النبوية ١١ — ١٤٤٨هـ/٢٠٢٦م
const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { db, now, today, getSetting, audit, getRules, getSlots, slotLabel, QURAN_KINDS } = require('./db');
const { loadUser, login, requireLevel, deny, isAdmin, isManager, isSupervisor, committeesOf, circlesSupervisedBy, roomsSupervisedBy, canRateRooms } = require('./auth');
const { setCookie, deleteCookie } = require('hono/cookie');
const { layout, esc, shortName, buildShortNames, rolePill, catPill, supBadge } = require('./views');
const { ensureToday } = require('./prayers');
const { individualBoard, rankOf, roomsBoard } = require('./boards');
const adminRoutes = require('./admin');

const app = new Hono();
app.use('*', loadUser);

// قراءة JSON بأمان — الطلب الفاسد يُرفض بلطف بدل خطأ خادم
async function safeJson(c) {
  try { return await c.req.json(); } catch { return null; }
}

// شبكة أمان: أي خطأ غير متوقع لا يُسقط الطلب ولا يكشف تفاصيل داخلية
app.onError((err, c) => {
  console.error('[error]', c.req.method, c.req.path, '-', err.message);
  if (c.req.path.startsWith('/api/')) return c.json({ ok: false, error: 'تعذّر تنفيذ الطلب' }, 500);
  return c.html(layout('حدث خطأ', `<div class="card" style="text-align:center;padding:34px">
    <div style="font-size:42px">⚠️</div><h3>تعذّر تحميل هذه الصفحة</h3>
    <p style="color:var(--muted);font-size:13px">حاول مرة أخرى، وإن تكرّر فأبلغ الإدارة.</p>
    <a class="btn" href="/">الرجوع للرئيسية</a></div>`, { user: c.get('user') }), 500);
});

// ================= PWA =================
app.get('/manifest.json', (c) => c.json({
  name: getSetting('trip_name', 'رحلة المدينة'), short_name: 'رحلة المدينة', dir: 'rtl', lang: 'ar',
  start_url: '/', display: 'standalone', background_color: '#f6f4ee', theme_color: '#3F7E44',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
}));
// مكتبة قراءة QR بالجافاسكربت — بديل يعمل على Safari/iPad (لا يدعم BarcodeDetector)
app.get('/jsQR.js', (c) => {
  c.header('Content-Type', 'application/javascript');
  c.header('Cache-Control', 'public, max-age=604800');
  return c.body(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'jsqr', 'dist', 'jsQR.js')));
});
app.get('/icon.svg', (c) => {
  c.header('Content-Type', 'image/svg+xml');
  return c.body(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#3F7E44"/><text x="50" y="66" text-anchor="middle" font-size="46" fill="#fff" font-family="sans-serif">🕌</text></svg>`);
});
app.get('/sw.js', (c) => {
  c.header('Content-Type', 'application/javascript');
  return c.body(`
const CACHE='rihla-v1';
self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>self.clients.claim());
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.pathname.startsWith('/api/'))return;
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));return r})
    .catch(()=>caches.match(e.request)));
});`);
});

// ================= الدخول =================
// حد لمحاولات التخمين: يُحتسب على المحاولات **الفاشلة** فقط.
// (الدخول الناجح لا يُحتسب — فالوفد كله على شبكة الفندق نفسها بعنوان واحد،
//  ولو حسبنا الناجح لانحظر بقية المشاركين بعد أول ٣٠ شخصاً.)
const loginFails = new Map();
const FAIL_LIMIT = 20, FAIL_WINDOW = 10 * 60 * 1000;
app.get('/d/:token', (c) => {
  const ip = (c.req.header('x-forwarded-for') || '').split(',')[0].trim()
    || c.req.header('x-real-ip') || c.req.header('cf-connecting-ip') || 'local';
  const rec = loginFails.get(ip);
  if (rec && Date.now() - rec.t < FAIL_WINDOW && rec.n >= FAIL_LIMIT) {
    return c.html(layout('محاولات كثيرة', `<div class="card" style="text-align:center;padding:34px">
      <div style="font-size:42px">⏳</div><h3>محاولات كثيرة</h3>
      <p style="color:var(--muted);font-size:13.5px">انتظر عشر دقائق ثم أعد فتح رابطك، أو تواصل مع الإدارة.</p></div>`), 429);
  }
  const p = login(c, c.req.param('token'));
  if (!p) {
    const cur = (rec && Date.now() - rec.t < FAIL_WINDOW) ? rec : { n: 0, t: Date.now() };
    cur.n++; loginFails.set(ip, cur);
    audit(null, 'login_fail', `رمز خاطئ من ${ip} (${cur.n})`);
    return c.html(layout('رابط غير صالح', `<div class="card" style="text-align:center;padding:34px">
      <div style="font-size:42px">🔗</div><h3>هذا الرابط غير صالح</h3>
      <p style="color:var(--muted);font-size:13.5px">تأكد من نسخ الرابط كاملاً، أو اطلب رابطاً جديداً من الإدارة.</p></div>`), 404);
  }
  loginFails.delete(ip);   // دخول ناجح يمسح سجل الإخفاقات
  return c.redirect('/');
});

// ================= الخروج والمعاينة =================
app.get('/logout', (c) => {
  const u = c.get('user');
  if (u) audit(u.id, 'logout', u.name);
  deleteCookie(c, 'rihla', { path: '/' });
  deleteCookie(c, 'rihla_real', { path: '/' });
  deleteCookie(c, 'apin', { path: '/' });
  return c.html(layout('خرجت من التطبيق', `
    <div class="card" style="text-align:center;padding:40px 20px">
      <div style="font-size:48px">👋</div>
      <h3>تم تسجيل الخروج</h3>
      <p style="color:var(--muted);font-size:13.5px">للدخول مرة أخرى افتح <b>رابطك الشخصي</b> الذي وصلك من الإدارة.</p>
    </div>`));
});

// معاينة حساب شخص آخر (للمؤسس فقط) — تفيد في العرض والدعم، ومسجّلة بالتدقيق
app.get('/viewas/:id', (c) => {
  const u = c.get('user');
  const real = c.get('realUser') || u;
  if (!isAdmin(real)) return deny(c);
  const t = db.prepare('SELECT id, name, token FROM people WHERE id = ? AND active = 1').get(Number(c.req.param('id')));
  if (!t) return c.text('غير موجود', 404);
  const opts = { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60 * 60 * 4 };
  setCookie(c, 'rihla_real', real.token, opts);
  setCookie(c, 'rihla', t.token, opts);
  audit(real.id, 'view_as', `${real.name} يعاين حساب ${t.name}`);
  return c.redirect('/');
});
app.get('/viewas-exit', (c) => {
  const real = c.get('realUser');
  if (real) {
    setCookie(c, 'rihla', real.token, { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60 * 60 * 24 * 45 });
    deleteCookie(c, 'rihla_real', { path: '/' });
  }
  return c.redirect('/');
});

app.get('/', async (c) => {
  const u = c.get('user');
  if (!u) return c.html(layout('رحلة المدينة النبوية ١١', `
    <div class="card" style="text-align:center;padding:40px 20px">
      <div style="font-size:52px">🕌</div>
      <h2 style="color:var(--maroon)">${esc(getSetting('trip_name', ''))}</h2>
      <p style="color:var(--muted)">الدخول عبر رابطك الشخصي الذي وصلك من الإدارة.<br>ما عندك رابط؟ تواصل مع مشرفك.</p>
    </div>`));
  // من عليه مهام يهبط على «مهامي الآن» مباشرة؛ الطالب على صفحته
  const hasDuties = isManager(u) || u.role === 'attendance_supervisor' ||
    circlesSupervisedBy(u.id).length || roomsSupervisedBy(u).length || committeesOf(u.id).length;
  return c.redirect(hasDuties ? '/today' : '/me');
});

// ================= QR الشخصي =================
app.get('/qr/:file', async (c) => {
  const t = c.req.param('file').replace(/\.png$/, '');
  const p = db.prepare('SELECT id FROM people WHERE token = ?').get(t);
  if (!p) return c.text('not found', 404);
  const buf = await QRCode.toBuffer(`R:${t}`, { width: 400, margin: 1, color: { dark: '#1a3a1e' } });
  c.header('Content-Type', 'image/png');
  c.header('Cache-Control', 'private, max-age=86400');
  return c.body(buf);
});

// ================= الصور الشخصية =================
const PHOTOS_DIR = path.join(__dirname, '..', 'data', 'photos');
fs.mkdirSync(PHOTOS_DIR, { recursive: true });
const photoPath = (id) => path.join(PHOTOS_DIR, `${id}.jpg`);

// رفع صورة (المستخدم لنفسه) — مضغوطة من المتصفح، تنتظر اعتماد الإدارة
app.post('/api/photo', async (c) => {
  const u = c.get('user');
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (!buf.length || buf.length > 1024 * 1024) return c.json({ error: 'الصورة كبيرة — حاول مرة أخرى' }, 413);
  if (!(buf[0] === 0xFF && buf[1] === 0xD8)) return c.json({ error: 'صيغة غير صالحة' }, 415); // JPEG فقط
  fs.writeFileSync(photoPath(u.id), buf);
  db.prepare("UPDATE people SET photo_status = 'pending' WHERE id = ?").run(u.id);
  audit(u.id, 'photo_upload', `${u.name} رفع صورته (${Math.round(buf.length / 1024)}KB) — بانتظار الاعتماد`);
  return c.json({ ok: true });
});

// ================= شعار الرحلة =================
const LOGO_PATH = path.join(__dirname, '..', 'data', 'logo.png');
app.get('/logo.png', (c) => {
  if (!fs.existsSync(LOGO_PATH)) return c.text('no logo', 404);
  c.header('Content-Type', 'image/png');
  c.header('Cache-Control', 'public, max-age=3600');
  return c.body(fs.readFileSync(LOGO_PATH));
});
app.post('/api/logo', async (c) => {
  const u = c.get('user');
  if (!isManager(u)) return c.json({ error: 'forbidden' }, 403);
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (!buf.length || buf.length > 3 * 1024 * 1024) return c.json({ error: 'حجم غير مناسب' }, 413);
  fs.writeFileSync(LOGO_PATH, buf);
  audit(u.id, 'logo_upload', `${Math.round(buf.length / 1024)}KB`);
  return c.json({ ok: true });
});

// حذف الصورة الشخصية (لصاحبها)
app.post('/photo/delete', (c) => {
  const u = c.get('user');
  if (!u) return deny(c);
  try { fs.unlinkSync(photoPath(u.id)); } catch { }
  db.prepare("UPDATE people SET photo_status = 'none' WHERE id = ?").run(u.id);
  audit(u.id, 'photo_delete', u.name);
  return c.redirect('/me');
});

// عرض الصورة: المعتمدة للجميع المسجلين؛ المعلّقة لصاحبها وللإدارة فقط
app.get('/photo/:file', (c) => {
  const u = c.get('user');
  if (!u) return c.text('unauthorized', 401);
  const id = Number(c.req.param('file').replace(/\.jpg$/, ''));
  const p = db.prepare('SELECT photo_status FROM people WHERE id = ?').get(id);
  if (!p || p.photo_status === 'none' || !fs.existsSync(photoPath(id))) return c.text('no photo', 404);
  if (p.photo_status === 'pending' && !(u.id === id || isManager(u))) return c.text('pending', 403);
  c.header('Content-Type', 'image/jpeg');
  c.header('Cache-Control', 'private, max-age=300');
  return c.body(fs.readFileSync(photoPath(id)));
});

// ================= صفحة الشخص =================
app.get('/me', async (c) => {
  const u = c.get('user');
  if (!u) return c.redirect('/');
  const d = today();
  const msg = db.prepare('SELECT * FROM daily_messages WHERE date = ?').get(d);
  const room = u.room_id ? db.prepare('SELECT * FROM rooms WHERE id = ?').get(u.room_id) : null;
  const rk = rankOf(u);
  const { city, times } = await ensureToday();
  // جدول اليوم مفلتر بفئة الشخص
  const sched = db.prepare('SELECT * FROM schedule WHERE date = ? ORDER BY time').all(d)
    .filter(s => s.scope === 'الجميع' || s.scope === u.category || (s.scope === 'المشرفون' && isSupervisor(u)));
  const quiz = db.prepare('SELECT * FROM daily_quiz WHERE date = ?').get(d);
  const myAnswer = quiz ? db.prepare('SELECT * FROM quiz_answers WHERE date = ? AND person_id = ?').get(d, u.id) : null;
  const myReqs = db.prepare('SELECT * FROM requests WHERE person_id = ? ORDER BY id DESC LIMIT 5').all(u.id);
  const coms = committeesOf(u.id);
  const myAtt = db.prepare(`SELECT date, slot, status FROM attendance WHERE person_id = ? ORDER BY date DESC, slot DESC LIMIT 6`).all(u.id);
  const stName = { new: 'جديد', processing: 'قيد المعالجة', done: 'تم ✓' };
  // فائدة اليوم: المنشور للجميع + حالة فائدتي أنا
  const feed = db.prepare(`SELECT b.text, b.date, p.id AS pid, p.name, p.photo_status FROM benefits b
    JOIN people p ON p.id = b.person_id WHERE b.status = 'approved' ORDER BY b.id DESC LIMIT 4`).all();
  const mine = db.prepare('SELECT * FROM benefits WHERE person_id = ? AND date = ?').get(u.id, d);
  // الزيارات: غرف غير غرفتي + زياراتي اليوم
  const otherRooms = db.prepare('SELECT id, name FROM rooms WHERE id IS NOT ? ORDER BY CAST(room_no AS INTEGER), name').all(u.room_id || 0);
  const myVisits = db.prepare(`SELECT v.*, r.name AS rname FROM visits v JOIN rooms r ON r.id = v.room_id
    WHERE v.visitor_id = ? ORDER BY v.id DESC LIMIT 6`).all(u.id);
  const slotName = (k) => slotLabel(k);

  return c.html(layout('صفحتي', `
    ${tripCard()}
    ${msg ? `<div class="msgbar"><div class="d">رسالة اليوم — ${esc(msg.date)}</div><div style="font-size:15px;font-weight:600;margin-top:4px">${esc(msg.text)}</div></div>` : ''}
    <div class="card"><div class="row">
      ${u.photo_status !== 'none' ? `<img class="avat lg" src="/photo/${u.id}.jpg?t=${Date.now()}" alt="">` : `<div class="avat lg" style="display:flex;align-items:center;justify-content:center;font-size:36px">👤</div>`}
      <div class="grow"><b style="font-size:16px">${esc(u.name)}</b><br>
        ${rolePill(u.role)}
        ${u.track ? `<span class="pill b">📖 ${esc(u.track)}</span>` : ''}
        ${u.photo_status === 'pending' ? '<span class="pill o">📷 الصورة بانتظار الاعتماد</span>' : ''}
        ${coms.map(cm => `<span class="pill o">${esc(cm.name)}${cm.is_head ? ' — رئيس' : ''}</span>`).join(' ')}
        ${room ? `<div style="margin-top:6px;font-size:13px;color:var(--muted)">🛏️ ${esc(room.name)}${room.room_no && !room.name.includes(room.room_no) ? ` — غرفة ${esc(room.room_no)}` : ''}${room.label ? ` (${esc(room.label)})` : ''}</div>` : ''}
      </div>
    </div>
    <input type="file" id="phin" accept="image/*" style="display:none">
    <div class="row" style="margin-top:8px">
      <button class="btn sm ghost grow" onclick="phin.click()">📷 ${u.photo_status === 'none' ? 'رفع صورتي' : 'تغيير صورتي'}</button>
      ${u.photo_status !== 'none' ? `<form method="post" action="/photo/delete" onsubmit="return confirm('حذف صورتك؟')"><button class="btn sm ghost" style="color:#b22">🗑 حذف الصورة</button></form>` : ''}
    </div>
    <script>
    phin.onchange=async()=>{const f=phin.files[0];if(!f)return;
      try{
        const img=await createImageBitmap(f);
        const s=Math.min(1,512/Math.max(img.width,img.height));
        const cv=document.createElement('canvas');cv.width=Math.round(img.width*s);cv.height=Math.round(img.height*s);
        cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
        cv.toBlob(async b=>{
          const r=await fetch('/api/photo',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:b});
          if(r.ok)location.reload();else alert('تعذّر الرفع — حاول مرة أخرى');
        },'image/jpeg',0.82);
      }catch(e){alert('تعذّرت معالجة الصورة');}};
    </script></div>
    <div class="grid2">
      <div class="stat"><div class="v num">${rk.total}</div><div class="l">نقاطي</div></div>
      <div class="stat"><div class="v num">${rk.rank ?? '—'}<span style="font-size:13px;color:var(--muted)"> / ${rk.of}</span></div><div class="l">ترتيبي في لوحة الشرف</div></div>
    </div>
    <div class="card" style="padding:10px 14px;font-size:12.5px;color:var(--muted)">
      🎯 <b>كيف تجني نقاطك؟</b> أولاً وأهمّها: <b>حضورك حلقة الفجر والعصر مبكراً</b> — المبكّر ينال النقاط كاملة، والمتأخّر نصفها.
      ثم ترتيب مكانك في الغرفة، وإجابة سؤال اليوم، وزيارة إخوانك، وفائدتك المنشورة، وحسن سلوكك.</div>
    ${(() => {
      const stage = db.prepare('SELECT name FROM bus_stages WHERE active = 1').get();
      return `<div class="card qrbox" ${stage ? 'style="border:2px solid var(--gold)"' : ''}>
        <h3 style="font-size:15px">${stage ? '🚌 اعرض هذا للمشرف عند باب الباص' : '🎫 رمزك عند صعود الباص'}</h3>
        ${stage ? `<div class="pill o" style="margin-bottom:6px">جارٍ الآن: ${esc(stage.name)}</div>` : ''}
        <img src="/qr/${u.token}.png" alt="QR">
        <div style="font-size:11.5px;color:var(--muted)">${stage ? 'المشرف يمسحه بكاميرته فتُسجَّل بياناتك تلقائياً' : 'يظهر تنبيه هنا وقت التحرك'}</div></div>`;
    })()}
    ${times ? `<div class="card"><h3>🕌 أوقات الصلاة — ${esc(city)}</h3><table><tr><th>الفجر</th><th>الظهر</th><th>العصر</th><th>المغرب</th><th>العشاء</th></tr>
      <tr class="num"><td>${esc(times.fajr)}</td><td>${esc(times.dhuhr)}</td><td>${esc(times.asr)}</td><td>${esc(times.maghrib)}</td><td>${esc(times.isha)}</td></tr></table>
      ${times.date !== d ? `<div style="font-size:11px;color:#b22;margin-top:4px">⚠️ أوقات يوم ${esc(times.date)} — تعذّر تحديث اليوم (بدون إنترنت)</div>` : ''}</div>` : ''}
    ${quiz ? (() => {
      const opts = JSON.parse(quiz.options);
      if (myAnswer) {
        return `<div class="card"><h3>❓ سؤال اليوم</h3><div style="margin-bottom:8px">${esc(quiz.question)}</div>
          ${opts.map((o, i) => `<div class="row" style="padding:7px 12px;margin:4px 0;border-radius:10px;border:1px solid var(--line);${i === quiz.correct ? 'background:rgba(63,126,68,.12);border-color:var(--green)' : i === myAnswer.choice ? 'background:rgba(200,40,40,.08);border-color:#c33' : ''}">
            <div class="grow">${esc(o)}</div>${i === quiz.correct ? '<span class="pill g">✓ الصحيح</span>' : i === myAnswer.choice ? '<span class="pill r">اخترته</span>' : ''}</div>`).join('')}
          <div class="flash" style="margin-top:8px">${myAnswer.correct ? `🎉 إجابة صحيحة — حصلت على ${quiz.points} نقاط` : 'إجابة غير صحيحة — جرب حظك غداً'}</div></div>`;
      }
      return `<div class="card" style="border:2px solid var(--gold)"><h3>❓ سؤال اليوم — ${quiz.points} نقاط</h3>
        <div style="margin-bottom:10px">${esc(quiz.question)}</div>
        ${opts.map((o, i) => `<form method="post" action="/quiz/answer"><input type="hidden" name="choice" value="${i}">
          <button class="btn ghost block" style="margin:5px 0;text-align:right">${esc(o)}</button></form>`).join('')}
        <div style="font-size:11px;color:var(--muted)">لك محاولة واحدة فقط — اختر بتركيز</div></div>`;
    })() : ''}
    <div class="card"><h3>✍️ فائدة اليوم</h3>
      ${mine ? `<div class="row" style="padding:8px;background:rgba(63,126,68,.06);border-radius:10px">
          <span style="font-size:20px">${mine.status === 'approved' ? '🌟' : '⏳'}</span>
          <div class="grow"><div style="font-size:13.5px">${esc(mine.text)}</div>
            <div style="font-size:11.5px;color:var(--muted);margin-top:2px">${mine.status === 'approved' ? 'نُشرت للجميع — بارك الله فيك' : 'وصلت الإدارة — تُنشر بعد الاعتماد'}</div></div></div>`
        : `<form method="post" action="/benefit">
          <div style="font-size:12.5px;color:var(--muted);margin-bottom:6px">اكتب فائدة أو خاطرة قصيرة — إن اعتُمدت نُشرت باسمك للجميع</div>
          <textarea name="text" rows="2" maxlength="220" required placeholder="مثال: تذكّرتُ اليوم أن الصلاة في المسجد النبوي بألف صلاة..."></textarea>
          <button class="btn block" style="margin-top:8px">أرسل فائدتي</button></form>`}
      ${feed.length ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line)">
        <div class="row" style="margin-bottom:6px"><div class="grow" style="font-size:12px;color:var(--muted)">📖 فوائد إخوانك</div>
          <a href="/benefits" style="font-size:12px">الكل ›</a></div>
        ${feed.map(f => `<a href="/p/${f.pid}" style="display:flex;gap:8px;padding:7px 0;border-bottom:1px solid var(--line);text-decoration:none;color:inherit">
          ${f.photo_status === 'approved' ? `<img class="avat" loading="lazy" src="/photo/${f.pid}.jpg" alt="">` : '<span style="font-size:19px">👤</span>'}
          <div class="grow"><div style="font-size:13.5px">${esc(f.text)}</div>
            <div style="font-size:11px;color:var(--muted)">${esc(shortName(f))}</div></div></a>`).join('')}</div>` : ''}
    </div>

    ${otherRooms.length ? `<div class="card"><h3>🚪 زيارة غرفة</h3>
      <div style="font-size:12.5px;color:var(--muted);margin-bottom:6px">زر إخوانك في غرفة أخرى — يعتمدها مشرفها فتُحسب لك نقاط</div>
      <form method="post" action="/visit" class="row">
        <select name="room_id" class="grow">${otherRooms.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>
        <button class="btn sm">سجّل زيارتي</button></form>
      ${myVisits.map(v => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line);font-size:13px">
        <div class="grow">${esc(v.rname)}
          <span class="num" style="color:var(--muted);font-size:11px">${esc(v.date)} — ${esc(clock(v.ts))}</span></div>
        <span class="pill ${v.status === 'approved' ? 'g' : 'o'}">${v.status === 'approved' ? 'معتمدة ✓' : 'بانتظار المشرف'}</span></div>`).join('')}
    </div>` : ''}

    ${sched.length ? `<div class="card"><h3>📅 جدول اليوم</h3>${sched.map((s, i) => {
      const nx = sched[i + 1];
      return `<div class="schrow" data-from="${esc(s.time)}" data-to="${esc(nx ? nx.time : '23:59')}"
        style="padding:7px 9px;margin:3px -9px;border-radius:10px;display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--line)">
        <b class="num" style="width:52px">${esc(s.time)}</b><div class="grow">${esc(s.title)}</div>
        <span class="nowpill" style="display:none"></span><span class="pill g">${esc(s.scope)}</span></div>`;
    }).join('')}</div>
    <script>
    // إبراز الفقرة الجارية — بلا ضغطة: تُميَّز وتُمرَّر الصفحة إليها
    (function(){
      const rows=[...document.querySelectorAll('.schrow')]; if(!rows.length) return;
      let scrolled=false;
      function mark(){
        const d=new Date(Date.now()+3*3600*1000);
        const mins=d.getUTCHours()*60+d.getUTCMinutes();
        const toM=t=>{const[h,m]=t.split(':').map(Number);return h*60+(m||0);};
        let cur=null;
        rows.forEach(r=>{
          const on = mins>=toM(r.dataset.from) && mins<toM(r.dataset.to);
          r.style.background = on?'rgba(122,59,93,.09)':'';
          r.style.boxShadow  = on?'inset 3px 0 0 var(--maroon)':'';
          const p=r.querySelector('.nowpill');
          p.style.display = on?'':'none';
          if(on){p.className='nowpill pill m';p.textContent='الآن';cur=r;}
        });
        if(cur&&!scrolled){scrolled=true;cur.scrollIntoView({block:'center',behavior:'smooth'});}
      }
      mark(); setInterval(mark,60000);
    })();
    <\/script>` : ''}
    ${myAtt.length ? `<div class="card"><h3>✅ حضوري الأخير</h3>${myAtt.map(a => {
      const map = { present: ['g', 'حاضر'], late: ['o', 'متأخر ⏱'], excused: ['o', 'مستأذن'], absent: ['r', 'غائب'] };
      const [cls, lbl] = map[a.status] || ['r', 'غائب'];
      return `<span class="pill ${cls}">${esc(a.date)} ${esc(slotName(a.slot))}: ${lbl}</span> `;
    }).join('')}</div>` : ''}
    ${(() => {
      const items = myChecklist(u.id, d);
      const doneN = items.filter(i => i.done).length;
      const streak = streakOf(u.id);
      return `<div class="card" id="checklist">
        <div class="row" style="margin-bottom:6px">
          <h3 class="grow" style="margin:0">✅ رفيقي اليومي</h3>
          ${items.length ? `<span class="pill ${doneN >= items.length ? 'g' : 'o'} num">${doneN}/${items.length}</span>` : ''}
          ${streak > 1 ? `<span class="pill m">🔥 ${streak} يوم متتالٍ</span>` : ''}
        </div>
        <div style="font-size:11.5px;color:var(--muted);margin-bottom:8px">بينك وبين ربّك — لا نقاط ولا ترتيب ولا يراه أحد غيرك</div>
        ${items.map(i => `<form method="post" action="/checklist/toggle" class="row" style="padding:8px 10px;margin:5px 0;border-radius:11px;border:2px solid ${i.done ? 'var(--green)' : 'var(--line)'};background:${i.done ? 'rgba(63,126,68,.06)' : '#fff'}">
          <input type="hidden" name="item_id" value="${i.id}">
          <button style="background:none;border:none;font-size:20px;cursor:pointer;padding:0;flex:none">${i.done ? '✅' : '⬜'}</button>
          <div class="grow" style="font-size:13.5px;font-weight:600;${i.done ? 'color:var(--muted)' : ''}">${esc(i.title)}
            ${!i.mine ? '<span class="pill g" style="font-weight:400">من الإدارة</span>' : ''}</div>
        </form>${i.mine ? `<form method="post" action="/checklist/${i.id}/delete" style="margin-top:-32px;text-align:left;position:relative;z-index:2" onsubmit="return confirm('حذف هذا البند؟')">
          <button class="btn sm ghost" style="padding:3px 8px">🗑</button></form>` : ''}`).join('')
        || '<div style="color:var(--muted);font-size:13px;padding:8px 0">لا بنود بعد — أضف ما تحبّ الالتزام به</div>'}
        <details style="margin-top:8px"><summary style="cursor:pointer;color:var(--green);font-weight:600;font-size:13px;padding:6px 0">➕ أضف بنداً لنفسك</summary>
          <form method="post" action="/checklist/add" style="margin-top:6px">
            <input name="title" placeholder="مثال: أذكار النوم" required>
            ${repeatPicker()}
            <button class="btn sm" style="margin-top:8px">إضافة</button></form>${RP_SCRIPT}
        </details>
      </div>`;
    })()}
    <div class="card"><h3>📨 طلب / اقتراح / بلاغ</h3>
      <form method="post" action="/requests">
        <select name="category"><option>طلب</option><option>اقتراح</option><option>نقص</option><option>بلاغ طبي</option></select>
        <label>التفاصيل</label><textarea name="text" rows="2" required></textarea>
        <button class="btn block" style="margin-top:10px">إرسال</button>
      </form>
      ${myReqs.map(r => `<div style="font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--line)">${esc(r.text.slice(0, 60))} <span class="pill ${r.status === 'done' ? 'g' : r.status === 'processing' ? 'o' : 'm'}">${stName[r.status]}</span></div>`).join('')}
    </div>
    <a class="btn block ghost" href="/logout" style="margin:14px 0" onclick="return confirm('تسجيل الخروج؟ ستحتاج رابطك الشخصي للدخول مرة أخرى.')">🚪 تسجيل الخروج</a>
  `, { user: u, active: '/me', viewingAs: c.get('realUser') }));
});

// إرسال طلب — يُوجَّه تلقائياً للجنة المناسبة
app.post('/requests', async (c) => {
  const u = c.get('user');
  if (!u) return deny(c);
  const b = await c.req.parseBody();
  // التوجيه حسب اللجان الرسمية في الدليل الإرشادي
  const map = { 'بلاغ طبي': 'اللجنة الطبية', 'نقص': 'اللجنة التنسيقية', 'طلب': 'لجنة الخدمات المساندة', 'اقتراح': 'لجنة متابعة الجودة' };
  const com = db.prepare('SELECT id FROM committees WHERE name = ?').get(map[b.category] || 'لجنة الجودة');
  db.prepare('INSERT INTO requests (person_id, committee_id, category, text, status, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(u.id, com ? com.id : null, String(b.category), String(b.text).slice(0, 2000), 'new', now());
  audit(u.id, 'request', `${b.category}: ${String(b.text).slice(0, 80)}`);
  return c.redirect('/me');
});

// إجابة السؤال اليومي — محاولة واحدة، نقاط لأول إجابة صحيحة فقط
app.post('/quiz/answer', async (c) => {
  const u = c.get('user');
  if (!u) return deny(c);
  const d = today();
  const quiz = db.prepare('SELECT * FROM daily_quiz WHERE date = ?').get(d);
  if (!quiz) return c.redirect('/me');
  // محاولة واحدة: من أجاب سابقاً لا يُعاد
  if (db.prepare('SELECT 1 FROM quiz_answers WHERE date = ? AND person_id = ?').get(d, u.id)) return c.redirect('/me');
  const b = await c.req.parseBody();
  const choice = Number(b.choice);
  const opts = JSON.parse(quiz.options);
  if (!(choice >= 0 && choice < opts.length)) return c.redirect('/me');
  const correct = choice === quiz.correct ? 1 : 0;
  db.prepare('INSERT INTO quiz_answers (date, person_id, choice, correct, ts) VALUES (?, ?, ?, ?, ?)').run(d, u.id, choice, correct, now());
  if (correct && quiz.points) {
    db.prepare(`INSERT INTO points (person_id, source, value, note, date, added_by, ts) VALUES (?, 'quiz', ?, 'السؤال اليومي', ?, NULL, ?)`).run(u.id, quiz.points, d, now());
  }
  audit(u.id, 'quiz_answer', `${correct ? 'صحيح' : 'خطأ'} — ${d}`);
  return c.redirect('/me');
});

// ================= لوحات الشرف =================
app.get('/boards', (c) => {
  const u = c.get('user');
  if (!u) return c.redirect('/');
  const rooms = roomsBoard();
  const medal = (i) => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
  // اللوحتان اليدويتان: القرآن (اللجنة العلمية) والمتميزون (ترشيح) — أحدث يوم فيه أسماء
  const boardOf = (kind) => {
    const last = db.prepare('SELECT MAX(date) d FROM honor_boards WHERE kind=?').get(kind)?.d;
    if (!last) return { date: null, rows: [] };
    return {
      date: last,
      rows: db.prepare(`SELECT h.*, p.name AS pname, p.category FROM honor_boards h
        LEFT JOIN people p ON p.id=h.person_id WHERE h.kind=? AND h.date=? ORDER BY h.id`).all(kind, last),
    };
  };
  const quranB = boardOf('quran'), distB = boardOf('distinguished');
  const manualBoard = (b, title, icon, color) => !b.rows.length ? '' : `
    <div class="card" style="border:2px solid ${color}">
      <div class="row" style="margin-bottom:6px"><h3 class="grow" style="margin:0">${icon} ${title}</h3>
        <span class="pill m num">${esc(b.date)}</span></div>
      ${b.rows.map((h, i) => `<div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)">
        <span style="width:28px;font-size:16px">${medal(i)}</span>
        <div class="grow"><b>${esc(h.pname || h.name || '')}</b>
          ${h.note ? `<div style="font-size:11.5px;color:var(--muted)">${esc(h.note)}</div>` : ''}</div>
        ${h.category ? catPill(h.category) : ''}</div>`).join('')}
    </div>`;
  // لوحة واحدة موحّدة للجميع — الأكثر حضوراً والتزاماً يتصدر (بلا فئات)
  // مفتوحة للجميع بقرار الإدارة — يمكن قصرها على العشرة الأوائل من الإعدادات بلا مبرمج
  const full = getSetting('board_full', '1') === '1';
  const indivRows = individualBoard(full ? 999 : 10);
  const indivHtml = `<div class="card"><h3>🏆 الأكثر حضوراً والتزاماً ${full ? `<span class="pill m">${indivRows.length} مشاركاً</span>` : ''}</h3><table>
      ${indivRows.map((r, i) => `<tr><td style="width:34px;text-align:center">${medal(i)}</td><td><a href="/p/${r.id}" style="color:inherit">${esc(shortName(r))}</a> ${catPill(r.category)}</td><td class="num" style="width:60px;text-align:left"><b>${r.total}</b></td></tr>`).join('')}
    </table></div>`;
  // ⭐ نجوم اليوم: أفضل ١٠ في نقاط اليوم (قرآن + حضور + سلوك) — تتولد تلقائياً بلا تدخل
  const d = today();
  const stars = db.prepare(`SELECT p.name, p.category, COALESCE(SUM(pt.value),0) t
    FROM people p JOIN points pt ON pt.person_id = p.id AND pt.date = ?
    WHERE p.active = 1 GROUP BY p.id HAVING t > 0 ORDER BY t DESC, p.name LIMIT 10`).all(d);
  return c.html(layout('لوحة الشرف', `
    ${stars.length ? `<div class="msgbar"><div class="d">⭐ نجوم اليوم — ${esc(d)}</div>
      <div style="margin-top:6px">${stars.map((s, i) => `<div class="row" style="padding:3px 0"><span style="width:24px">${i < 3 ? ['🥇', '🥈', '🥉'][i] : '⭐'}</span><div class="grow" style="font-size:14px">${esc(shortName(s))}</div><b class="num">${s.t}</b></div>`).join('')}</div></div>` : ''}
    ${quranB.rows.length || distB.rows.length ? '<h2 class="sec">🏅 لوحات الشرف</h2>' : ''}
    ${manualBoard(quranB, 'شرف القرآن', '📖', 'var(--green)')}
    ${manualBoard(distB, 'المتميزون', '🏅', 'var(--maroon)')}
    <h2 class="sec">🏠 لوحة الغرف والأجنحة</h2>
    <div class="card"><table>
      <tr><th></th><th>السكن</th><th>⭐ الجاهزية</th><th>نقاط/فرد</th><th>الدرجة</th></tr>
      ${rooms.map((r, i) => `<tr><td style="text-align:center">${medal(i)}</td><td>${esc(r.name)}</td>
        <td class="num">${r.avg_stars ? Number(r.avg_stars).toFixed(1) : '—'}</td>
        <td class="num">${r.per_capita}</td><td class="num"><b>${r.score}</b></td></tr>`).join('')}
    </table>
    <div style="font-size:11px;color:var(--muted);margin-top:6px">الدرجة = جاهزية الغرفة (٦٠٪) + متوسط نقاط الفرد (٤٠٪) — عادلة مهما كان حجم السكن</div></div>
    <h2 class="sec">🎖️ لوحة الشرف الفردية</h2>
    <div class="searchbox"><input data-filter="#indivBoards" placeholder="🔍 ابحث عن اسمك أو أي اسم..." autocomplete="off"></div>
    <div id="indivBoards" data-rows>
    ${indivHtml}
    </div>
  `, { user: u, active: '/boards' }));
});

// ================= تحضير الحلقات (offline-first) =================
// تحضير الحلقات: الفجر والعصر يُرصدان حلقةً حلقة (حلقة الشيخ لا علاقة لها بالغرف)
function circleMembers(gid) {
  return db.prepare(`SELECT p.id, p.name, p.category, p.role, p.photo_status FROM att_group_members m JOIN people p ON p.id = m.person_id
                     WHERE m.group_id = ? AND p.active = 1 ORDER BY p.name`).all(gid);
}
function allPeople() {
  return db.prepare('SELECT id, name, category, role, photo_status FROM people WHERE active = 1 ORDER BY name').all();
}
// صورة مصغّرة معتمدة بجانب الاسم — تساعد المشرف يتعرف على الوجوه بسرعة
const avat = (p) => p.photo_status === 'approved' ? `<img class="avat" loading="lazy" src="/photo/${p.id}.jpg" alt="">` : '';

// اختيار الموعد الأقرب للساعة الحالية تلقائياً (توقيت السعودية) — يوفّر خطوة على المشرف
function nearestSlot(slots) {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  const nowMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  let best = slots[0], bd = Infinity;
  for (const s of slots) {
    const [h, m] = (s.time || '0:0').split(':').map(Number);
    let diff = Math.abs(h * 60 + m - nowMin);
    diff = Math.min(diff, 1440 - diff);
    if (diff < bd) { bd = diff; best = s; }
  }
  return best ? best.key : null;
}

// سكربت التحضير المشترك (شاشة الحلقات وشاشة الغرف): نقر فوري + طابور offline بدون فقدان + «الكل حاضر»
function markingScript(date, slot, storageKey, allLabel) {
  return `<script>
    const DATE=${JSON.stringify(date)}, SLOT=${JSON.stringify(slot)}, KEY=${JSON.stringify(storageKey)};
    const items=[...document.querySelectorAll('.prow')];
    const hist=[]; // مكدس تراجع: كل عملية (نقرة أو جماعية) تُسجَّل خطوة واحدة
    function paint(el){const s=el.dataset.st;
      el.classList.toggle('present',s==='present');el.classList.toggle('absent',s==='absent');el.classList.toggle('late',s==='late');
      el.querySelector('.mk.yes').classList.toggle('on',s==='present');
      el.querySelector('.mk.no').classList.toggle('on',s==='absent');
      const lt=el.querySelector('.mk.late');if(lt)lt.classList.toggle('on',s==='late');}
    function counts(){const n=(st)=>items.filter(i=>i.dataset.st===st).length;
      const p=n('present'),a=n('absent'),l=n('late');
      cPresent.textContent=p;cAbsent.textContent=a;cLeft.textContent=items.length-p-a-l;
      const c2=document.getElementById('cLeft2');if(c2)c2.textContent=items.length-p-a-l;
      const ub=document.getElementById('undoBtn');if(ub)ub.disabled=!hist.length;}
    function record(step){hist.push(step);if(hist.length>30)hist.shift();}
    // ضغطة واحدة = الحالة مباشرة (لا دورات ولا ضغطتين)
    function setSt(el,st){record([{el,prev:el.dataset.st}]);
      el.dataset.st=st;paint(el);counts();push(el.dataset.id,st);sync();}
    items.forEach(el=>{paint(el);
      el.querySelector('.mk.yes').onclick=()=>setSt(el,'present');
      el.querySelector('.mk.no').onclick=()=>setSt(el,'absent');
      const lt=el.querySelector('.mk.late');if(lt)lt.onclick=()=>setSt(el,'late');});
    counts();
    const qEl=document.getElementById('q');
    if(qEl)qEl.oninput=()=>{const v=qEl.value.trim();items.forEach(i=>i.style.display=arMatch(i.dataset.name,v)?'':'none');};
    // بعد إنهاء التحضير: رجوع تلقائي لشاشة «مهامي» — لا يفكّر وين يروح
    window.finishTo=(url)=>{setTimeout(()=>{location.href=url||'/today';},400);};
    // «الكل حاضر»: يعلّم غير المحضَّرين فقط — الغائبون المعلَّمون لا يتغيرون
    window.markAll=()=>{const left=items.filter(i=>!i.dataset.st);if(!left.length)return;
      if(!confirm('سيُسجَّل '+left.length+' حاضرين. تمام؟'))return;
      record(left.map(el=>({el,prev:''})));
      left.forEach(el=>{el.dataset.st='present';paint(el);push(el.dataset.id,'present');});counts();sync();};
    // «البقية غائبون»: بعد تعليم الحاضرين اللي قدامك — الباقي يُسجَّل غائباً
    window.markRest=()=>{const left=items.filter(i=>!i.dataset.st);if(!left.length)return;
      if(!confirm('سيُسجَّل '+left.length+' غائبين. تمام؟'))return;
      record(left.map(el=>({el,prev:''})));
      left.forEach(el=>{el.dataset.st='absent';paint(el);push(el.dataset.id,'absent');});counts();sync();};
    // «تراجع»: يلغي آخر عملية (الجماعية تنلغى كلها بضغطة) — يمسح التحضير من الخادم أيضاً
    window.undoLast=()=>{const last=hist.pop();if(!last)return;
      last.forEach(({el,prev})=>{el.dataset.st=prev;paint(el);push(el.dataset.id,prev||'clear');});counts();sync();};
    // ==== طابور offline — يُحذف المُرسَل فقط، فلا يضيع تحضير أثناء الإرسال ====
    function load(){try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch{return[]}}
    function save(x){localStorage.setItem(KEY,JSON.stringify(x))}
    function push(id,st){save(load().filter(e=>!(e.id==id&&e.date===DATE&&e.slot===SLOT)).concat([{id:+id,st,date:DATE,slot:SLOT,ts:Date.now()}]));}
    let syncing=false;
    async function sync(){if(syncing)return;const qq=load();if(!qq.length)return;syncing=true;
      try{const r=await fetch('/api/attendance/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({marks:qq})});
        if(!r.ok)throw 0;
        const sent=new Set(qq.map(e=>e.id+'|'+e.slot+'|'+e.date+'|'+e.ts));
        save(load().filter(e=>!sent.has(e.id+'|'+e.slot+'|'+e.date+'|'+e.ts)));
        syncbar.style.display='none';
      }catch{syncbar.style.display='block';}finally{syncing=false;if(load().length)setTimeout(sync,300);}}
    addEventListener('online',sync);setInterval(sync,15000);sync();
    // ==== المزامنة الحيّة: يظهر ما حضّره المشرفون الآخرون فوراً (تحضير متزامن من عدة أجهزة) ====
    const byId={};items.forEach(el=>byId[el.dataset.id]=el);
    async function pull(){
      if(load().length)return;                       // لا نسحب ولدينا نقرات لم تُرسل بعد
      try{
        const r=await fetch('/api/attendance/state?slot='+encodeURIComponent(SLOT)+'&date='+DATE);
        if(!r.ok)return;
        const j=await r.json();
        const srv={};j.marks.forEach(m=>srv[m.person_id]=m.status);
        let changed=false;
        items.forEach(el=>{const s=srv[el.dataset.id]||'';
          if(s!==el.dataset.st){el.dataset.st=s;paint(el);changed=true;}});
        if(changed)counts();
        const box=document.getElementById('circleProgress');
        if(box&&j.circles&&j.circles.length){
          box.innerHTML=j.circles.map(g=>{const full=g.total>0&&g.done>=g.total;
            return '<div class="row" style="padding:4px 0"><div class="grow" style="font-size:13px">📿 '+g.name+
              (g.sup?' <span style="color:var(--muted);font-size:11px">— '+g.sup+'</span>':'')+'</div>'+
              '<span class="pill '+(full?'g':g.done?'o':'r')+' num">'+g.done+'/'+g.total+'</span></div>';}).join('');
        }
      }catch{}
    }
    setInterval(pull,8000);setTimeout(pull,1500);
    addEventListener('focus',pull);
  </script>`;
}

app.get('/attendance', (c) => {
  const u = c.get('user');
  // الدخول لمن يشرف على حلقة فعلياً (أياً كان دوره) أو مشرف حضور أو إداري فأعلى
  if (!u || !(u.role === 'attendance_supervisor' || isManager(u) || circlesSupervisedBy(u.id).length)) return deny(c);
  const d = today();
  const slots = getSlots().filter(s => s.who === 'attendance' && s.enabled);
  const slot = c.req.query('slot') || nearestSlot(slots) || 'fajr';
  // الحلقات: الإداري فأعلى يشوف كلها + «الجميع»؛ مشرف التحضير يشوف حلقاته فقط
  const allGroups = db.prepare('SELECT g.*, s.name AS sup FROM att_groups g LEFT JOIN people s ON s.id = g.supervisor_id ORDER BY g.name').all();
  const myGroups = isManager(u) ? allGroups : allGroups.filter(g => g.supervisor_id === u.id);
  let gid = c.req.query('g') || (myGroups.length ? String(myGroups[0].id) : 'all');
  if (!isManager(u) && myGroups.length && !myGroups.some(g => String(g.id) === gid)) gid = String(myGroups[0].id);
  const list = gid === 'all' ? allPeople() : circleMembers(Number(gid));
  const cur = allGroups.find(g => String(g.id) === gid);
  const existing = db.prepare('SELECT person_id, status FROM attendance WHERE date = ? AND slot = ?').all(d, slot);
  const st = Object.fromEntries(existing.map(r => [r.person_id, r.status]));
  const gLink = (g) => `/attendance?slot=${slot}&g=${g}`;
  return c.html(layout('تحضير الحلقات', `
    ${myGroups.length ? `<select onchange="location='/attendance?slot=${esc(slot)}&g='+this.value" style="margin-bottom:6px">
      ${isManager(u) ? `<option value="all" ${gid === 'all' ? 'selected' : ''}>👥 الجميع (بدون حلقات)</option>` : ''}
      ${myGroups.map(g => `<option value="${g.id}" ${String(g.id) === gid ? 'selected' : ''}>📿 ${esc(g.name)}${g.sup ? ' — ' + esc(g.sup) : ''}</option>`).join('')}
    </select>` : ''}
    <div class="row" style="margin:6px 0">
      ${slots.map(s => `<a class="btn ${slot === s.key ? '' : 'ghost'} grow" href="/attendance?slot=${s.key}&g=${esc(gid)}">${esc(s.label)}<br><span style="font-size:11px;opacity:.8" class="num">${esc(s.time)}</span></a>`).join('')}
    </div>
    <div class="row"><div class="stat grow"><div class="v num" id="cPresent">0</div><div class="l">حاضر</div></div>
    <div class="stat grow"><div class="v num" id="cLate" style="color:var(--gold)">0</div><div class="l">متأخر</div></div>
    <div class="stat warn grow"><div class="v num" id="cAbsent">0</div><div class="l">غائب</div></div>
    <div class="stat grow"><div class="v num" id="cLeft">0</div><div class="l">لم يُحضَّر</div></div></div>
    ${isManager(u) ? `<div class="card"><h3>📡 تقدّم التحضير — مباشر</h3>
      <div id="circleProgress" style="font-size:13px;color:var(--muted)">جارٍ التحديث...</div>
      <div style="font-size:11px;color:var(--muted);margin-top:6px">يتحدّث تلقائياً كل ٨ ثوانٍ — كل مشرف يحضّر حلقته من جهازه وأنت ترى الصورة كاملة</div></div>` : ''}
    <div style="font-size:12.5px;color:var(--muted);margin:4px 2px">اضغط «الكل حاضر» ثم علّم الغائبين بـ ✗ فقط</div>
    <div class="row" style="margin:4px 0">
      <button class="btn gold grow" onclick="markAll()">✓ الكل حاضر (<span id="cLeft2">0</span>)</button>
      <button class="btn ghost" id="undoBtn" onclick="undoLast()" disabled>↩️ تراجع</button>
    </div>
    <button class="btn block sec" onclick="finishTo('/today')" style="margin:4px 0">🏁 انتهيت — رجوع لمهامي</button>
    ${list.length > 20 ? `<div class="searchbox"><input id="q" placeholder="🔍 بحث بالاسم..." autocomplete="off"></div>` : ''}
    <div id="syncbar" style="display:none" class="flash">📴 بدون إنترنت — التحضير محفوظ بالجهاز وسيُرسَل تلقائياً</div>
    <div id="list" data-alpha>
      ${list.map(p => `<div class="prow" data-id="${p.id}" data-name="${esc(p.name)}" data-st="${st[p.id] || ''}">
        ${avat(p)}<div class="nm">${esc(shortName(p))}${supBadge(p.role)}</div>
        <button class="mk no" title="غائب">✗</button><button class="mk late" title="متأخر">⏱</button><button class="mk yes" title="حاضر">✓</button>
      </div>`).join('')}
      ${!list.length ? `<div class="card">الحلقة فارغة — ${cur ? 'أضف أعضاءها من لوحة الإدارة' : 'لا حلقات بعد'}</div>` : ''}
    </div>
    ${markingScript(d, slot, 'attq')}
  `, { user: u, active: '/attendance' }));
});

app.post('/api/attendance/sync', async (c) => {
  const u = c.get('user');
  // الصلاحية بالإسناد الفعلي: رئيس حلقة أو مشرف غرفة (أياً كان دوره) أو إشراف عام
  if (!anySupervisory(u)) return c.json({ ok: false }, 403);
  const body = await safeJson(c); if (!body) return c.json({ ok: false, error: "طلب غير صالح" }, 400);
  const { marks } = body;
  const slots = getSlots();
  const mgr = isManager(u);
  // تحضير الغرف: بالإسناد الفعلي (أياً كان الدور) — سكان الغرف المسندة له فقط
  let roomMemberIds = null;
  if (!mgr) {
    const rids = roomsSupervisedBy(u).map(r => r.id);
    roomMemberIds = rids.length
      ? new Set(db.prepare(`SELECT id FROM people WHERE active = 1 AND room_id IN (${rids.join(',')})`).all().map(r => r.id))
      : new Set();
  }
  // تحضير الفجر/العصر: من يشرف على حلقات يحضّر أعضاءها فقط (أياً كان دوره)؛
  // مشرف حضور بلا حلقات يرصد الجميع؛ من عداهم لا يرصد شيئاً
  let circleIds = null;
  if (!mgr) {
    const gs = db.prepare('SELECT id FROM att_groups WHERE supervisor_id = ?').all(u.id);
    if (gs.length) circleIds = new Set(db.prepare(`SELECT person_id FROM att_group_members WHERE group_id IN (${gs.map(g => g.id).join(',')})`).all().map(r => r.person_id));
    else if (u.role !== 'attendance_supervisor') circleIds = new Set(); // لا حلقات ولا دور رصد → مرفوض
  }
  const up = db.prepare(`INSERT INTO attendance (date, slot, person_id, status, marked_by, ts) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, slot, person_id) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by, ts = excluded.ts`);
  const rules = getRules();
  // الحذف بالبادئة: يشمل «رصد:fajr» و«رصد:fajr (متأخر)» فلا تتراكم نقاط عند تغيير الحالة
  const delPts = db.prepare(`DELETE FROM points WHERE person_id = ? AND source = 'attendance' AND date = ? AND note LIKE ? || '%'`);
  const insPts = db.prepare(`INSERT INTO points (person_id, source, value, note, date, added_by, ts) VALUES (?, 'attendance', ?, ?, ?, ?, ?)`);
  let applied = 0;
  // نافذة التواريخ المقبولة: اليوم وأمس فقط (أمس تغطي المزامنة بعد انقطاع الشبكة)
  const dToday = today();
  const dYest = new Date(new Date(dToday + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  let rejectedDates = 0;
  for (const m of (marks || [])) {
    if (!['present', 'late', 'absent', 'excused', 'clear'].includes(m.st)) continue;
    // بلا هذا الفحص يستطيع أي مشرف منح نقاطاً بلا حدّ بإرسال تواريخ مستقبلية
    if (m.date !== dToday && m.date !== dYest) { rejectedDates++; continue; }
    const slotDef = slots.find(s => s.key === m.slot);
    if (!slotDef) continue;
    if (!mgr) {
      if (slotDef.who === 'room' && roomMemberIds && !roomMemberIds.has(Number(m.id))) continue;
      if (slotDef.who === 'attendance' && circleIds && !circleIds.has(Number(m.id))) continue;
    }
    // نقاط الحضور تتحدث تلقائياً — المفتاح برمز الموعد الثابت حتى لو أعيدت تسميته
    const noteKey = `رصد:${slotDef.key}`;
    delPts.run(m.id, m.date, noteKey);
    if (m.st === 'clear') { // تراجع: إزالة الرصد نهائياً
      db.prepare('DELETE FROM attendance WHERE date = ? AND slot = ? AND person_id = ?').run(m.date, m.slot, m.id);
      applied++;
      continue;
    }
    up.run(m.date, m.slot, m.id, m.st, u.id, now());
    // نقاط: الحاضر كاملة، المتأخر جزئية، الغائب صفر
    const val = m.st === 'present' ? rules.attendance_present : m.st === 'late' ? rules.attendance_late : 0;
    if (val) insPts.run(m.id, val, noteKey + (m.st === 'late' ? ' (متأخر)' : ''), m.date, u.id, now());
    applied++;
  }
  audit(u.id, 'attendance_sync', `${applied} رصد (${dToday})` + (rejectedDates ? ` — رُفض ${rejectedDates} بتاريخ خارج النافذة` : ''));
  return c.json({ ok: true, applied, rejectedDates });
});

// ================= تحضير الغرف (مشرف الغرفة — مرتين يومياً) =================
app.get('/roomcheck', (c) => {
  const u = c.get('user');
  if (!u || !(isManager(u) || roomsSupervisedBy(u).length)) return deny(c);
  const myRooms = isManager(u)
    ? db.prepare('SELECT * FROM rooms ORDER BY name').all()
    : roomsSupervisedBy(u).map(r => db.prepare('SELECT * FROM rooms WHERE id = ?').get(r.id));
  if (!myRooms.length) return c.html(layout('التحضير', `<div class="card">ما في غرفة مرتبطة فيك — كلّم الإدارة.</div>`, { user: u }));
  const rid = Number(c.req.query('r') || myRooms[0].id);
  const room = myRooms.find(r => r.id === rid) || myRooms[0];
  const slots = getSlots().filter(s => s.who === 'room' && s.enabled);
  const slot = c.req.query('slot') || nearestSlot(slots) || 'room_night';
  const d = today();
  const members = db.prepare("SELECT id, name, category, role, photo_status FROM people WHERE room_id = ? AND active = 1 ORDER BY name").all(room.id);
  const st = Object.fromEntries(db.prepare('SELECT person_id, status FROM attendance WHERE date = ? AND slot = ?').all(d, slot).map(r => [r.person_id, r.status]));
  return c.html(layout('تحضير الغرفة', `
    ${myRooms.length > 1 ? `<select onchange="location='/roomcheck?slot=${esc(slot)}&r='+this.value">${myRooms.map(r => `<option value="${r.id}" ${r.id === room.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>` : `<div class="card" style="padding:10px 14px"><b>${esc(room.name)}</b>${room.room_no && !room.name.includes(room.room_no) ? ` — غرفة ${esc(room.room_no)}` : ''}</div>`}
    <div class="row" style="margin:6px 0">
      ${slots.map(s => `<a class="btn ${slot === s.key ? '' : 'ghost'} grow" href="/roomcheck?r=${room.id}&slot=${s.key}">${esc(s.label.replace('تحضير الغرف — ', ''))}<br><span style="font-size:11px;opacity:.8" class="num">${esc(s.time)}</span></a>`).join('')}
    </div>
    <div class="row"><div class="stat grow"><div class="v num" id="cPresent">0</div><div class="l">موجود</div></div>
    <div class="stat grow"><div class="v num" id="cLate" style="color:var(--gold)">0</div><div class="l">متأخر</div></div>
    <div class="stat warn grow"><div class="v num" id="cAbsent">0</div><div class="l">غائب</div></div>
    <div class="stat grow"><div class="v num" id="cLeft">0</div><div class="l">لم يُحضَّر</div></div></div>
    <div class="row" style="margin:4px 0">
      <button class="btn gold grow" onclick="markAll()">✓ الكل موجود</button>
      <button class="btn ghost" id="undoBtn" onclick="undoLast()" disabled>↩️ تراجع</button>
    </div>
    <button class="btn block sec" onclick="finishTo('/today')" style="margin:4px 0">🏁 انتهيت — رجوع لمهامي</button>
    <div id="syncbar" style="display:none" class="flash">📴 بدون إنترنت — التحضير محفوظ بالجهاز وسيُرسَل تلقائياً</div>
    <div id="list" data-alpha>
      ${members.map(p => `<div class="prow" data-id="${p.id}" data-name="${esc(p.name)}" data-st="${st[p.id] || ''}">
        ${avat(p)}<div class="nm">${esc(shortName(p))}${supBadge(p.role)}</div>
        <button class="mk no" title="غائب">✗</button><button class="mk late" title="متأخر">⏱</button><button class="mk yes" title="موجود">✓</button>
      </div>`).join('')}
    </div>
    ${markingScript(d, slot, 'rcq')}
  `, { user: u, active: '/roomcheck' }));
});

// ================= «مهامي الآن» — شاشة المشرف الذكية (لا تجعله يفكّر) =================
// تحسب مهام اليوم حسب أدوار الشخص، مع «باقي/تم» لكل مهمة، وتبرز الأقرب للوقت الحالي
function nowMinutes() {
  const dt = new Date(Date.now() + 3 * 3600 * 1000); // توقيت السعودية
  return dt.getUTCHours() * 60 + dt.getUTCMinutes();
}
function toMin(t) { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; }

function myTasks(u) {
  const d = today();
  const mgr = isManager(u);
  const slots = getSlots().filter(s => s.enabled);
  const circles = circlesSupervisedBy(u.id);
  const rooms = roomsSupervisedBy(u);
  const tasks = [];

  // نطاق أعضاء الحلقات (للتحضير)
  let circleIds = null;
  if (!mgr) {
    if (circles.length) circleIds = new Set(db.prepare(`SELECT person_id FROM att_group_members WHERE group_id IN (${circles.map(g => g.id).join(',')})`).all().map(r => r.person_id));
    else if (u.role === 'attendance_supervisor') circleIds = null; // الكل
  }
  const scopeIds = mgr ? null : (circleIds || (u.role === 'attendance_supervisor' ? null : new Set()));
  const totalScope = () => scopeIds ? scopeIds.size : db.prepare("SELECT COUNT(*) c FROM people WHERE active=1").get().c;
  const markedIn = (slot) => {
    const rows = db.prepare('SELECT person_id FROM attendance WHERE date = ? AND slot = ?').all(d, slot);
    if (!scopeIds) return rows.length;
    return rows.filter(r => scopeIds.has(r.person_id)).length;
  };

  // مواعيد الحضور (الحلقات)
  if (circles.length || u.role === 'attendance_supervisor' || mgr) {
    for (const s of slots.filter(s => s.who === 'attendance')) {
      const total = totalScope(), done = markedIn(s.key);
      tasks.push({ icon: '✅', title: 'تحضير ' + s.label, time: s.time, href: '/attendance?slot=' + s.key, done, total });
    }
  }

  // التحضير (الغرف)
  if (rooms.length || mgr) {
    const roomIds = mgr ? null : new Set(rooms.map(r => r.id));
    const roomScope = mgr ? db.prepare("SELECT COUNT(*) c FROM people WHERE active=1 AND room_id IS NOT NULL").get().c
      : db.prepare(`SELECT COUNT(*) c FROM people WHERE active=1 AND room_id IN (${[...roomIds].join(',') || 0})`).get().c;
    for (const s of slots.filter(s => s.who === 'room')) {
      const rows = db.prepare('SELECT p.room_id FROM attendance a JOIN people p ON p.id=a.person_id WHERE a.date=? AND a.slot=?').all(d, s.key);
      const done = mgr ? rows.length : rows.filter(r => roomIds.has(r.room_id)).length;
      tasks.push({ icon: '🛌', title: s.label, time: s.time, href: '/roomcheck?slot=' + s.key, done, total: roomScope });
    }
  }

  // اللجان (checklist اليوم)
  for (const cm of committeesOf(u.id)) {
    const rows = db.prepare(`SELECT t.id, t.kind, (SELECT 1 FROM task_done td WHERE td.task_id=t.id AND td.date=?) dt
      FROM committee_tasks t WHERE t.committee_id=?`).all(d, cm.id);
    if (!rows.length) continue;
    const done = rows.filter(t => t.kind === 'daily' ? t.dt : false).length + rows.filter(t => t.kind === 'once' && db.prepare('SELECT done FROM committee_tasks WHERE id=?').get(t.id).done).length;
    tasks.push({ icon: '🤝', title: 'مهام ' + cm.name, time: null, href: '/committee', done, total: rows.length, soft: true });
  }

  // الباصات (مرحلة جارية فقط)
  const stage = db.prepare('SELECT * FROM bus_stages WHERE active=1').get();
  if (stage && (isSupervisor(u) || circles.length || rooms.length)) {
    const total = db.prepare("SELECT COUNT(*) c FROM people WHERE active=1").get().c;
    const done = db.prepare("SELECT COUNT(*) c FROM boardings WHERE stage_id=? AND status IN ('boarded','exempt')").get(stage.id).c;
    tasks.push({ icon: '🚌', title: '🔴 عاجل: ' + stage.name, time: null, href: '/bus?stage=' + stage.id, done, total, urgent: true });
  }

  // ترتيب: العاجل أولاً، ثم غير المكتمل الأقرب زمنياً، ثم المكتمل
  const nm = nowMinutes();
  tasks.forEach(t => {
    t.complete = t.total > 0 && t.done >= t.total;
    t.dist = t.time ? Math.min(Math.abs(toMin(t.time) - nm), 1440 - Math.abs(toMin(t.time) - nm)) : 999;
  });
  tasks.sort((a, b) => (b.urgent - a.urgent) || (a.complete - b.complete) || (a.dist - b.dist));
  return tasks;
}

app.get('/today', (c) => {
  const u = c.get('user');
  if (!u) return c.redirect('/');
  const tasks = myTasks(u);
  const d = today();
  const msg = db.prepare('SELECT * FROM daily_messages WHERE date = ?').get(d);
  const allDone = tasks.length && tasks.every(t => t.complete || t.soft);
  const card = (t, big) => {
    const rem = Math.max(0, t.total - t.done);
    const status = t.complete ? '<span class="pill g">✓ تم</span>'
      : t.total ? `<span class="pill ${t.urgent ? 'r' : 'o'}">باقي ${rem}</span>` : '';
    return `<a href="${t.href}" class="card" style="display:flex;align-items:center;gap:12px;${big ? 'border:2px solid var(--gold);background:linear-gradient(135deg,#fff,rgba(199,154,60,.06))' : ''}${t.complete ? 'opacity:.6' : ''}">
      <span style="font-size:${big ? 34 : 26}px">${t.icon}</span>
      <div class="grow"><b style="font-size:${big ? 16 : 14.5}px">${esc(t.title)}</b>
        ${t.time ? `<span class="num" style="color:var(--muted);font-size:12px"> — ${esc(t.time)}</span>` : ''}
        <div style="margin-top:3px">${status} ${t.total ? `<span style="font-size:11.5px;color:var(--muted)">${t.done}/${t.total}</span>` : ''}</div>
      </div>
      <span style="font-size:22px;color:var(--muted)">‹</span>
    </a>`;
  };
  const active = tasks.filter(t => !t.complete);
  const doneTasks = tasks.filter(t => t.complete);
  return c.html(layout('مهامي الآن', `
    ${tripCard()}
    ${msg ? `<div class="msgbar"><div class="d">رسالة اليوم</div><div style="font-size:14px;font-weight:600;margin-top:3px">${esc(msg.text)}</div></div>` : ''}
    ${allDone ? `<div class="card" style="text-align:center;padding:24px;border:2px solid var(--green)"><div style="font-size:40px">🎉</div><b style="font-size:16px;color:var(--green)">أنجزت كل مهامك اليوم</b><div style="color:var(--muted);font-size:13px;margin-top:4px">بارك الله فيك — لا شيء ينتظرك الآن</div></div>` : ''}
    ${(() => {
      const myR = roomsSupervisedBy(u).map(r => r.id);
      if (!myR.length) return '';
      const pend = db.prepare(`SELECT v.id, v.ts, p.id AS pid, p.name, r.name AS rname FROM visits v
        JOIN people p ON p.id = v.visitor_id JOIN rooms r ON r.id = v.room_id
        WHERE v.status = 'pending' AND v.room_id IN (${myR.map(() => '?').join(',')}) AND v.date = ?`).all(...myR, d);
      return pend.length ? `<div class="card" style="border:2px solid var(--gold)">
        <h3>🚪 زوّار غرفتك — ${pend.length}</h3>
        <div style="font-size:12.5px;color:var(--muted);margin-bottom:6px">اعتمد من زارك فعلاً — ضغطة واحدة لكلٍّ</div>
        ${pend.map(v => `<form method="post" action="/visit/${v.id}/approve" class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">
          <div class="grow" style="font-size:13.5px"><b>${esc(shortName({ id: v.pid, name: v.name }))}</b>
            <span style="color:var(--muted);font-size:11.5px"> زار ${esc(v.rname)} — ${esc(clock(v.ts))}</span></div>
          <button class="btn sm">✓ اعتماد</button></form>`).join('')}</div>` : '';
    })()}
    ${active.length ? `<h2 class="sec">📌 المطلوب منك الآن</h2>${active.map((t, i) => card(t, i === 0 && !t.soft)).join('')}` : ''}
    ${doneTasks.length ? `<h2 class="sec" style="color:var(--muted)">✓ أنجزته اليوم</h2>${doneTasks.map(t => card(t, false)).join('')}` : ''}
    ${!tasks.length ? `<div class="card" style="text-align:center;padding:30px">ما في مهام مسندة لك اليوم.<br><a href="/me">صفحتي الشخصية ←</a></div>` : ''}
  `, { user: u, active: '/today' }));
});

// حالة الرصد الحيّة — تسمح بالرصد من عدة أجهزة في وقت واحد وترى كل جهة ما حضّره الآخرون
app.get('/api/attendance/state', (c) => {
  const u = c.get('user');
  if (!u || !(u.role === 'attendance_supervisor' || isManager(u) || circlesSupervisedBy(u.id).length)) return c.json({ error: 'forbidden' }, 403);
  const d = c.req.query('date') || today();
  const slot = c.req.query('slot') || 'fajr';
  const marks = db.prepare('SELECT person_id, status FROM attendance WHERE date = ? AND slot = ?').all(d, slot);
  // تقدّم كل حلقة (للإشراف العام: صورة كاملة عمّن رصد ومن تبقّى)
  let circles = [];
  if (isManager(u)) {
    circles = db.prepare(`SELECT g.id, g.name, (SELECT name FROM people WHERE id = g.supervisor_id) sup,
      (SELECT COUNT(*) FROM att_group_members m JOIN people p ON p.id = m.person_id WHERE m.group_id = g.id AND p.active = 1) total
      FROM att_groups g ORDER BY g.name`).all();
    const byGroup = db.prepare(`SELECT m.group_id, COUNT(*) n FROM att_group_members m
      JOIN attendance a ON a.person_id = m.person_id AND a.date = ? AND a.slot = ?
      GROUP BY m.group_id`).all(d, slot);
    const gm = Object.fromEntries(byGroup.map(r => [r.group_id, r.n]));
    circles.forEach(g => g.done = gm[g.id] || 0);
  }
  return c.json({ marks, circles, ts: Date.now() });
});

// ================= فائدة اليوم =================
app.post('/benefit', async (c) => {
  const u = c.get('user');
  if (!u) return c.redirect('/');
  const b = await c.req.parseBody();
  const text = String(b.text || '').trim().slice(0, 220);
  const d = today();
  if (text && !db.prepare('SELECT 1 FROM benefits WHERE person_id = ? AND date = ?').get(u.id, d)) {
    db.prepare("INSERT INTO benefits (person_id, text, date, status, ts) VALUES (?, ?, ?, 'new', ?)").run(u.id, text, d, now());
    audit(u.id, 'benefit_send', `${u.name}: ${text.slice(0, 40)}`);
  }
  return c.redirect('/me');
});
app.post('/benefit/:id/:act', (c) => {
  const u = c.get('user');
  if (!isManager(u)) return deny(c);
  const id = Number(c.req.param('id')), act = c.req.param('act');
  const bn = db.prepare('SELECT * FROM benefits WHERE id = ?').get(id);
  if (!bn) return c.redirect('/admin/benefits');
  if (act === 'approve' && bn.status !== 'approved') {
    db.prepare("UPDATE benefits SET status = 'approved', approved_by = ? WHERE id = ?").run(u.id, id);
    db.prepare("INSERT INTO points (person_id, source, value, note, date, added_by, ts) VALUES (?, 'benefit', ?, 'فائدة منشورة', ?, ?, ?)")
      .run(bn.person_id, getRules().benefit_point ?? 5, bn.date, u.id, now());
  } else if (act === 'reject') {
    db.prepare("UPDATE benefits SET status = 'rejected' WHERE id = ?").run(id);
    db.prepare("DELETE FROM points WHERE person_id = ? AND source = 'benefit' AND date = ?").run(bn.person_id, bn.date);
  }
  audit(u.id, 'benefit_' + act, `فائدة #${id}`);
  return c.redirect('/admin/benefits');
});

// ═══ فوائد المشاركين — صفحة مستقلة يقرؤها الجميع ═══
app.get('/benefits', (c) => {
  const u = c.get('user');
  if (!u) return c.redirect('/');
  const d = today();
  const rows = db.prepare(`SELECT b.text, b.date, p.id AS pid, p.name, p.photo_status, p.category
    FROM benefits b JOIN people p ON p.id = b.person_id
    WHERE b.status = 'approved' ORDER BY b.date DESC, b.id DESC LIMIT 120`).all();
  const mine = db.prepare('SELECT * FROM benefits WHERE person_id = ? AND date = ?').get(u.id, d);
  // مجمّعة بالأيام — أحدث يوم أولاً
  const byDay = [];
  for (const r of rows) {
    const g = byDay.find(x => x.date === r.date);
    (g ? g.rows : (byDay.push({ date: r.date, rows: [] }), byDay[byDay.length - 1].rows)).push(r);
  }
  return c.html(layout('فوائد المشاركين', `
    <div class="card"><h3>✍️ فائدتك اليوم</h3>
      ${mine ? `<div class="row" style="padding:8px;background:rgba(63,126,68,.06);border-radius:10px">
          <span style="font-size:20px">${mine.status === 'approved' ? '🌟' : '⏳'}</span>
          <div class="grow"><div style="font-size:13.5px">${esc(mine.text)}</div>
            <div style="font-size:11.5px;color:var(--muted);margin-top:2px">${mine.status === 'approved' ? 'نُشرت للجميع — بارك الله فيك'
              : mine.status === 'rejected' ? 'لم تُنشر هذه المرة — لك غداً فائدة جديدة' : 'وصلت الإدارة — تُنشر بعد الاعتماد'}</div></div></div>`
        : `<form method="post" action="/benefit">
          <div style="font-size:12.5px;color:var(--muted);margin-bottom:6px">فائدة أو خاطرة قصيرة — إن اعتُمدت نُشرت باسمك للجميع</div>
          <textarea name="text" rows="2" maxlength="220" required placeholder="مثال: تذكّرتُ اليوم أن الصلاة في المسجد النبوي بألف صلاة..."></textarea>
          <button class="btn block" style="margin-top:8px">أرسل فائدتي</button></form>`}
    </div>
    ${rows.length ? `<div class="searchbox"><input data-filter="#benlist" placeholder="🔍 ابحث في الفوائد أو الأسماء..." autocomplete="off"></div>` : ''}
    <div id="benlist" data-rows>
    ${byDay.map(g => `<div class="card" data-search="${esc(g.rows.map(r => r.text + ' ' + r.name).join(' '))}">
      <h3>${g.date === d ? '📖 اليوم' : '📖 ' + esc(g.date)} <span class="pill m">${g.rows.length}</span></h3>
      ${g.rows.map(r => `<a href="/p/${r.pid}" style="display:flex;gap:9px;padding:9px 0;border-bottom:1px solid var(--line);text-decoration:none;color:inherit">
        ${r.photo_status === 'approved' ? `<img class="avat" loading="lazy" src="/photo/${r.pid}.jpg" alt="">` : '<span style="font-size:21px">👤</span>'}
        <div class="grow"><div style="font-size:14px;line-height:1.55">${esc(r.text)}</div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:3px">${esc(shortName(r))} ${catPill(r.category)}</div></div></a>`).join('')}
    </div>`).join('') || '<div class="card" style="text-align:center;color:var(--muted);padding:22px">لم تُنشر فوائد بعد — كن أوّلهم</div>'}
    </div>
  `, { user: u, active: '/benefits' }));
});

// صفحة اعتماد الفوائد — تصل للإدارة، ولا تُنشر إلا بضغطة
app.get('/admin/benefits', (c) => {
  const u = c.get('user');
  if (!isManager(u)) return deny(c);
  const rows = db.prepare(`SELECT b.*, p.name FROM benefits b JOIN people p ON p.id = b.person_id
    ORDER BY (b.status = 'new') DESC, b.id DESC LIMIT 80`).all();
  const pend = rows.filter(r => r.status === 'new');
  const seen = rows.filter(r => r.status !== 'new');
  const row = (b, act) => `<div class="row" style="padding:9px 0;border-bottom:1px solid var(--line)">
    <div class="grow"><div style="font-size:13.5px">${esc(b.text)}</div>
      <div style="font-size:11.5px;color:var(--muted)">${esc(b.name)} · ${esc(b.date)}</div></div>
    ${act ? `<form method="post" action="/benefit/${b.id}/approve"><button class="btn sm">✓ انشر</button></form>
      <form method="post" action="/benefit/${b.id}/reject"><button class="btn sm ghost">✕</button></form>`
      : `<span class="pill ${b.status === 'approved' ? 'g' : 'm'}">${b.status === 'approved' ? 'منشورة' : 'مرفوضة'}</span>
         <form method="post" action="/benefit/${b.id}/reject"><button class="btn sm ghost">🗑</button></form>`}
  </div>`;
  return c.html(layout('فوائد الطلاب', `
    <div class="card"><h3>✍️ بانتظار اعتمادك — ${pend.length}</h3>
      <div style="font-size:12.5px;color:var(--muted);margin-bottom:6px">
        لا شيء يُنشر للطلاب إلا بضغطتك — لا دردشة مفتوحة ولا متابعة ليلية</div>
      ${pend.map(b => row(b, true)).join('') || '<div style="color:var(--muted);font-size:13px">لا فوائد جديدة</div>'}</div>
    ${seen.length ? `<div class="card"><h3>📖 سبق النظر فيها</h3>${seen.map(b => row(b, false)).join('')}</div>` : ''}
  `, { user: u, active: '/admin' }));
});

// ملف الطالب العام — يراه الجميع (بلا سجل غياب)
app.get('/p/:id', (c) => {
  const u = c.get('user');
  if (!u) return c.redirect('/');
  const id = Number(c.req.param('id'));
  const p = db.prepare('SELECT * FROM people WHERE id = ? AND active = 1').get(id);
  if (!p) return c.html(layout('غير موجود', '<div class="card">لا يوجد مشارك بهذا الرقم.</div>', { user: u }));
  const room = p.room_id ? db.prepare('SELECT * FROM rooms WHERE id = ?').get(p.room_id) : null;
  const rk = rankOf(p);
  const coms = committeesOf(p.id);
  const hon = db.prepare(`SELECT kind, date, note FROM honor_boards WHERE person_id = ? ORDER BY id DESC LIMIT 6`).all(p.id);
  const ben = db.prepare("SELECT text, date FROM benefits WHERE person_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 5").all(p.id);
  const vis = db.prepare("SELECT COUNT(*) c FROM visits WHERE visitor_id = ? AND status = 'approved'").get(p.id).c;
  return c.html(layout(p.name, `
    <div class="card"><div class="row">
      ${p.photo_status === 'approved' ? `<img class="avat lg" src="/photo/${p.id}.jpg" alt="">`
        : '<div class="avat lg" style="display:flex;align-items:center;justify-content:center;font-size:36px">👤</div>'}
      <div class="grow"><h3 style="margin:0 0 4px">${esc(p.name)}</h3>
        ${catPill(p.category)}${supBadge(p.role)}
        ${room ? `<div style="color:var(--muted);font-size:12.5px;margin-top:4px">🛏 ${esc(room.name)}${room.label ? ' (' + esc(room.label) + ')' : ''}</div>` : ''}
        ${coms.length ? `<div style="margin-top:4px">${coms.map(x => `<span class="pill b">${esc(x.name)}</span>`).join(' ')}</div>` : ''}
      </div></div></div>
    <div class="row">
      <div class="stat grow"><div class="v num">${rk.total ?? 0}</div><div class="l">نقاطه</div></div>
      <div class="stat grow"><div class="v num">${rk.rank ?? '—'}<span style="font-size:13px;color:var(--muted)"> / ${rk.of}</span></div><div class="l">ترتيبه</div></div>
      ${vis ? `<div class="stat grow"><div class="v num">${vis}</div><div class="l">زياراته</div></div>` : ''}
    </div>
    ${hon.length ? `<div class="card"><h3>🎖️ أوسمته</h3>
      ${hon.map(h => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line);font-size:13px">
        <span style="font-size:17px">${h.kind === 'quran' ? '📖' : '🏅'}</span>
        <div class="grow">${h.kind === 'quran' ? 'لوحة شرف القرآن' : 'المتميزون'}
          ${h.note ? `<div style="font-size:11.5px;color:var(--muted)">${esc(h.note)}</div>` : ''}</div>
        <span class="num" style="font-size:11px;color:var(--muted)">${esc(h.date)}</span></div>`).join('')}</div>` : ''}
    ${ben.length ? `<div class="card"><h3>✍️ فوائده المنشورة</h3>
      ${ben.map(b => `<div style="padding:6px 0;border-bottom:1px solid var(--line);font-size:13.5px">${esc(b.text)}
        <div class="num" style="font-size:11px;color:var(--muted)">${esc(b.date)}</div></div>`).join('')}</div>` : ''}
  `, { user: u, active: '/boards' }));
});

// ================= الزيارات بين الغرف =================
app.post('/visit', async (c) => {
  const u = c.get('user');
  if (!u) return c.redirect('/');
  const b = await c.req.parseBody();
  const rid = Number(b.room_id);
  const d = today();
  // زيارة واحدة في اليوم لكل طالب — لا تُحسب مرتين مهما تنقّل
  const already = db.prepare('SELECT 1 FROM visits WHERE visitor_id = ? AND date = ?').get(u.id, d);
  if (rid && rid !== u.room_id && !already) {
    db.prepare("INSERT OR IGNORE INTO visits (visitor_id, room_id, date, status, ts) VALUES (?, ?, ?, 'pending', ?)")
      .run(u.id, rid, d, now());
  }
  return c.redirect('/me');
});
app.post('/visit/:id/approve', (c) => {
  const u = c.get('user');
  const id = Number(c.req.param('id'));
  const v = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  if (!v) return c.redirect('/today');
  // يعتمدها مشرف الغرفة المُزارة أو الإدارة — لا أحد غيرهما
  const isRoomSup = roomsSupervisedBy(u).some(r => r.id === v.room_id);
  if (!isRoomSup && !isManager(u)) return deny(c);
  if (v.status !== 'approved') {
    db.prepare("UPDATE visits SET status = 'approved', approved_by = ? WHERE id = ?").run(u.id, id);
    db.prepare("INSERT INTO points (person_id, source, value, note, date, added_by, ts) VALUES (?, 'visit', ?, 'زيارة معتمدة', ?, ?, ?)")
      .run(v.visitor_id, getRules().visit_point ?? 3, v.date, u.id, now());
    audit(u.id, 'visit_approve', `زيارة #${id}`);
  }
  return c.redirect('/today');
});

// خريطة الأسماء المختصرة تُبنى عند الإقلاع وبعد أي تعديل على الأشخاص
function refreshShortNames() {
  buildShortNames(db.prepare('SELECT id, name FROM people').all());
}
refreshShortNames();

// مجموع ما منحه/خصمه مشرف اليوم (بالقيمة المطلقة) — أساس السقف اليومي
// الساعة بتوقيت مكة من طابع زمني مخزّن
function clock(ts) {
  if (!ts) return '';
  const t = new Date(ts);
  if (isNaN(t)) return '';
  const k = new Date(t.getTime() + 3 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

// ما استهلكه هذا المانح في هذه الغرفة اليوم
function behaviorUsedInRoom(uid, roomId) {
  return db.prepare(`SELECT COALESCE(SUM(ABS(pt.value)),0) t FROM points pt
    JOIN people p ON p.id = pt.person_id
    WHERE pt.source = 'behavior' AND pt.added_by = ? AND pt.date = ? AND p.room_id = ?`)
    .get(uid, today(), roomId).t;
}
// ميزانية الغرفة = عدد سكانها × سقف الطالب — فلا تُظلم الغرفة الكبيرة ولا تُدلَّل الصغيرة
function behaviorBudgetOfRoom(roomId) {
  const occ = db.prepare('SELECT COUNT(*) c FROM people WHERE room_id = ? AND active = 1').get(roomId).c;
  return occ * (getRules().behavior_person_cap ?? 10);
}
// ما تلقّاه الطالب اليوم من كل المشرفين مجتمعين — يمنع تفاوت الغرف بعدد مشرفيها
function behaviorGotToday(pid) {
  return db.prepare(`SELECT COALESCE(SUM(ABS(value)),0) t FROM points
    WHERE source = 'behavior' AND person_id = ? AND date = ?`).get(pid, today()).t;
}

// ================= غرفتي (مشرف الغرفة) =================
app.get('/room', (c) => {
  const u = c.get('user');
  // جولة التقييم المحايدة: الإدارة + لجنة الجودة فقط — مشرف الغرفة لا يقيّم غرفته (تضارب مصلحة)
  if (!canRateRooms(u)) return deny(c);
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY CAST(room_no AS INTEGER), name').all();
  if (!rooms.length) return c.html(layout('غرفتي', `<div class="card">ما في غرفة مرتبطة فيك — كلّم الإدارة.</div>`, { user: u }));
  const rid = Number(c.req.query('r') || rooms[0].id);
  const room = rooms.find(r => r.id === rid) || rooms[0];
  const members = db.prepare("SELECT * FROM people WHERE room_id = ? AND active = 1 ORDER BY name").all(room.id);
  const d = today();
  const rated = db.prepare('SELECT * FROM room_ratings WHERE room_id = ? AND date = ?').get(room.id, d);
  const rules = getRules();
  const checkItems = db.prepare('SELECT * FROM room_check_items WHERE active = 1 ORDER BY ord, id').all();
  const checkedIds = rated?.items ? JSON.parse(rated.items) : [];
  // تقييم مكان كل ساكن — الافتراض أن الجميع مرتّبون، ولا يُضغط إلا على المُخِلّ
  const placeRows = db.prepare('SELECT person_id, ok FROM place_ratings WHERE date = ? AND person_id IN (SELECT id FROM people WHERE room_id = ?)').all(d, room.id);
  const savedBefore = placeRows.length > 0;
  const untidy = new Set(placeRows.filter(r => !r.ok).map(r => r.person_id));
  const flash = c.req.query('m');
  return c.html(layout('جولة تقييم الغرف', `
    ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
    ${rooms.length > 1 ? `<select onchange="location='/room?r='+this.value">${rooms.map(r => `<option value="${r.id}" ${r.id === room.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>` : ''}
    <div class="card"><h3>✅ جاهزية «${esc(room.name)}» — اليوم</h3>
      <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">علّم البنود المتحققة فقط — الدرجة تُحسب تلقائياً</div>
      <form method="post" action="/room/rate">
        <input type="hidden" name="room_id" value="${room.id}">
        ${checkItems.map(it => `<label class="row" style="padding:11px 12px;margin:5px 0;background:#fff;border:2px solid var(--line);border-radius:12px;cursor:pointer" class="ckrow">
          <input type="checkbox" name="items" value="${it.id}" ${checkedIds.includes(it.id) ? 'checked' : ''} style="width:22px;height:22px;flex:none;accent-color:var(--green)">
          <div class="grow" style="font-size:14px;font-weight:600">${esc(it.title)}</div>
        </label>`).join('')}
        <div class="row" style="margin-top:10px;align-items:center">
          <div class="grow" style="font-size:13px">الدرجة: <b id="scoreTxt" style="font-size:18px;color:var(--green)">${checkedIds.length}</b> من ${checkItems.length}
            <span style="color:var(--muted)">(<span id="ptsTxt">${checkedIds.length * rules.cleanliness_star}</span> نقطة)</span></div>
        </div>
        <label>ملاحظة (اختياري)</label><input name="note" value="${esc(rated?.note || '')}" placeholder="مثال: الدولاب يحتاج ترتيباً">

        <div style="margin-top:14px;padding-top:12px;border-top:2px solid var(--line)">
          <h3 style="margin:0 0 2px">🛏 مكان كل ساكن</h3>
          <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">
            الجميع مرتّبون افتراضياً — اضغط على من لم يرتّب سريره وأغراضه فقط</div>
          ${members.map(m => `<div class="plrow ${untidy.has(m.id) ? 'bad' : ''}" data-id="${m.id}"
            style="padding:10px 12px;margin:5px 0;border:2px solid var(--line);border-radius:12px;display:flex;gap:8px;align-items:center;cursor:pointer;user-select:none">
            <span class="plic" style="font-size:19px">${untidy.has(m.id) ? '⚠️' : '✅'}</span>
            <div class="grow" style="font-size:14px;font-weight:600">${esc(shortName(m))}${supBadge(m.role)}</div>
            <span class="plst pill ${untidy.has(m.id) ? 'r' : 'g'}">${untidy.has(m.id) ? 'غير مرتّب' : 'مرتّب'}</span>
          </div>`).join('')}
          <input type="hidden" name="untidy" id="untidyIn" value="${[...untidy].join(',')}">
          <div style="font-size:12px;color:var(--muted);margin-top:4px">
            <b id="tidyN">${members.length - untidy.size}</b> من ${members.length} مرتّب</div>
        </div>

        <button class="btn block" style="margin-top:12px">${rated || savedBefore ? 'تحديث تقييم اليوم' : 'حفظ التقييم'}</button>
      </form>
    </div>
    <div class="card"><h3>👥 سكان الغرفة — نقاط سلوك</h3>
      ${members.map(m => `<form method="post" action="/room/behavior" class="row" style="padding:7px 0;border-bottom:1px solid var(--line)">
        <input type="hidden" name="person_id" value="${m.id}"><input type="hidden" name="room_id" value="${room.id}">
        <div class="grow"><b>${esc(m.name)}</b>${supBadge(m.role)} ${m.notes ? `<div style='font-size:11px;color:var(--muted)'>${esc(m.notes)}</div>` : ''}</div>
        <input name="value" type="number" min="-${rules.behavior_max}" max="${rules.behavior_max}" style="width:64px" placeholder="±">
        <button class="btn sm">منح</button>
      </form>`).join('')}
      ${(() => {
        const used = behaviorUsedInRoom(u.id, room.id), cap = behaviorBudgetOfRoom(room.id);
        const left = Math.max(0, cap - used), pct = cap ? Math.round(used / cap * 100) : 0;
        const per = rules.behavior_person_cap ?? 10;
        return `<div style="margin-top:8px;padding:8px 10px;background:${left ? 'rgba(63,126,68,.06)' : 'rgba(192,57,43,.08)'};border-radius:10px">
          <div class="row" style="font-size:12.5px"><div class="grow">ميزانية «${esc(room.name)}» اليوم</div>
            <b class="num" style="color:${left ? 'var(--green)' : '#c0392b'}">${left} / ${cap}</b></div>
          <div style="height:5px;background:var(--line);border-radius:3px;margin-top:5px;overflow:hidden">
            <div style="height:100%;width:${Math.min(100, pct)}%;background:${left ? 'var(--gold)' : '#c0392b'}"></div></div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px">
            ${members.length} ساكن × ${per} = ${cap} نقطة — ميزانية بحجم الغرفة لا رقماً ثابتاً.
            ${left ? 'حد المرة الواحدة ±' + rules.behavior_max + '، ولا يتجاوز الطالب ' + per + ' في اليوم من الجميع.'
                   : 'استُنفدت — تتجدد غداً.'}</div></div>`;
      })()}
    </div>
    <script>
    // الدرجة تُحسب من البنود المتحققة — لا تقدير شخصي
    const PT=${rules.cleanliness_star};
    const boxes=[...document.querySelectorAll('input[name=items]')];
    function recalc(){const n=boxes.filter(b=>b.checked).length;
      scoreTxt.textContent=n;ptsTxt.textContent=n*PT;
      boxes.forEach(b=>{b.closest('label').style.borderColor=b.checked?'var(--green)':'var(--line)';
        b.closest('label').style.background=b.checked?'rgba(63,126,68,.06)':'#fff';});}
    boxes.forEach(b=>b.onchange=recalc);recalc();
    // مكان الساكن: ضغطة واحدة تقلب الحالة — لا قوائم ولا نجوم
    const plrows=[...document.querySelectorAll('.plrow')];
    function plsync(){
      const bad=plrows.filter(r=>r.classList.contains('bad'));
      untidyIn.value=bad.map(r=>r.dataset.id).join(',');
      tidyN.textContent=plrows.length-bad.length;
      plrows.forEach(r=>{const b=r.classList.contains('bad');
        r.style.borderColor=b?'#c0392b':'var(--green)';
        r.style.background=b?'rgba(192,57,43,.07)':'rgba(63,126,68,.05)';
        r.querySelector('.plic').textContent=b?'⚠️':'✅';
        const s=r.querySelector('.plst');s.className='plst pill '+(b?'r':'g');s.textContent=b?'غير مرتّب':'مرتّب';});
    }
    plrows.forEach(r=>r.onclick=()=>{r.classList.toggle('bad');plsync();});
    plsync();
    </script>
  `, { user: u, active: '/room' }));
});

app.post('/room/rate', async (c) => {
  const u = c.get('user');
  if (!canRateRooms(u)) return deny(c);
  const b = await c.req.parseBody({ all: true });
  // الدرجة = عدد البنود المتحققة (لا تقدير شخصي)
  const valid = new Set(db.prepare('SELECT id FROM room_check_items WHERE active = 1').all().map(r => r.id));
  const ids = (Array.isArray(b.items) ? b.items : b.items ? [b.items] : []).map(Number).filter(x => valid.has(x));
  const stars = ids.length;
  const d = today();
  db.prepare(`INSERT INTO room_ratings (room_id, date, stars, note, rated_by, items) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, date) DO UPDATE SET stars = excluded.stars, note = excluded.note, rated_by = excluded.rated_by, items = excluded.items`)
    .run(Number(b.room_id), d, stars, String(b.note || ''), u.id, JSON.stringify(ids));
  // نقاط الغرفة من الجاهزية (تُستبدل عند تحديث التقييم)
  const rules = getRules();
  db.prepare(`DELETE FROM points WHERE room_id = ? AND source = 'cleanliness' AND date = ?`).run(Number(b.room_id), d);
  db.prepare(`INSERT INTO points (room_id, source, value, note, date, added_by, ts) VALUES (?, 'cleanliness', ?, ?, ?, ?, ?)`)
    .run(Number(b.room_id), stars * rules.cleanliness_star, `جاهزية ${stars}/${valid.size}`, d, u.id, now());
  // تقييم أماكن السكان — الافتراض «مرتّب»، والمرسَل هم المُخِلّون فقط
  const bad = new Set(String(b.untidy || '').split(',').map(Number).filter(Boolean));
  const mem = db.prepare('SELECT id FROM people WHERE room_id = ? AND active = 1').all(Number(b.room_id));
  const insPlace = db.prepare(`INSERT INTO place_ratings (person_id, date, ok, rated_by, ts) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(person_id, date) DO UPDATE SET ok = excluded.ok, rated_by = excluded.rated_by, ts = excluded.ts`);
  const delPt = db.prepare("DELETE FROM points WHERE person_id = ? AND source = 'place' AND date = ?");
  const insPt = db.prepare("INSERT INTO points (person_id, source, value, note, date, added_by, ts) VALUES (?, 'place', ?, ?, ?, ?, ?)");
  for (const m of mem) {
    const ok = bad.has(m.id) ? 0 : 1;
    insPlace.run(m.id, d, ok, u.id, now());
    delPt.run(m.id, d);
    if (ok) insPt.run(m.id, rules.place_point ?? 2, 'مكانه مرتّب', d, u.id, now());
  }
  audit(u.id, 'room_rate', `غرفة ${b.room_id}: ${stars}/${valid.size} بنداً · ${mem.length - bad.size}/${mem.length} مكاناً مرتّباً`);
  return c.redirect('/room?r=' + b.room_id);
});

app.post('/room/behavior', async (c) => {
  const u = c.get('user');
  // السلوك من الجهة المحايدة نفسها (الإدارة + لجنة الجودة)
  if (!canRateRooms(u)) return deny(c);
  const b = await c.req.parseBody();
  const target = db.prepare('SELECT room_id FROM people WHERE id = ? AND active = 1').get(Number(b.person_id));
  if (!target) return deny(c);
  const rules = getRules();
  const v = Math.max(-rules.behavior_max, Math.min(rules.behavior_max, Number(b.value) || 0));
  if (v !== 0) {
    // سقف يومي لكل مشرف: يمنع إغراق الطلاب بالنقاط ويحفظ قيمتها
    const rid = Number(b.room_id);
    const used = behaviorUsedInRoom(u.id, rid);
    const cap = behaviorBudgetOfRoom(rid);
    if (Math.abs(v) + used > cap) {
      return c.redirect(`/room?r=${rid}&m=` + encodeURIComponent(
        `بلغتَ ميزانية هذه الغرفة اليوم (${cap} نقطة لـ${cap / (rules.behavior_person_cap ?? 10)} ساكن) — بقي ${Math.max(0, cap - used)}. تتجدد غداً.`));
    }
    // سقف الطالب: غرفة بخمسة مشرفين لا تتفوّق على غرفة بمشرف واحد
    const got = behaviorGotToday(Number(b.person_id));
    const pcap = rules.behavior_person_cap ?? 10;
    if (Math.abs(v) + got > pcap) {
      return c.redirect(`/room?r=${b.room_id}&m=` + encodeURIComponent(
        `هذا الطالب بلغ سقفه اليوم (${pcap} نقطة من كل المشرفين) — بقي له ${Math.max(0, pcap - got)}.`));
    }
    db.prepare(`INSERT INTO points (person_id, source, value, note, date, added_by, ts) VALUES (?, 'behavior', ?, ?, ?, ?, ?)`)
      .run(Number(b.person_id), v, v > 0 ? 'مكافأة سلوك' : 'مخالفة سلوك', today(), u.id, now());
    audit(u.id, 'behavior', `شخص ${b.person_id}: ${v} (استُهلك ${used + Math.abs(v)}/${cap})`);
  }
  return c.redirect('/room?r=' + b.room_id);
});

// ================= الباصات =================
// أي صفة إشرافية (دور مشرف، أو إشراف فعلي على غرفة/حلقة) تخوّل شاشة الباصات
function anySupervisory(u) {
  return u && (isSupervisor(u) || circlesSupervisedBy(u.id).length > 0 || roomsSupervisedBy(u).length > 0);
}
app.get('/bus', (c) => {
  const u = c.get('user');
  if (!anySupervisory(u)) return deny(c);
  const stages = db.prepare('SELECT * FROM bus_stages ORDER BY ord').all();
  const active = stages.find(s => s.active) || null;
  const sid = Number(c.req.query('stage') || (active ? active.id : stages[0]?.id));
  const stage = stages.find(s => s.id === sid) || stages[0];
  if (!stage) return c.html(layout('الباصات', `<div class="card">لا توجد مراحل — أضفها من لوحة الإدارة.</div>`, { user: u }));
  return c.html(layout('🚌 ' + stage.name, `
    <select onchange="location='/bus?stage='+this.value" style="margin-bottom:8px">
      ${stages.map(s => `<option value="${s.id}" ${s.id === stage.id ? 'selected' : ''}>${esc(s.name)}${s.active ? ' — جارية الآن' : ''}</option>`).join('')}
    </select>
    <div class="row">
      <div class="stat grow"><div class="v num" id="cB">0</div><div class="l">ركبوا</div></div>
      <div class="stat warn grow"><div class="bignum red num" id="cL" style="font-size:34px">0</div><div class="l">المتبقّي</div></div>
      <div class="stat grow"><div class="v num" id="cE">0</div><div class="l">مستأذن</div></div>
    </div>
    <div class="row" style="margin:8px 0">
      <div class="stat grow"><div class="v num" id="b1">0</div><div class="l">باص ١</div></div>
      <div class="stat grow"><div class="v num" id="b2">0</div><div class="l">باص ٢</div></div>
      <div class="stat grow"><div class="v num" id="b3">0</div><div class="l">باص ٣</div></div>
    </div>
    <div class="card"><div class="row">
      <div class="grow"><b>باص المسح الحالي:</b></div>
      ${[1, 2, 3].map(n => `<button class="btn sm ghost busSel" data-n="${n}">باص ${n}</button>`).join('')}
    </div>
    <button class="btn block sec" id="scanBtn" style="margin-top:8px">📷 فتح الكاميرا لمسح QR</button>
    <video id="cam" style="display:none" playsinline></video>
    <div id="scanMsg" style="text-align:center;font-weight:700;padding:6px"></div></div>
    <div class="searchbox"><input id="q" placeholder="🔍 تأشير يدوي بالاسم..." autocomplete="off"></div>
    <div id="list" data-alpha></div>
    <script>
    const SID=${stage.id};
    let BUS=1, alphaDone=false;
    document.querySelectorAll('.busSel').forEach(b=>{b.onclick=()=>{BUS=+b.dataset.n;
      document.querySelectorAll('.busSel').forEach(x=>x.classList.add('ghost'));b.classList.remove('ghost');};});
    document.querySelector('.busSel').classList.remove('ghost');
    let DATA=[];
    const escH=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    async function refresh(){try{const r=await fetch('/api/bus/'+SID+'/state');DATA=(await r.json()).people;render();}catch{}}
    function render(){
      const v=q.value.trim();
      const boarded=DATA.filter(p=>p.status==='boarded'),ex=DATA.filter(p=>p.status==='exempt'),left=DATA.filter(p=>!p.status);
      cB.textContent=boarded.length;cL.textContent=left.length;cE.textContent=ex.length;
      b1.textContent=boarded.filter(p=>p.bus_no===1).length;b2.textContent=boarded.filter(p=>p.bus_no===2).length;b3.textContent=boarded.filter(p=>p.bus_no===3).length;
      cL.className='bignum num '+(left.length===0?'green':'red');
      list.innerHTML=[...left,...ex,...boarded].filter(p=>!v||arNorm(v).split(' ').every(w=>arNorm(p.name).includes(w))).map(p=>
        '<div class="person-tap '+(p.status==='boarded'?'present':p.status==='exempt'?'':'absent')+'" data-name="'+escH(p.name)+'" onclick="tap('+p.id+',\\''+(p.status||'')+'\\')">'+
        '<span class="st">'+(p.status==='boarded'?'🚌':p.status==='exempt'?'🟡':'🔴')+'</span><div class="grow"><b>'+escH(p.name)+'</b>'+(p.role==='room_supervisor'?' <span class="pill b">⭐ مشرف</span>':'')+
        (p.status==='boarded'?' <span class="pill g">باص '+p.bus_no+'</span>':p.status==='exempt'?' <span class="pill o">مستأذن: '+escH(p.note||'')+'</span>':'')+'</div></div>').join('');
      if(!alphaDone&&DATA.length){alphaDone=true;buildAlpha();}
    }
    q.oninput=render;
    async function mark(body){const r=await fetch('/api/bus/mark',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({stage:SID},body))});
      const j=await r.json();if(j.name){scanMsg.textContent='✅ '+j.name+' — باص '+(body.bus||'');scanMsg.style.color='var(--green)';}
      else{scanMsg.textContent=j.error||'خطأ';scanMsg.style.color='#b22';}refresh();}
    window.tap=(id,st)=>{
      if(!st){if(confirm('تسجيل الركوب بباص '+BUS+'؟'))mark({person_id:id,action:'board',bus:BUS});
        else{const why=prompt('لن يركب هذا الباص؟ اكتب السبب (مريض، مع أهله، سبقنا للوجهة...):');if(why)mark({person_id:id,action:'exempt',note:why});}}
      else if(confirm('إلغاء التسجيل وإرجاعه للمتبقّين؟'))mark({person_id:id,action:'clear'});
    };
    // ==== مسح QR — يعمل على Safari/iPad وأندرويد وسطح المكتب ====
    let jsQRlib=null, scanCv=null;
    async function loadJsQR(){ // مكتبة احتياطية للمتصفحات بلا BarcodeDetector (منها Safari)
      if(jsQRlib)return jsQRlib;
      await new Promise((res,rej)=>{const s=document.createElement('script');s.src='/jsQR.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});
      jsQRlib=window.jsQR;return jsQRlib;
    }
    function onCode(val){
      if(!val||!val.startsWith('R:'))return;
      if(val===window.__lastCode&&Date.now()-(window.__lastT||0)<3000)return;
      window.__lastCode=val;window.__lastT=Date.now();
      navigator.vibrate&&navigator.vibrate(80);
      mark({token:val.slice(2),action:'board',bus:BUS});
    }
    scanBtn.onclick=async()=>{
      const video=document.getElementById('cam');
      if(video.style.display!=='none'){video.srcObject&&video.srcObject.getTracks().forEach(t=>t.stop());
        video.style.display='none';scanBtn.textContent='📷 فتح الكاميرا لمسح QR';return;}
      if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
        scanMsg.textContent='الكاميرا تحتاج اتصالاً آمناً (https) — استخدم التأشير اليدوي';scanMsg.style.color='#b22';return;}
      try{
        const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}});
        video.srcObject=stream;video.setAttribute('playsinline','');video.muted=true;
        video.style.display='block';await video.play();
        scanBtn.textContent='⏹️ إيقاف الكاميرا';
        scanMsg.textContent='وجّه الكاميرا نحو رمز الطالب';scanMsg.style.color='var(--muted)';
        const useNative=('BarcodeDetector' in window);
        const det=useNative?new BarcodeDetector({formats:['qr_code']}):null;
        if(!useNative)await loadJsQR();
        if(!scanCv)scanCv=document.createElement('canvas');
        const ctx=scanCv.getContext('2d',{willReadFrequently:true});
        const loop=async()=>{
          if(video.style.display==='none')return;
          try{
            if(useNative){const codes=await det.detect(video);codes.forEach(cd=>onCode(cd.rawValue||''));}
            else if(jsQRlib&&video.videoWidth){
              const w=Math.min(480,video.videoWidth), h=Math.round(video.videoHeight*(w/video.videoWidth));
              scanCv.width=w;scanCv.height=h;ctx.drawImage(video,0,0,w,h);
              const r=jsQRlib(ctx.getImageData(0,0,w,h).data,w,h,{inversionAttempts:'dontInvert'});
              if(r&&r.data)onCode(r.data);
            }
          }catch{}
          setTimeout(()=>requestAnimationFrame(loop),useNative?0:120);
        };loop();
      }catch(e){
        scanMsg.textContent=(e&&e.name==='NotAllowedError')?'رُفض إذن الكاميرا — اسمح به من إعدادات المتصفح':'تعذّر فتح الكاميرا — استخدم التأشير اليدوي';
        scanMsg.style.color='#b22';}
    };
    refresh();setInterval(refresh,7000);
    </script>
  `, { user: u, active: '/bus' }));
});

app.get('/api/bus/:stage/state', (c) => {
  const u = c.get('user');
  if (!anySupervisory(u)) return c.json({ error: 'forbidden' }, 403);
  const sid = Number(c.req.param('stage'));
  const people = db.prepare(`
    SELECT p.id, p.name, p.role, b.status, b.bus_no, b.note
    FROM people p LEFT JOIN boardings b ON b.person_id = p.id AND b.stage_id = ?
    WHERE p.active = 1 ORDER BY p.name`).all(sid);
  return c.json({ people });
});

app.post('/api/bus/mark', async (c) => {
  const u = c.get('user');
  if (!anySupervisory(u)) return c.json({ error: 'ما عندك صلاحية' }, 403);
  const b = await safeJson(c); if (!b) return c.json({ error: "طلب غير صالح" }, 400);
  const sid = Number(b.stage);
  let person = null;
  if (b.token) person = db.prepare('SELECT id, name FROM people WHERE token = ? AND active = 1').get(String(b.token));
  else if (b.person_id) person = db.prepare('SELECT id, name FROM people WHERE id = ? AND active = 1').get(Number(b.person_id));
  if (!person) return c.json({ error: 'الرمز غير معروف — أشّر يدوياً' }, 404);
  if (b.action === 'clear') {
    db.prepare('DELETE FROM boardings WHERE stage_id = ? AND person_id = ?').run(sid, person.id);
    audit(u.id, 'bus_clear', `${person.name} — مرحلة ${sid}`);
    return c.json({ name: person.name + ' (أُلغي)' });
  }
  const status = b.action === 'exempt' ? 'exempt' : 'boarded';
  const busNo = status === 'boarded' ? Math.min(3, Math.max(1, Number(b.bus) || 1)) : null;
  db.prepare(`INSERT INTO boardings (stage_id, person_id, status, bus_no, note, marked_by, ts) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stage_id, person_id) DO UPDATE SET status = excluded.status, bus_no = excluded.bus_no, note = excluded.note, marked_by = excluded.marked_by, ts = excluded.ts`)
    .run(sid, person.id, status, busNo, b.note ? String(b.note).slice(0, 200) : null, u.id, now());
  audit(u.id, 'bus_mark', `${person.name}: ${status}${busNo ? ' باص ' + busNo : ''} — مرحلة ${sid}`);
  return c.json({ name: person.name });
});

// ================= عدّاد الرحلة ومرحلتها =================
function tripStatus() {
  const start = getSetting('trip_start', '2026-08-15');
  const mecca = getSetting('trip_mecca', '2026-08-27');
  const end = getSetting('trip_end', '2026-08-29');
  const d = today();
  const days = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  const totalDays = days(start, end) + 1;
  if (d < start) {
    const left = days(d, start);
    return {
      phase: 'before', title: left === 0 ? 'الانطلاق اليوم بإذن الله' : `بقي ${left} ${left === 1 ? 'يوم' : left === 2 ? 'يومان' : left <= 10 ? 'أيام' : 'يوماً'} على الانطلاق`,
      sub: `الانطلاق من الكويت ${start} · العودة ${end}`, left, pct: 0, icon: '✈️',
    };
  }
  if (d > end) return { phase: 'after', title: 'انتهت الرحلة — تقبّل الله', sub: `${start} إلى ${end}`, pct: 100, icon: '🕌' };
  const dayNo = days(start, d) + 1;
  const inMecca = d >= mecca;
  return {
    phase: inMecca ? 'mecca' : 'medina',
    title: `اليوم ${dayNo} من ${totalDays}`,
    sub: inMecca ? `🕋 في مكة — العودة ${days(d, end) === 0 ? 'اليوم' : 'بعد ' + days(d, end) + ' يوم'}`
      : `🕌 في المدينة — الانتقال لمكة بعد ${days(d, mecca)} يوم`,
    pct: Math.round(dayNo / totalDays * 100), dayNo, totalDays, icon: inMecca ? '🕋' : '🕌',
  };
}
function tripCard() {
  const t = tripStatus();
  const bg = t.phase === 'before' ? 'linear-gradient(135deg,var(--maroon),#5d2c47)'
    : t.phase === 'mecca' ? 'linear-gradient(135deg,#8a6516,var(--gold))'
      : 'linear-gradient(135deg,var(--green),#2d5f32)';
  return `<div class="card" style="background:${bg};color:#fff;text-align:center;padding:16px">
    <div style="font-size:30px;line-height:1">${t.icon}</div>
    <div style="font-size:19px;font-weight:800;margin-top:3px">${esc(t.title)}</div>
    <div style="font-size:12.5px;opacity:.9;margin-top:3px">${esc(t.sub)}</div>
    ${t.pct > 0 && t.pct < 100 ? `<div style="background:rgba(255,255,255,.25);border-radius:6px;height:7px;margin-top:9px;overflow:hidden">
      <div style="width:${t.pct}%;height:100%;background:#fff;border-radius:6px"></div></div>` : ''}
  </div>`;
}

// ================= الchecklist الشخصية (بلا نقاط ولا ترتيب — رفيق يومي) =================
// أيام الأسبوع (0=الأحد ... 5=الجمعة)
const WEEKDAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const weekdayOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();

// تصنيفات التكرار المعتمدة — «مرة في الموسم» أُلغيت بقرار الإدارة
const REPEATS = {
  daily:  { label: 'يومية', pill: 'g' },
  alt:    { label: 'يوم وترك', pill: 'o' },
  weekly: { label: 'أسبوعية', pill: 'o' },
  twice:  { label: 'مرتين في الأسبوع', pill: 'o' },
  once:   { label: 'مرة واحدة', pill: 'm' },
};
// «يوم وترك» تُحسب من يوم انطلاق الرحلة فتبقى منتظمة طوال الأيام
function altDay(d) {
  const s = getSetting('trip_start', '2026-08-15');
  const diff = Math.round((new Date(d + 'T00:00:00Z') - new Date(s + 'T00:00:00Z')) / 86400000);
  return (((diff % 2) + 2) % 2) === 0;
}
// هل يظهر هذا البند/المهمة في هذا اليوم؟
function dueOn(kind, d, wd1, wd2) {
  const dow = weekdayOf(d);
  if (kind === 'alt') return altDay(d);
  if (kind === 'weekly') return dow === (wd1 ?? 5);
  if (kind === 'twice') return dow === (wd1 ?? 0) || dow === (wd2 ?? 3);
  return true;   // daily / once
}
function dueToday(item, d) {
  return dueOn(item.repeat_kind || 'daily', d, item.weekday, item.weekday2);
}
// المهام المتكررة تُسجَّل إنجازها يوماً بيوم (لا مرة واحدة للأبد)
// يوم الأسبوع: الأحد = 0 وهي قيمة مشروعة — «|| افتراضي» كان يبتلعها ويحوّلها للجمعة
function wdOf(v, dflt) {
  const x = Number(v);
  return Number.isInteger(x) && x >= 0 && x <= 6 ? x : dflt;
}
const PER_DAY = new Set(['daily', 'alt', 'weekly', 'twice']);

// منتقي التكرار — واحد لكل الشاشات، فلا يختلف السلوك من مكان لآخر
function repeatPicker(sel = 'daily', wd1 = 5, wd2 = 3, prefix = '') {
  const kindName = prefix ? prefix + 'kind' : 'repeat_kind';
  const days = (nm, v) => `<select name="${nm}">${WEEKDAYS.map((w, i) =>
    `<option value="${i}" ${i === v ? 'selected' : ''}>${w}</option>`).join('')}</select>`;
  return `<div class="row rp" style="margin-top:6px;align-items:flex-end;flex-wrap:wrap">
    <div><label>التكرار</label>
      <select name="${kindName}" onchange="rpSync(this)">
        ${Object.entries(REPEATS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select></div>
    <div class="rp1" style="display:${sel === 'weekly' || sel === 'twice' ? '' : 'none'}">
      <label>${sel === 'twice' ? 'اليوم الأول' : 'اليوم'}</label>${days('weekday', wd1)}</div>
    <div class="rp2" style="display:${sel === 'twice' ? '' : 'none'}">
      <label>اليوم الثاني</label>${days('weekday2', wd2)}</div>`;
}
const RP_SCRIPT = `<script>
function rpSync(s){const w=s.closest('.rp'),k=s.value;
  const a=w.querySelector('.rp1'),b=w.querySelector('.rp2');
  a.style.display=(k==='weekly'||k==='twice')?'':'none';
  b.style.display=(k==='twice')?'':'none';
  a.querySelector('label').textContent=(k==='twice')?'اليوم الأول':'اليوم';}
<\/script>`;

function myChecklist(personId, d) {
  const items = db.prepare(`SELECT * FROM checklist_items
    WHERE active = 1 AND (person_id IS NULL OR person_id = ?) ORDER BY person_id IS NOT NULL, ord, id`).all(personId)
    .filter(i => dueToday(i, d));
  const done = new Set(db.prepare('SELECT item_id FROM checklist_done WHERE person_id = ? AND date = ?').all(personId, d).map(r => r.item_id));
  items.forEach(i => { i.done = done.has(i.id); i.mine = i.person_id !== null; });
  return items;
}
// سلسلة الأيام المتتالية التي أتمّ فيها كل بنوده
function streakOf(personId) {
  let streak = 0;
  for (let k = 0; k < 60; k++) {
    const dt = new Date(Date.now() + 3 * 3600 * 1000 - k * 86400000).toISOString().slice(0, 10);
    const items = db.prepare(`SELECT COUNT(*) c FROM checklist_items WHERE active=1 AND (person_id IS NULL OR person_id=?)`).get(personId).c;
    if (!items) break;
    const done = db.prepare('SELECT COUNT(*) c FROM checklist_done WHERE person_id=? AND date=?').get(personId, dt).c;
    if (done >= items) streak++;
    else if (k > 0) break;               // اليوم الحالي لا يكسر السلسلة
    else if (k === 0 && done < items) continue;
  }
  return streak;
}

app.post('/checklist/toggle', async (c) => {
  const u = c.get('user');
  if (!u) return deny(c);
  const b = await c.req.parseBody();
  const id = Number(b.item_id), d = today();
  const it = db.prepare('SELECT person_id FROM checklist_items WHERE id = ? AND active = 1').get(id);
  if (!it || (it.person_id !== null && it.person_id !== u.id)) return deny(c);
  const has = db.prepare('SELECT 1 FROM checklist_done WHERE item_id=? AND person_id=? AND date=?').get(id, u.id, d);
  if (has) db.prepare('DELETE FROM checklist_done WHERE item_id=? AND person_id=? AND date=?').run(id, u.id, d);
  else db.prepare('INSERT INTO checklist_done (item_id, person_id, date) VALUES (?, ?, ?)').run(id, u.id, d);
  return c.redirect('/me#checklist');
});
app.post('/checklist/add', async (c) => {
  const u = c.get('user');
  if (!u) return deny(c);
  const b = await c.req.parseBody();
  const title = String(b.title || '').trim();
  if (!title) return c.redirect('/me#checklist');
  const mx = db.prepare('SELECT COALESCE(MAX(ord),0) m FROM checklist_items WHERE person_id = ?').get(u.id).m;
  const rk = b.repeat_kind === 'weekly' ? 'weekly' : 'daily';
  const wd = rk === 'weekly' ? wdOf(b.weekday, 5) : null;
  db.prepare('INSERT INTO checklist_items (person_id, title, ord, created_by, ts, repeat_kind, weekday) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(u.id, title.slice(0, 120), mx + 1, u.id, now(), rk, wd);
  return c.redirect('/me#checklist');
});
app.post('/checklist/:id/delete', (c) => {
  const u = c.get('user');
  if (!u) return deny(c);
  const id = Number(c.req.param('id'));
  const it = db.prepare('SELECT person_id FROM checklist_items WHERE id = ?').get(id);
  if (it && it.person_id === u.id) db.prepare('DELETE FROM checklist_items WHERE id = ?').run(id);
  return c.redirect('/me#checklist');
});

// ================= ترشيح متميز (أي مشرف — بسبب مكتوب) =================
app.get('/nominate', (c) => {
  const u = c.get('user');
  if (!anySupervisory(u)) return deny(c);
  const d = today();
  const mine = db.prepare(`SELECT n.*, p.name AS pname FROM nominations n JOIN people p ON p.id=n.person_id
    WHERE n.by_id=? ORDER BY n.id DESC LIMIT 10`).all(u.id);
  // نطاقه: أعضاء حلقاته وسكان غرفه، وإن كان إداري فالجميع
  let scope;
  if (isManager(u)) scope = db.prepare("SELECT id,name,category FROM people WHERE active=1 AND role='student' ORDER BY name").all();
  else {
    const gids = circlesSupervisedBy(u.id).map(g => g.id);
    const rids = roomsSupervisedBy(u).map(r => r.id);
    scope = db.prepare(`SELECT DISTINCT p.id,p.name,p.category FROM people p
      WHERE p.active=1 AND (
        ${gids.length ? `p.id IN (SELECT person_id FROM att_group_members WHERE group_id IN (${gids.join(',')}))` : '0'}
        OR ${rids.length ? `p.room_id IN (${rids.join(',')})` : '0'}) ORDER BY p.name`).all();
  }
  return c.html(layout('🏅 ترشيح متميز', `
    <div class="card" style="font-size:12.5px;color:var(--muted)">
      رشّح من رأيت منه <b style="color:var(--ink)">مبادرة أو خدمة أو خُلقاً</b> يستحق التكريم — واكتب ما رأيته بالضبط.
      ترشيحك يصل الإدارة ويُحتسب في اختيار المتميزين.</div>
    <div class="card"><h3>➕ ترشيح جديد</h3>
      <form method="post" action="/nominate">
        <label>الطالب</label>
        <select name="person_id" required>${scope.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <label>ماذا رأيت منه؟</label>
        <textarea name="reason" rows="2" required placeholder="مثال: رتّب أغراض إخوانه في الغرفة قبل التحرك بلا أن يُطلب منه"></textarea>
        <button class="btn block" style="margin-top:10px">إرسال الترشيح</button>
      </form></div>
    ${mine.length ? `<div class="card"><h3>ترشيحاتك السابقة</h3>
      ${mine.map(n => `<div style="padding:6px 0;border-bottom:1px solid var(--line);font-size:13px">
        <b>${esc(n.pname)}</b> <span class="num" style="color:var(--muted);font-size:11px">${esc(n.date)}</span>
        <div style="color:var(--muted);font-size:12px">${esc(n.reason)}</div></div>`).join('')}</div>` : ''}
  `, { user: u, active: '/today' }));
});
app.post('/nominate', async (c) => {
  const u = c.get('user');
  if (!anySupervisory(u)) return deny(c);
  const b = await c.req.parseBody();
  const pid = Number(b.person_id), reason = String(b.reason || '').trim();
  if (!pid || !reason) return c.redirect('/nominate');
  db.prepare('INSERT INTO nominations (person_id, by_id, reason, date, ts) VALUES (?, ?, ?, ?, ?)')
    .run(pid, u.id, reason.slice(0, 500), today(), now());
  audit(u.id, 'nominate', `رشّح #${pid}`);
  return c.redirect('/nominate');
});

// ================= لجنتي (أعضاء اللجان: طلبات اللجنة + مهامها) =================
function myCommitteeIds(u) {
  return committeesOf(u.id).map(cm => cm.id);
}
app.get('/committee', (c) => {
  const u = c.get('user');
  if (!u) return c.redirect('/');
  const coms = committeesOf(u.id);
  if (!coms.length && !isManager(u)) return deny(c);
  const ids = coms.length ? coms.map(x => x.id) : db.prepare('SELECT id FROM committees').all().map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  const d = today();
  const reqs = ids.length ? db.prepare(`SELECT r.*, p.name AS person, cm.name AS committee FROM requests r
    LEFT JOIN people p ON p.id = r.person_id JOIN committees cm ON cm.id = r.committee_id
    WHERE r.committee_id IN (${ph})
    ORDER BY CASE r.status WHEN 'new' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END, r.id DESC LIMIT 100`).all(...ids) : [];
  // المهمة اليومية «تمت» ليوم واحد فقط — تتصفّر تلقائياً كل يوم
  const tasks = (ids.length ? db.prepare(`SELECT t.*, cm.name AS committee,
    (SELECT 1 FROM task_done td WHERE td.task_id = t.id AND td.date = ?) AS done_today
    FROM committee_tasks t JOIN committees cm ON cm.id = t.committee_id
    WHERE t.committee_id IN (${ph}) ORDER BY t.id DESC LIMIT 50`).all(d, ...ids) : [])
    .map(t => ({ ...t, isDone: PER_DAY.has(t.kind) ? !!t.done_today : !!t.done }))
    .filter(t => dueOn(t.kind, today(), t.weekday, t.weekday2));
  const stName = { new: 'جديد', processing: 'قيد المعالجة', done: 'تم' };
  const doneN = tasks.filter(t => t.isDone).length;
  return c.html(layout('لجنتي', `
    <div class="card"><b>${coms.map(x => esc(x.name) + (x.is_head ? ' 👑' : '')).join(' + ') || 'كل اللجان'}</b>
      ${tasks.length ? `<span class="pill g">${Math.round(doneN / tasks.length * 100)}٪ إنجاز اليوم</span>` : ''}</div>
    <div class="searchbox"><input data-filter="#comall" placeholder="🔍 بحث في المهام والطلبات..." autocomplete="off"></div>
    <div id="comall">
    <h2 class="sec">📋 checklist اللجنة${tasks.some(t => t.kind === 'daily') ? ' — اليومية تتجدد كل يوم' : ''}</h2>
    ${tasks.sort((a, b) => a.isDone - b.isDone).map(t => `<div class="card row" style="padding:10px 14px">
      <span style="font-size:18px">${t.isDone ? '✅' : '⬜'}</span>
      <div class="grow" style="${t.isDone ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(t.title)}
        <span class="pill m">${esc(t.committee)}</span>${t.kind === 'daily' ? '<span class="pill g">يومية</span>' : ''}</div>
      <form method="post" action="/committee/tasks/${t.id}/toggle"><button class="btn sm ${t.isDone ? 'ghost' : ''}">${t.isDone ? 'إرجاع' : 'تم ✓'}</button></form>
    </div>`).join('') || '<div class="card">لا مهام حالياً</div>'}
    <h2 class="sec">📥 طلبات موجهة للجنة</h2>
    ${reqs.map(r => `<div class="card"><div class="row">
      <span class="pill ${r.category === 'بلاغ طبي' ? 'r' : 'm'}">${esc(r.category || '')}</span>
      <div class="grow" style="font-size:12px;color:var(--muted)">${esc(r.person || '؟')} — ${esc(r.committee)}</div>
      <span class="pill ${r.status === 'done' ? 'g' : r.status === 'processing' ? 'o' : 'r'}">${stName[r.status]}</span></div>
      <div style="margin:6px 0">${esc(r.text)}</div>
      <div class="row">${['new', 'processing', 'done'].filter(s => s !== r.status).map(s =>
        `<form method="post" action="/committee/requests/${r.id}/status" class="grow"><input type="hidden" name="status" value="${s}">
        <button class="btn sm block ${s === 'done' ? '' : 'ghost'}">${stName[s]}</button></form>`).join('')}</div>
    </div>`).join('') || '<div class="card">لا طلبات موجهة للجنتك</div>'}
    </div>
  `, { user: u, active: '/committee' }));
});
app.post('/committee/requests/:id/status', async (c) => {
  const u = c.get('user');
  if (!u) return deny(c);
  const r = db.prepare('SELECT committee_id FROM requests WHERE id = ?').get(Number(c.req.param('id')));
  if (!r || (!isManager(u) && !myCommitteeIds(u).includes(r.committee_id))) return deny(c);
  const b = await c.req.parseBody();
  if (!['new', 'processing', 'done'].includes(String(b.status))) return deny(c);
  db.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run(String(b.status), now(), Number(c.req.param('id')));
  audit(u.id, 'request_status', `#${c.req.param('id')} ← ${b.status} (لجنة)`);
  return c.redirect('/committee');
});
app.post('/committee/tasks/:id/toggle', (c) => {
  const u = c.get('user');
  if (!u) return deny(c);
  const id = Number(c.req.param('id'));
  const t = db.prepare('SELECT committee_id, done, kind FROM committee_tasks WHERE id = ?').get(id);
  if (!t || (!isManager(u) && !myCommitteeIds(u).includes(t.committee_id))) return deny(c);
  if (PER_DAY.has(t.kind)) {
    // اليومية: تُعلَّم لهذا اليوم فقط
    const d = today();
    const doneToday = db.prepare('SELECT 1 FROM task_done WHERE task_id = ? AND date = ?').get(id, d);
    if (doneToday) db.prepare('DELETE FROM task_done WHERE task_id = ? AND date = ?').run(id, d);
    else db.prepare('INSERT INTO task_done (task_id, date, done_by, done_at) VALUES (?, ?, ?, ?)').run(id, d, u.id, now());
  } else {
    db.prepare('UPDATE committee_tasks SET done = ?, done_by = ?, done_at = ? WHERE id = ?').run(t.done ? 0 : 1, u.id, now(), id);
  }
  audit(u.id, 'task_toggle', `#${id} (لجنة)`);
  return c.redirect('/committee');
});

// ================= لوحة الإدارة =================
app.route('/admin', adminRoutes);

// نسخ احتياطي تلقائي — فحص كل ٦ ساعات، نسخة واحدة يومياً (المنطق في db.js)
setInterval(() => require('./db').backupNow(), 3 * 3600 * 1000);   // فحص كل ٣ ساعات

const PORT = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`🕌 تطبيق رحلة المدينة يعمل على http://localhost:${PORT}`);
  ensureToday().catch(() => {});
  require('./db').backupNow();
});
