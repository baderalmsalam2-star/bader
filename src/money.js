// المصروفات والتقرير المالي — تسجيل بضغطتين، وتقرير كامل بضغطة
const { Hono } = require('hono');
const XLSX = require('xlsx');
const { db, now, today, getSetting, setSetting, audit } = require('./db');
const { requireLevel, isAdmin } = require('./auth');
const { layout, esc } = require('./views');

const money = new Hono();
money.use('*', requireLevel('manager'));

const CUR = { KWD: 'د.ك', SAR: 'ر.س' };
const rate = () => Number(getSetting('sar_per_kwd', '12.2')) || 12.2; // كم ريالاً في الدينار
const toKwd = (amount, cur) => cur === 'SAR' ? amount / rate() : amount;
const fmt = (n) => Number(n || 0).toLocaleString('ar-KW', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fmt0 = (n) => Number(n || 0).toLocaleString('ar-KW', { maximumFractionDigits: 0 });
const back = (c, path, msg) => c.redirect(path + (msg ? `?m=${encodeURIComponent(msg)}` : ''));

// مجموعة البند للعرض (المجموعة الرئيسية أو اسم البند نفسه)
const groupOf = (r) => (r.parent || r.name).split(' — ')[0];

// ===== الدفتران واليوم المالي =====
// دفتران منفصلان لا يختلطان: ما أُنفق في المدينة يُقيَّد على المدينة، وما أُنفق
// في مكة على مكة. واسم الدفتر هو نفسه اسم المدينة في جدول أوقات الصلاة، فيُعرف
// منه فجرُ الدفتر مباشرة.
const LEDGERS = ['المدينة', 'مكة'];
const isLedger = (v) => LEDGERS.includes(v);
const curLedger = () => { const s = getSetting('current_city', 'المدينة'); return isLedger(s) ? s : 'المدينة'; };

const shiftDay = (date, n) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// الوقت الحالي بتوقيت السعودية (UTC+3) — تاريخاً وساعةً
function nowSA() {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) };
}

// فجر يومٍ في دفترٍ ما. إن لم تُجلب أوقات ذلك اليوم بعد رجعنا لوقت احتياطي
// معلوم — فالإقفال حكمٌ مالي لا يصحّ أن يتعطّل لانقطاع الإنترنت.
function fajrOf(date, ledger) {
  const r = db.prepare('SELECT fajr FROM prayer_times WHERE date = ? AND city = ?').get(date, ledger);
  return (r && r.fajr) || getSetting('fajr_fallback', '04:30');
}

// اليوم المالي الجاري: يبدأ بفجر اليوم وينتهي بفجر الغد. فما سُجّل بعد منتصف
// الليل وقبل الفجر يُقيَّد على يوم أمس — وهكذا يحسبها الوفد فعلاً، فسهرة الليلة
// من ليلتها لا من صباح الغد.
function tripDay(ledger) {
  const { date, hm } = nowSA();
  return hm < fajrOf(date, ledger) ? shiftDay(date, -1) : date;
}

// اليوم مقفل متى مضى يومُه المالي — والقاعدة زمنية، فلا إقفال يدوي ولا فتح يدوي
const isClosed = (date, ledger) => date < tripDay(ledger);

