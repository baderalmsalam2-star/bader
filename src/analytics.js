// 🔬 التحليلات — صفحة خاصة بالمؤسس وحده: بيانات تقنية وأمنية لا تخصّ الإدارة
const { Hono } = require('hono');
const { db, now, today, audit, getSetting } = require('./db');
const { isAdmin, deny, deviceName } = require('./auth');
const { layout, esc } = require('./views');

const an = new Hono();
an.use('*', async (c, next) => {
  const real = c.get('realUser') || c.get('user');
  if (!isAdmin(real)) return deny(c);
  await next();
});

const ago = (iso) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'الآن';
  if (m < 60) return `قبل ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `قبل ${h} ساعة`;
  return `قبل ${Math.floor(h / 24)} يوم`;
};

an.get('/', (c) => {
  const u = c.get('user');
  const me = c.get('realUser') || u;
  const q = (s, ...a) => db.prepare(s).get(...a);
  const all = (s, ...a) => db.prepare(s).all(...a);
  const d = today();
  const m = c.req.query('m');

  // ===== أجهزة دخلت حسابي (الأهم) =====
  const myDevices = all(`SELECT * FROM sessions WHERE person_id = ? ORDER BY last_seen DESC`, me.id);

  // ===== الاستخدام =====
  const totalPeople = q('SELECT COUNT(*) c FROM people WHERE active=1').c;
  const loggedIn = q(`SELECT COUNT(DISTINCT person_id) c FROM sessions`).c;
  const totalSessions = q('SELECT COUNT(*) c FROM sessions').c;
  const totalHits = q('SELECT COALESCE(SUM(hits),0) c FROM sessions').c;
  const activeToday = q(`SELECT COUNT(DISTINCT person_id) c FROM sessions WHERE last_seen >= ?`, d).c;
  const devices = all(`SELECT device, COUNT(*) n, SUM(hits) h FROM sessions GROUP BY device ORDER BY n DESC`);
  const multiDevice = all(`SELECT p.name, COUNT(*) n FROM sessions s JOIN people p ON p.id=s.person_id
    GROUP BY s.person_id HAVING n > 1 ORDER BY n DESC LIMIT 10`);

  // ===== الأخطاء والأمان =====
  const secEvents = all(`SELECT action, COUNT(*) n FROM audit
    WHERE action IN ('login_fail','admin_pin_fail','admin_pin_ok','login_new_device','view_as','retoken','person_delete','backup_failed')
    GROUP BY action ORDER BY n DESC`);
  const ACT = {
    login_fail: '🔴 محاولة دخول برمز خاطئ', admin_pin_fail: '🔴 رمز إدارة خاطئ',
    admin_pin_ok: '🔑 اعتماد جهاز للإدارة', login_new_device: '📱 دخول من جهاز جديد',
    view_as: '👁️ معاينة حساب', retoken: '🔄 تجديد رابط', person_delete: '🗑️ حذف شخص',
    backup_failed: '⚠️ فشل نسخة احتياطية',
  };
  const recentSec = all(`SELECT a.ts, a.action, a.detail, p.name FROM audit a LEFT JOIN people p ON p.id=a.who
    WHERE a.action IN ('login_fail','admin_pin_fail','admin_pin_ok','view_as','retoken','backup_failed')
    ORDER BY a.id DESC LIMIT 20`);

  // ===== حجم البيانات =====
  const tables = ['people', 'attendance', 'points', 'sessions', 'audit', 'expenses', 'boardings', 'room_ratings', 'quiz_answers', 'quran_marks', 'requests'];
  const sizes = tables.map(t => ({ t, n: q(`SELECT COUNT(*) c FROM ${t}`).c })).sort((a, b) => b.n - a.n);
  const fs2 = require('fs'), path2 = require('path');
  const dbFile = path2.join(__dirname, '..', 'data', 'rihla.db');
  const dbKb = fs2.existsSync(dbFile) ? Math.round(fs2.statSync(dbFile).size / 1024) : 0;
  const bDir = path2.join(__dirname, '..', 'data', 'backups');
  const backups = fs2.existsSync(bDir) ? fs2.readdirSync(bDir).filter(x => x.endsWith('.db')) : [];

  // ===== أكثر الأوقات نشاطاً =====
  const byHour = all(`SELECT substr(ts,12,2) h, COUNT(*) n FROM audit WHERE action NOT LIKE 'backup%' GROUP BY h ORDER BY n DESC LIMIT 5`);

  // ===== نشاط كل شخص =====
  const topActive = all(`SELECT p.name, p.role, SUM(s.hits) h, COUNT(*) devs FROM sessions s
    JOIN people p ON p.id=s.person_id GROUP BY s.person_id ORDER BY h DESC LIMIT 10`);

  const card = (v, l, cls = '') => `<div class="stat ${cls}"><div class="v num">${v}</div><div class="l">${l}</div></div>`;

  return c.html(layout('🔬 التحليلات', `
    ${m ? `<div class="flash">${esc(m)}</div>` : ''}
    <div class="card" style="background:rgba(122,59,93,.07);border:1px solid rgba(122,59,93,.25);font-size:12.5px">
      🔒 هذه الصفحة <b>لك وحدك</b> — لا يراها رؤساء الوفد ولا أي مشرف. بيانات تقنية وأمنية لمتابعة التطبيق نفسه.
    </div>

    <h2 class="sec">🛡️ أجهزة دخلت حسابك</h2>
    <div class="card">
      ${myDevices.length ? myDevices.map(s => `<div style="padding:9px 0;border-bottom:1px solid var(--line)">
        <div class="row">
          <span style="font-size:18px">${/آيفون|آيباد/.test(s.device) ? '📱' : /أندرويد/.test(s.device) ? '🤖' : /ويندوز/.test(s.device) ? '🖥️' : /ماك/.test(s.device) ? '💻' : '❓'}</span>
          <div class="grow"><b>${esc(s.device)}</b>
            <div style="font-size:11px;color:var(--muted)">${esc(s.ip)} · ${s.hits} دخول · آخر مرة ${esc(ago(s.last_seen))}</div></div>
          <form method="post" action="/admin/analytics/session/${s.id}/forget"><button class="btn sm ghost">🗑 نسيان</button></form>
        </div></div>`).join('')
      : '<div style="color:var(--muted)">لا جلسات مسجّلة بعد</div>'}
      <form method="post" action="/admin/analytics/revoke-mine" style="margin-top:12px"
        onsubmit="return confirm('سيتم إخراج جميع الأجهزة من حسابك (بما فيها هذا الجهاز) وتوليد رابط جديد لك. متأكد؟')">
        <button class="btn block" style="background:#b22">🚨 إبطال كل الجلسات وتوليد رابط جديد</button></form>
      <div style="font-size:11.5px;color:var(--muted);text-align:center;margin-top:4px">
        استخدمه لو شككت أن أحداً دخل حسابك — يُبطل رابطك القديم فوراً</div>
    </div>

    <h2 class="sec">📊 الاستخدام</h2>
    <div class="grid2 g4">
      ${card(loggedIn + '/' + totalPeople, 'دخلوا التطبيق')}
      ${card(activeToday, 'نشطون اليوم')}
      ${card(totalSessions, 'أجهزة مسجّلة')}
      ${card(totalHits, 'مرات دخول')}
    </div>
    <div class="card"><h3>الأجهزة</h3>
      ${devices.map(x => `<div class="row" style="padding:4px 0;border-bottom:1px solid var(--line);font-size:13.5px">
        <div class="grow">${esc(x.device)}</div><span class="pill m num">${x.n} جهاز</span><b class="num">${x.h}</b></div>`).join('')}
    </div>
    ${multiDevice.length ? `<div class="card"><h3>دخلوا من أكثر من جهاز</h3>
      ${multiDevice.map(x => `<div class="row" style="padding:4px 0;font-size:13px">
        <div class="grow">${esc(x.name)}</div><span class="pill o num">${x.n} أجهزة</span></div>`).join('')}
      <div style="font-size:11px;color:var(--muted);margin-top:4px">قد يعني مشاركة الرابط — راجعه إن كان غير متوقع</div></div>` : ''}
    ${topActive.length ? `<div class="card"><h3>الأكثر استخداماً للتطبيق</h3>
      ${topActive.map((x, i) => `<div class="row" style="padding:4px 0;border-bottom:1px solid var(--line);font-size:13px">
        <span style="width:22px">${i + 1}</span><div class="grow">${esc(x.name)}</div>
        <span class="pill g num">${x.h} دخول</span></div>`).join('')}</div>` : ''}

    <h2 class="sec">🔐 الأحداث الأمنية</h2>
    <div class="card">
      ${secEvents.map(e => `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line);font-size:13px">
        <div class="grow">${ACT[e.action] || esc(e.action)}</div>
        <span class="pill ${e.action.includes('fail') ? 'r' : 'm'} num">${e.n}</span></div>`).join('') || '<div style="color:var(--muted)">لا أحداث</div>'}
    </div>
    ${recentSec.length ? `<details class="fold"><summary><span class="ttl">آخر ٢٠ حدثاً أمنياً</span></summary>
      <div class="foldbody" style="font-size:12px">
        ${recentSec.map(r => `<div style="padding:5px 0;border-bottom:1px solid var(--line)">
          <span class="num" style="color:var(--muted)">${esc(r.ts.slice(5, 16).replace('T', ' '))}</span>
          — ${ACT[r.action] || esc(r.action)} ${r.name ? '· ' + esc(r.name) : ''}
          <div style="color:var(--muted);font-size:11px">${esc((r.detail || '').slice(0, 80))}</div></div>`).join('')}
      </div></details>` : ''}

    <h2 class="sec">💾 حجم البيانات</h2>
    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <div class="grow"><b>حجم قاعدة البيانات</b></div><b class="num">${dbKb} KB</b></div>
      <div class="row" style="margin-bottom:8px">
        <div class="grow"><b>النسخ الاحتياطية</b></div><b class="num">${backups.length}</b></div>
      ${sizes.filter(x => x.n).map(x => `<div class="row" style="padding:3px 0;font-size:12.5px">
        <div class="grow" style="color:var(--muted)">${esc(x.t)}</div><b class="num">${x.n}</b></div>`).join('')}
    </div>

    ${byHour.length ? `<div class="card"><h3>أكثر الساعات نشاطاً</h3>
      ${byHour.map(h => `<span class="pill g num">${h.h}:00 — ${h.n}</span> `).join('')}
      <div style="font-size:11px;color:var(--muted);margin-top:4px">بتوقيت غرينتش (أضف ٣ ساعات لتوقيت السعودية)</div></div>` : ''}

    <div class="card"><a class="btn block ghost" href="/admin/analytics/export.json">📥 تصدير كل التحليلات (JSON)</a></div>
  `, { user: u, active: '/admin', wide: true, viewingAs: c.get('realUser') }));
});

// نسيان جهاز واحد
an.post('/session/:id/forget', (c) => {
  const me = c.get('realUser') || c.get('user');
  const id = Number(c.req.param('id'));
  const s = db.prepare('SELECT person_id, device FROM sessions WHERE id = ?').get(id);
  if (s && s.person_id === me.id) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    audit(me.id, 'session_forget', `${s.device}`);
  }
  return c.redirect('/admin/analytics?m=' + encodeURIComponent('نُسي الجهاز من السجل'));
});

// إبطال كل الجلسات: توليد رمز جديد → كل الأجهزة تخرج فوراً
an.post('/revoke-mine', (c) => {
  const me = c.get('realUser') || c.get('user');
  const crypto = require('crypto');
  const fresh = crypto.randomBytes(6).toString('base64url');
  db.prepare('UPDATE people SET token = ? WHERE id = ?').run(fresh, me.id);
  db.prepare('DELETE FROM sessions WHERE person_id = ?').run(me.id);
  audit(me.id, 'revoke_all_sessions', 'إبطال كل جلسات المؤسس وتوليد رابط جديد');
  const { deleteCookie } = require('hono/cookie');
  deleteCookie(c, 'rihla', { path: '/' });
  deleteCookie(c, 'rihla_real', { path: '/' });
  deleteCookie(c, 'apin', { path: '/' });
  return c.html(layout('رابطك الجديد', `
    <div class="card" style="text-align:center;padding:30px 18px;border:2px solid var(--gold)">
      <div style="font-size:44px">🔐</div>
      <h3>أُبطلت كل الجلسات</h3>
      <p style="color:var(--muted);font-size:13.5px">رابطك القديم لم يعد يعمل على أي جهاز. هذا رابطك الجديد — احفظه:</p>
      <input readonly value="/d/${fresh}" onclick="this.select()" style="direction:ltr;text-align:center;font-size:15px;font-weight:700">
      <a class="btn block" href="/d/${fresh}" style="margin-top:12px">الدخول بالرابط الجديد</a>
    </div>`));
});

// تصدير التحليلات
an.get('/export.json', (c) => {
  const me = c.get('realUser') || c.get('user');
  const all = (s, ...a) => db.prepare(s).all(...a);
  const data = {
    generated: now(),
    sessions: all('SELECT person_id, device, ip, first_seen, last_seen, hits FROM sessions ORDER BY last_seen DESC'),
    securityEvents: all(`SELECT ts, action, detail FROM audit WHERE action LIKE '%fail%' OR action LIKE 'login%' OR action='view_as' ORDER BY id DESC LIMIT 500`),
    counts: ['people', 'attendance', 'points', 'sessions', 'audit', 'expenses'].reduce((o, t) => {
      o[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; return o;
    }, {}),
  };
  audit(me.id, 'analytics_export', '');
  c.header('Content-Type', 'application/json; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="rihla-analytics-${today()}.json"`);
  return c.body(JSON.stringify(data, null, 1));
});

module.exports = an;
