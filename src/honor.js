// لوحات الشرف اليدوية: القرآن (من اللجنة العلمية) والمتميزون (بترشيح بشري)
const { Hono } = require('hono');
const { db, now, today, audit } = require('./db');
const { isManager, deny, isSupervisor, circlesSupervisedBy, roomsSupervisedBy } = require('./auth');
const { layout, esc, catPill } = require('./views');

const honor = new Hono();

const KINDS = {
  quran: { title: '📖 لوحة شرف القرآن', desc: 'الأسماء تصل من اللجنة العلمية — تُدخَل هنا كما هي', icon: '📖' },
  distinguished: { title: '🏅 المتميزون', desc: 'المرشّحون للتكريم — الأرقام ترشّح والإدارة تحسم', icon: '🏅' },
};

// المرشَّحون بالأرقام: حضور + جاهزية غرفته + ترشيحات المشرفين (كلها مرصودة من غيره)
function shortlist(limit = 20) {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.category,
      (SELECT COUNT(*) FROM attendance a WHERE a.person_id=p.id AND a.status='present') pres,
      (SELECT COUNT(*) FROM attendance a WHERE a.person_id=p.id) att,
      (SELECT COUNT(*) FROM nominations n WHERE n.person_id=p.id) noms,
      (SELECT COALESCE(AVG(rr.stars),0) FROM room_ratings rr WHERE rr.room_id=p.room_id) roomAvg,
      (SELECT COALESCE(SUM(pt.value),0) FROM points pt WHERE pt.person_id=p.id AND pt.source='behavior' AND pt.value>0) goodBehavior
    FROM people p WHERE p.active=1 AND p.role='student'`).all();
  const maxItems = db.prepare('SELECT COUNT(*) c FROM room_check_items WHERE active=1').get().c || 5;
  for (const r of rows) {
    const attendPct = r.att ? r.pres / r.att : 0;
    r.score = Math.round(
      attendPct * 45 +                                   // الانضباط ٤٥٪
      (r.roomAvg / maxItems) * 20 +                      // جاهزية سكنه ٢٠٪
      Math.min(1, r.noms / 3) * 25 +                     // ترشيحات المشرفين ٢٥٪
      Math.min(1, r.goodBehavior / 30) * 10              // مبادرات مسجّلة ١٠٪
    );
    r.attendPct = Math.round(attendPct * 100);
  }
  rows.sort((a, b) => b.score - a.score || b.noms - a.noms);
  return rows.slice(0, limit);
}

// ===== إدارة اللوحتين =====
honor.get('/', (c) => {
  const u = c.get('user');
  if (!isManager(u)) return deny(c);
  const d = c.req.query('d') || today();
  const kind = c.req.query('k') === 'distinguished' ? 'distinguished' : 'quran';
  const K = KINDS[kind];
  const current = db.prepare(`SELECT h.*, p.name AS pname, p.category FROM honor_boards h
    LEFT JOIN people p ON p.id=h.person_id WHERE h.kind=? AND h.date=? ORDER BY h.id`).all(kind, d);
  const people = db.prepare("SELECT id, name, category FROM people WHERE active=1 ORDER BY name").all();
  const sl = kind === 'distinguished' ? shortlist(20) : [];
  const m = c.req.query('m');

  return c.html(layout(K.title, `
    ${m ? `<div class="flash">${esc(m)}</div>` : ''}
    <div class="row" style="margin-bottom:8px">
      <a class="btn ${kind === 'quran' ? '' : 'ghost'} grow" href="/admin/honor?k=quran&d=${esc(d)}">📖 شرف القرآن</a>
      <a class="btn ${kind === 'distinguished' ? '' : 'ghost'} grow" href="/admin/honor?k=distinguished&d=${esc(d)}">🏅 المتميزون</a>
    </div>
    <div class="card" style="font-size:12.5px;color:var(--muted)">${esc(K.desc)}
      <form class="row" style="margin-top:8px"><input type="hidden" name="k" value="${kind}">
        <label style="margin:0">اليوم:</label><input type="date" name="d" value="${esc(d)}" onchange="this.form.submit()"></form></div>

    ${kind === 'distinguished' && sl.length ? `<details class="fold"><summary>
      <span class="ttl">🔢 المرشّحون بالأرقام (أعلى ٢٠)</span><span class="pill m">اضغط لإضافة أي اسم</span></summary>
      <div class="foldbody">
        <div style="font-size:11.5px;color:var(--muted);margin-bottom:8px">
          الدرجة = الانضباط ٤٥٪ + جاهزية سكنه ٢٠٪ + ترشيحات المشرفين ٢٥٪ + مبادرات مسجّلة ١٠٪ — كلها مرصودة من غيره</div>
        ${sl.map((r, i) => `<form method="post" action="/admin/honor/add" class="row" style="padding:5px 0;border-bottom:1px solid var(--line)">
          <input type="hidden" name="kind" value="distinguished"><input type="hidden" name="date" value="${esc(d)}">
          <input type="hidden" name="person_id" value="${r.id}">
          <span style="width:24px;color:var(--muted)">${i + 1}</span>
          <div class="grow" style="font-size:13.5px">${esc(r.name)} ${catPill(r.category)}
            <div style="font-size:10.5px;color:var(--muted)">حضور ${r.attendPct}٪ · ${r.noms} ترشيح · درجة ${r.score}</div></div>
          <input name="note" placeholder="سبب التميز" style="width:150px">
          <button class="btn sm">➕</button></form>`).join('')}
      </div></details>` : ''}

    <div class="card"><h3>➕ إضافة اسم للوحة</h3>
      <form method="post" action="/admin/honor/add">
        <input type="hidden" name="kind" value="${kind}"><input type="hidden" name="date" value="${esc(d)}">
        <label>الطالب</label>
        <select name="person_id"><option value="">— اختر من القائمة —</option>
          ${people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <label>أو اكتب الاسم يدوياً (إن لم يكن في القائمة)</label><input name="name" placeholder="الاسم">
        <label>${kind === 'quran' ? 'الإنجاز (اختياري)' : 'سبب التميز'}</label>
        <input name="note" placeholder="${kind === 'quran' ? 'مثال: أتمّ ختمة المراجعة' : 'مثال: بادر بخدمة إخوانه طوال اليوم'}">
        <button class="btn block" style="margin-top:10px">إضافة للوحة</button>
      </form></div>

    <div class="card"><h3>${K.icon} لوحة ${esc(d)} — ${current.length} اسم</h3>
      ${current.map((h, i) => `<div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)">
        <span style="width:26px">${['🥇', '🥈', '🥉'][i] || (i + 1)}</span>
        <div class="grow"><b>${esc(h.pname || h.name || '')}</b>
          ${h.note ? `<div style="font-size:11.5px;color:var(--muted)">${esc(h.note)}</div>` : ''}</div>
        <form method="post" action="/admin/honor/${h.id}/delete"><button class="btn sm ghost">🗑</button></form>
      </div>`).join('') || '<div style="color:var(--muted)">لم تُضف أسماء لهذا اليوم بعد</div>'}
      ${current.length ? `<form method="post" action="/admin/honor/clear" onsubmit="return confirm('مسح كل أسماء هذا اليوم؟')" style="margin-top:8px">
        <input type="hidden" name="kind" value="${kind}"><input type="hidden" name="date" value="${esc(d)}">
        <button class="btn sm ghost" style="color:#b22">مسح اللوحة</button></form>` : ''}
    </div>

    ${kind === 'distinguished' ? `<div class="card"><h3>📝 ترشيحات المشرفين</h3>
      ${(() => {
        const noms = db.prepare(`SELECT n.*, p.name AS pname, b.name AS bname FROM nominations n
          JOIN people p ON p.id=n.person_id JOIN people b ON b.id=n.by_id ORDER BY n.id DESC LIMIT 25`).all();
        return noms.length ? noms.map(n => `<div style="padding:6px 0;border-bottom:1px solid var(--line);font-size:13px">
          <b>${esc(n.pname)}</b> <span class="pill g">${esc(n.bname.split(' ')[0])}</span>
          <div style="color:var(--muted);font-size:12px">${esc(n.reason)}</div></div>`).join('')
          : '<div style="color:var(--muted);font-size:13px">لا ترشيحات بعد — المشرفون يرشّحون من شاشة «مهامي»</div>';
      })()}
    </div>` : ''}
  `, { user: u, active: '/admin', wide: true }));
});

honor.post('/add', async (c) => {
  const u = c.get('user');
  if (!isManager(u)) return deny(c);
  const b = await c.req.parseBody();
  const kind = b.kind === 'distinguished' ? 'distinguished' : 'quran';
  const pid = b.person_id ? Number(b.person_id) : null;
  const name = String(b.name || '').trim() || null;
  if (!pid && !name) return c.redirect(`/admin/honor?k=${kind}&d=${b.date}&m=` + encodeURIComponent('اختر طالباً أو اكتب اسماً'));
  db.prepare(`INSERT INTO honor_boards (kind, date, person_id, name, note, added_by, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(kind, String(b.date), pid, name, String(b.note || '').trim() || null, u.id, now());
  audit(u.id, 'honor_add', `${kind}: ${name || pid}`);
  return c.redirect(`/admin/honor?k=${kind}&d=${b.date}`);
});
honor.post('/:id/delete', (c) => {
  const u = c.get('user');
  if (!isManager(u)) return deny(c);
  const h = db.prepare('SELECT kind, date FROM honor_boards WHERE id=?').get(Number(c.req.param('id')));
  db.prepare('DELETE FROM honor_boards WHERE id=?').run(Number(c.req.param('id')));
  return c.redirect(`/admin/honor?k=${h?.kind || 'quran'}&d=${h?.date || today()}`);
});
honor.post('/clear', async (c) => {
  const u = c.get('user');
  if (!isManager(u)) return deny(c);
  const b = await c.req.parseBody();
  db.prepare('DELETE FROM honor_boards WHERE kind=? AND date=?').run(String(b.kind), String(b.date));
  audit(u.id, 'honor_clear', `${b.kind} ${b.date}`);
  return c.redirect(`/admin/honor?k=${b.kind}&d=${b.date}`);
});

module.exports = { honor, shortlist, KINDS };