// ختم الأيام المستحقّة بلقطة إجماليها. الختم كسول يجري عند أول زيارة للمالية
// بعد الفجر، فلا يحتاج مؤقّتاً يعمل في الخلفية ولا يضيع إن أُعيد تشغيل الخادم.
function sealDueDays() {
  const ins = db.prepare(`INSERT OR IGNORE INTO money_day_close
    (date, ledger, closed_at, fajr, total_kwd, n) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const ledger of LEDGERS) {
    const cur = tripDay(ledger);
    const due = db.prepare(`SELECT e.date, COALESCE(SUM(e.amount_kwd),0) v, COUNT(*) n
      FROM expenses e WHERE e.ledger = ? AND e.date < ?
        AND NOT EXISTS (SELECT 1 FROM money_day_close d WHERE d.date = e.date AND d.ledger = e.ledger)
      GROUP BY e.date`).all(ledger, cur);
    for (const d of due) ins.run(d.date, ledger, now(), fajrOf(shiftDay(d.date, 1), ledger), d.v, d.n);
  }
}

// كل مسارات المالية تختم المستحقّ أولاً، فلا تُرى شاشة ولا يُقبل تعديل قبل الختم
money.use('*', async (c, next) => { sealDueDays(); await next(); });

const ledgerTotals = () => Object.fromEntries(LEDGERS.map(l =>
  [l, db.prepare('SELECT COALESCE(SUM(amount_kwd),0) v FROM expenses WHERE ledger = ?').get(l).v]));

// ===== شاشة التسجيل السريع =====
money.get('/', (c) => {
  const u = c.get('user');
  const m = c.req.query('m');
  const pick = c.req.query('ledger');
  const ledger = isLedger(pick) ? pick : curLedger();
  const day = tripDay(ledger);
  const closesAt = fajrOf(shiftDay(day, 1), ledger);
  const cats = db.prepare('SELECT * FROM expense_cats WHERE active=1 ORDER BY ord, id').all();
  const recent = db.prepare(`SELECT e.*, ec.name AS cat, ec.parent, p.name AS who
    FROM expenses e JOIN expense_cats ec ON ec.id = e.cat_id LEFT JOIN people p ON p.id = e.by_id
    WHERE e.ledger = ? ORDER BY e.id DESC LIMIT 12`).all(ledger);
  const tot = ledgerTotals();
  const grand = LEDGERS.reduce((s, l) => s + tot[l], 0);
  const dayTotal = db.prepare('SELECT COALESCE(SUM(amount_kwd),0) v FROM expenses WHERE ledger=? AND date=?').get(ledger, day).v;
  const sealed = db.prepare('SELECT * FROM money_day_close WHERE ledger = ? ORDER BY date DESC LIMIT 8').all(ledger);
  // تجميع الخيارات حسب المجموعة
  const groups = {};
  cats.forEach(x => { (groups[x.parent || 'بنود عامة'] = groups[x.parent || 'بنود عامة'] || []).push(x); });
  return c.html(layout('💰 المصروفات', `
    ${m ? `<div class="flash">${esc(m)}</div>` : ''}
    <div class="card" style="text-align:center;padding:16px">
      <div style="font-size:12px;color:var(--muted)">إجمالي مصروفات الرحلة — الدفتران معاً</div>
      <div style="font-size:32px;font-weight:800;color:var(--green)" class="num">${fmt(grand)} <span style="font-size:15px">د.ك</span></div>
      <a class="btn sm gold" href="/admin/money/report" style="margin-top:8px">📊 التقرير المالي الكامل</a>
    </div>
    <div class="grid2 g3">
      ${LEDGERS.map(l => `<a class="card" href="/admin/money?ledger=${encodeURIComponent(l)}"
        style="text-align:center;text-decoration:none;padding:12px;${l === ledger ? 'border:2px solid var(--green)' : ''}">
        <div style="font-size:12.5px;color:var(--muted)">دفتر ${esc(l)}</div>
        <div class="num" style="font-size:21px;font-weight:800;color:var(--ink)">${fmt(tot[l])}</div>
        <div style="font-size:10.5px;color:var(--muted)">د.ك</div></a>`).join('')}
    </div>
    <div class="card" style="border:2px solid var(--gold)"><h3>➕ تسجيل مصروف — دفتر ${esc(ledger)}</h3>
      <div style="font-size:12px;color:var(--muted);line-height:1.9;margin-bottom:8px">
        اليوم المالي الجاري: <b class="num" style="color:var(--ink)">${esc(day)}</b>
        — يُقفل نهائياً عند فجر الغد <b class="num">${esc(closesAt)}</b><br>
        المسجَّل عليه حتى الآن: <b class="num">${fmt(dayTotal)}</b> د.ك
      </div>
      <form method="post" action="/admin/money/add">
        <input type="hidden" name="ledger" value="${esc(ledger)}">
        <label>البند</label>
        <select name="cat_id" required style="font-size:15px">
          ${Object.entries(groups).map(([g, items]) => `<optgroup label="${esc(g)}">
            ${items.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</optgroup>`).join('')}
        </select>
        <div class="row" style="margin-top:8px">
          <div class="grow"><label>المبلغ</label>
            <input name="amount" type="number" step="0.001" inputmode="decimal" required autofocus style="font-size:20px;text-align:center"></div>
          <div style="width:130px"><label>العملة</label>
            <select name="currency" style="font-size:15px"><option value="KWD">دينار د.ك</option><option value="SAR">ريال ر.س</option></select></div>
        </div>
        <label>ملاحظة (اختياري)</label><input name="note" placeholder="مثال: فاتورة مطعم اليوم">
        <button class="btn block" style="margin-top:10px;font-size:16px;padding:14px">حفظ المصروف</button>
      </form></div>
    <div class="card"><h3>آخر ما سُجّل — دفتر ${esc(ledger)}</h3>
      ${recent.map(r => `<div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)">
        <div class="grow"><b>${esc(r.cat)}</b> ${r.parent ? `<span class="pill m">${esc(r.parent)}</span>` : ''}
          <div style="font-size:11px;color:var(--muted)">${esc(r.date)}${r.note ? ' — ' + esc(r.note) : ''}${r.who ? ' · ' + esc(r.who.split(' ')[0]) : ''}</div></div>
        <b class="num">${fmt0(r.amount)} ${CUR[r.currency]}</b>
        ${isClosed(r.date, r.ledger)
          ? '<span class="pill" title="يومه مقفل — لا يُحذف">🔒</span>'
          : `<form method="post" action="/admin/money/${r.id}/delete" onsubmit="return confirm('حذف هذا المصروف؟')"><button class="btn sm ghost">🗑</button></form>`}
      </div>`).join('') || '<div style="color:var(--muted)">لا مصروفات بعد في هذا الدفتر</div>'}
    </div>
    ${sealed.length ? `<div class="card"><h3>🔒 أيام مقفلة — دفتر ${esc(ledger)}</h3>
      <div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">أُقفلت بدخول فجر الغد، ولا تُفتح.</div>
      ${sealed.map(s => `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line)">
        <div class="grow"><b class="num" style="font-size:12.5px">${esc(s.date)}</b>
          <span style="font-size:10.5px;color:var(--muted)">أُقفل بفجر ${esc(s.fajr)} · ${s.n} عملية</span></div>
        <b class="num">${fmt(s.total_kwd)}</b></div>`).join('')}</div>` : ''}
    <div class="card"><h3>⚙️ إعدادات</h3>
      <form method="post" action="/admin/money/rate" class="row">
        <label class="grow" style="margin:0">سعر الصرف: ١ دينار =</label>
        <input name="rate" type="number" step="0.01" value="${rate()}" style="width:90px">
        <span>ريال</span><button class="btn sm">حفظ</button></form>
      <form method="post" action="/admin/money/fajr" class="row" style="margin-top:8px">
        <label class="grow" style="margin:0">فجر احتياطي (عند تعذّر الجلب)</label>
        <input name="fajr" type="time" value="${esc(getSetting('fajr_fallback', '04:30'))}" style="width:110px">
        <button class="btn sm">حفظ</button></form>
      <a class="btn sm ghost block" href="/admin/money/cats" style="margin-top:8px">📋 إدارة البنود (إضافة/حذف)</a>
    </div>
  `, { user: u, active: '/admin' }));
});

money.post('/add', async (c) => {
  const u = c.get('user');
  const b = await c.req.parseBody();
  const ledger = isLedger(b.ledger) ? b.ledger : curLedger();
  const to = `/admin/money?ledger=${encodeURIComponent(ledger)}`;
  const amount = Number(b.amount);
  const cur = b.currency === 'SAR' ? 'SAR' : 'KWD';
  if (!(amount > 0)) return back(c, to, 'أدخل مبلغاً صحيحاً');
  const cat = db.prepare('SELECT name FROM expense_cats WHERE id = ?').get(Number(b.cat_id));
  if (!cat) return back(c, to, 'بند غير معروف');
  // القيد يقع دائماً على اليوم المالي المفتوح — لا يُقيَّد شيء على يوم مختوم
  const date = tripDay(ledger);
  if (isClosed(date, ledger)) return back(c, to, '🔒 اليوم مقفل — لا يمكن التسجيل عليه');
  db.prepare(`INSERT INTO expenses (cat_id, amount, currency, amount_kwd, note, date, ledger, by_id, ts)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Number(b.cat_id), amount, cur, toKwd(amount, cur), String(b.note || '').trim() || null, date, ledger, u.id, now());
  audit(u.id, 'expense_add', `[${ledger} ${date}] ${cat.name}: ${amount} ${cur}`);
  return back(c, to, `✅ سُجّل ${amount} ${CUR[cur]} — ${cat.name} (دفتر ${ledger} · ${date})`);
});

money.post('/:id/delete', (c) => {
  const id = Number(c.req.param('id'));
  const row = db.prepare('SELECT date, ledger FROM expenses WHERE id = ?').get(id);
  if (!row) return back(c, '/admin/money', 'المصروف غير موجود');
  const to = `/admin/money?ledger=${encodeURIComponent(row.ledger)}`;
  // اليوم المختوم لا يُمسّ — لا حذفاً ولا تعديلاً
  if (isClosed(row.date, row.ledger)) return back(c, to, `🔒 يوم ${row.date} مقفل نهائياً — لا يُحذف منه شيء`);
  db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  audit(c.get('user').id, 'expense_delete', `#${id} [${row.ledger} ${row.date}]`);
  return back(c, to, 'حُذف المصروف');
});

money.post('/rate', async (c) => {
  const b = await c.req.parseBody();
  const r = Number(b.rate);
  if (r > 0) { setSetting('sar_per_kwd', String(r)); audit(c.get('user').id, 'rate_change', String(r)); }
  return back(c, '/admin/money', 'حُدّث سعر الصرف');
});

money.post('/fajr', async (c) => {
  const b = await c.req.parseBody();
  const t = String(b.fajr || '').trim();
  if (!/^\d{2}:\d{2}$/.test(t)) return back(c, '/admin/money', 'وقت غير صحيح');
  setSetting('fajr_fallback', t);
  audit(c.get('user').id, 'fajr_fallback', t);
  return back(c, '/admin/money', 'حُدّث الفجر الاحتياطي');
});

// ===== إدارة البنود =====
money.get('/cats', (c) => {
  const u = c.get('user');
  const cats = db.prepare('SELECT * FROM expense_cats ORDER BY ord, id').all();
  const used = {};
  db.prepare('SELECT cat_id, COUNT(*) n FROM expenses GROUP BY cat_id').all().forEach(r => used[r.cat_id] = r.n);
  return c.html(layout('بنود المصروفات', `
    <div class="card"><h3>➕ بند جديد</h3>
      <form method="post" action="/admin/money/cats/add" class="row">
        <input name="name" placeholder="اسم البند" required class="grow">
        <input name="parent" placeholder="المجموعة (اختياري)" style="width:150px">
        <button class="btn sm">إضافة</button></form></div>
    <div class="card">${cats.map(x => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">
      <div class="grow">${esc(x.name)} ${x.parent ? `<span class="pill m">${esc(x.parent)}</span>` : ''}
        ${used[x.id] ? `<span class="pill g">${used[x.id]} عملية</span>` : ''}</div>
      ${!used[x.id] ? `<form method="post" action="/admin/money/cats/${x.id}/delete"><button class="btn sm ghost">🗑</button></form>`
        : '<span style="font-size:11px;color:var(--muted)">مستخدم</span>'}
    </div>`).join('')}</div>
    <p style="text-align:center"><a href="/admin/money">← رجوع للمصروفات</a></p>
  `, { user: u, active: '/admin' }));
});
money.post('/cats/add', async (c) => {
  const b = await c.req.parseBody();
  const mx = db.prepare('SELECT COALESCE(MAX(ord),0) m FROM expense_cats').get().m;
  db.prepare('INSERT INTO expense_cats (name, parent, ord) VALUES (?, ?, ?)')
    .run(String(b.name).trim(), String(b.parent || '').trim(), mx + 1);
  audit(c.get('user').id, 'expense_cat_add', String(b.name));
  return back(c, '/admin/money/cats');
});
money.post('/cats/:id/delete', (c) => {
  const id = Number(c.req.param('id'));
  const n = db.prepare('SELECT COUNT(*) c FROM expenses WHERE cat_id = ?').get(id).c;
  if (!n) db.prepare('DELETE FROM expense_cats WHERE id = ?').run(id);
  return back(c, '/admin/money/cats');
});

// ===== التقرير المالي الكامل =====
// ledger = اسم دفتر، أو null لتقرير الدفترين معاً
function reportData(ledger) {
  const rows = db.prepare(`SELECT ec.name, ec.parent, COALESCE(SUM(e.amount_kwd),0) total, COUNT(e.id) n
    FROM expense_cats ec LEFT JOIN expenses e ON e.cat_id = ec.id AND (? IS NULL OR e.ledger = ?)
    GROUP BY ec.id HAVING n > 0 ORDER BY total DESC`).all(ledger, ledger);
  const grand = rows.reduce((s, r) => s + r.total, 0);
  // تجميع حسب المجموعة الرئيسية
  const gmap = {};
  rows.forEach(r => { const g = groupOf(r); gmap[g] = (gmap[g] || 0) + r.total; });
  const groups = Object.entries(gmap).map(([name, total]) => ({ name, total, pct: grand ? total / grand * 100 : 0 }))
    .sort((a, b) => b.total - a.total);
  rows.forEach(r => r.pct = grand ? r.total / grand * 100 : 0);
  return { rows, groups, grand };
}

money.get('/report', (c) => {
  const u = c.get('user');
  const pick = c.req.query('ledger');
  const ledger = isLedger(pick) ? pick : null;              // null = الدفتران معاً
  const { rows, groups, grand } = reportData(ledger);
  const days = db.prepare(`SELECT date, ledger, SUM(amount_kwd) t FROM expenses
    WHERE (? IS NULL OR ledger = ?) GROUP BY date, ledger ORDER BY date DESC, ledger LIMIT 14`).all(ledger, ledger);
  const tot = ledgerTotals();
  const bar = (pct, color) => `<div style="background:rgba(0,0,0,.06);border-radius:6px;height:9px;overflow:hidden;margin-top:4px">
    <div style="width:${Math.max(2, pct).toFixed(1)}%;height:100%;background:${color};border-radius:6px"></div></div>`;
  const colors = ['#3F7E44', '#7A3B5D', '#C79A3C', '#2563eb', '#b45309', '#0f766e', '#9333ea', '#be123c', '#525252'];
  const tab = (label, val) => `<a class="btn sm ${(val || null) === ledger ? '' : 'ghost'}"
    href="/admin/money/report${val ? `?ledger=${encodeURIComponent(val)}` : ''}">${esc(label)}</a>`;
  return c.html(layout('📊 التقرير المالي', `
    <div class="row" style="gap:6px;justify-content:center;margin-bottom:8px">
      ${tab('الدفتران معاً', '')}${LEDGERS.map(l => tab(`دفتر ${l}`, l)).join('')}
    </div>
    <div class="card" style="text-align:center;padding:20px;background:linear-gradient(135deg,var(--green),#2d5f32);color:#fff">
      <div style="font-size:12.5px;opacity:.85">${ledger ? `مصروفات دفتر ${esc(ledger)}` : 'إجمالي مصروفات الرحلة — الدفتران معاً'}</div>
      <div style="font-size:36px;font-weight:800" class="num">${fmt(grand)}</div>
      <div style="font-size:13px;opacity:.9">دينار كويتي · ما يعادل ${fmt0(grand * rate())} ريال</div>
    </div>
    ${!ledger ? `<div class="grid2 g3">${LEDGERS.map(l => `<div class="stat">
      <div class="v num">${fmt(tot[l])}</div><div class="l">دفتر ${esc(l)} (د.ك)</div></div>`).join('')}</div>` : ''}
    ${!grand ? '<div class="card">لا مصروفات مسجّلة بعد</div>' : `
    <h2 class="sec">حسب المجموعة</h2>
    <div class="card">${groups.map((g, i) => `<div style="padding:8px 0;border-bottom:1px solid var(--line)">
      <div class="row"><div class="grow"><b>${esc(g.name)}</b></div>
        <b class="num">${fmt(g.total)}</b><span class="pill g num">${g.pct.toFixed(1)}٪</span></div>
      ${bar(g.pct, colors[i % colors.length])}</div>`).join('')}</div>
    <h2 class="sec">تفصيل البنود</h2>
    <div class="card"><table>
      <tr><th>البند</th><th>المبلغ (د.ك)</th><th>النسبة</th><th>عمليات</th></tr>
      ${rows.map(r => `<tr><td>${esc(r.name)}${r.parent ? `<div style="font-size:10.5px;color:var(--muted)">${esc(r.parent)}</div>` : ''}</td>
        <td class="num"><b>${fmt(r.total)}</b></td><td class="num">${r.pct.toFixed(1)}٪</td><td class="num">${r.n}</td></tr>`).join('')}
      <tr style="background:rgba(63,126,68,.08)"><td><b>الإجمالي</b></td><td class="num"><b>${fmt(grand)}</b></td><td class="num"><b>١٠٠٪</b></td>
        <td class="num">${rows.reduce((s, r) => s + r.n, 0)}</td></tr>
    </table></div>
    <div class="card"><h3>💡 أبرز الأرقام</h3>
      <div style="font-size:13.5px;line-height:2">
        • أكثر بند استهلاكاً: <b>${esc(rows[0]?.name || '—')}</b> بـ <span class="num">${fmt(rows[0]?.total)}</span> د.ك (${rows[0]?.pct.toFixed(1)}٪)<br>
        • أكبر مجموعة: <b>${esc(groups[0]?.name || '—')}</b> (${groups[0]?.pct.toFixed(1)}٪ من الإجمالي)<br>
        • عدد العمليات المسجّلة: <b class="num">${rows.reduce((s, r) => s + r.n, 0)}</b><br>
        • متوسط العملية: <b class="num">${fmt(grand / Math.max(1, rows.reduce((s, r) => s + r.n, 0)))}</b> د.ك
      </div></div>
    ${days.length ? `<div class="card"><h3>الإنفاق اليومي</h3>
      <div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">🔒 = يوم أُقفل نهائياً بدخول فجر الغد</div>
      ${days.map(d => `<div class="row" style="padding:4px 0">
        <span class="num grow" style="font-size:12.5px">${esc(d.date)}
          ${!ledger ? `<span class="pill m">${esc(d.ledger)}</span>` : ''}
          ${isClosed(d.date, d.ledger) ? '🔒' : '<span class="pill g">مفتوح</span>'}</span>
        <b class="num">${fmt(d.t)}</b></div>`).join('')}</div>` : ''}
    `}
    <a class="btn block gold" href="/admin/money/report.xlsx${ledger ? `?ledger=${encodeURIComponent(ledger)}` : ''}"
       style="margin:10px 0">📤 تصدير التقرير إلى Excel</a>
    <p style="text-align:center"><a href="/admin/money">← رجوع</a></p>
  `, { user: u, active: '/admin' }));
});

// ===== تصدير التقرير =====
money.get('/report.xlsx', (c) => {
  const u = c.get('user');
  const pick = c.req.query('ledger');
  const ledger = isLedger(pick) ? pick : null;
  const { rows, groups, grand } = reportData(ledger);
  const tot = ledgerTotals();
  const wb = XLSX.utils.book_new();
  const add = (name, data) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), name.slice(0, 31));
  add('الملخص', [
    ...groups.map(g => ({ المجموعة: g.name, 'المبلغ (د.ك)': Number(g.total.toFixed(3)), 'النسبة٪': Number(g.pct.toFixed(1)) })),
    { المجموعة: 'الإجمالي', 'المبلغ (د.ك)': Number(grand.toFixed(3)), 'النسبة٪': 100 },
  ]);
  if (!ledger) add('الدفتران', [
    ...LEDGERS.map(l => ({ الدفتر: l, 'المبلغ (د.ك)': Number(tot[l].toFixed(3)) })),
    { الدفتر: 'المجموع', 'المبلغ (د.ك)': Number(LEDGERS.reduce((s, l) => s + tot[l], 0).toFixed(3)) },
  ]);
  add('تفصيل البنود', rows.map(r => ({
    البند: r.name, المجموعة: r.parent || '—', 'المبلغ (د.ك)': Number(r.total.toFixed(3)),
    'النسبة٪': Number(r.pct.toFixed(1)), عدد_العمليات: r.n,
  })));
  add('كل العمليات', db.prepare(`SELECT e.date, e.ledger, ec.name AS cat, ec.parent, e.amount, e.currency, e.amount_kwd, e.note, p.name AS who
    FROM expenses e JOIN expense_cats ec ON ec.id=e.cat_id LEFT JOIN people p ON p.id=e.by_id
    WHERE (? IS NULL OR e.ledger = ?) ORDER BY e.id DESC`).all(ledger, ledger)
    .map(x => ({
      التاريخ: x.date, الدفتر: x.ledger, الحالة: isClosed(x.date, x.ledger) ? 'مقفل' : 'مفتوح',
      البند: x.cat, المجموعة: x.parent || '—', المبلغ: x.amount,
      العملة: x.currency === 'SAR' ? 'ريال' : 'دينار', 'بالدينار': Number(x.amount_kwd.toFixed(3)),
      الملاحظة: x.note, سجّله: x.who,
    })));
  add('الأيام المقفلة', db.prepare(`SELECT * FROM money_day_close WHERE (? IS NULL OR ledger = ?)
    ORDER BY date DESC, ledger`).all(ledger, ledger)
    .map(x => ({
      التاريخ: x.date, الدفتر: x.ledger, 'أُقفل_بفجر': x.fajr, 'وقت_الختم': x.closed_at,
      'الإجمالي (د.ك)': Number(x.total_kwd.toFixed(3)), عدد_العمليات: x.n,
    })));
  audit(u.id, 'money_export', `${ledger ? `دفتر ${ledger}` : 'الدفتران'} — إجمالي ${grand.toFixed(3)} د.ك`);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  c.header('Content-Disposition', `attachment; filename="rihla-financial-report-${today()}.xlsx"`);
  return c.body(buf);
});

module.exports = money;
