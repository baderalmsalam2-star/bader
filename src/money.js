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

// ===== شاشة التسجيل السريع =====
money.get('/', (c) => {
  const u = c.get('user');
  const m = c.req.query('m');
  const cats = db.prepare('SELECT * FROM expense_cats WHERE active=1 ORDER BY ord, id').all();
  const recent = db.prepare(`SELECT e.*, ec.name AS cat, ec.parent, p.name AS who
    FROM expenses e JOIN expense_cats ec ON ec.id = e.cat_id LEFT JOIN people p ON p.id = e.by_id
    ORDER BY e.id DESC LIMIT 12`).all();
  const total = db.prepare('SELECT COALESCE(SUM(amount_kwd),0) v FROM expenses').get().v;
  // تجميع الخيارات حسب المجموعة
  const groups = {};
  cats.forEach(x => { (groups[x.parent || 'بنود عامة'] = groups[x.parent || 'بنود عامة'] || []).push(x); });
  return c.html(layout('💰 المصروفات', `
    ${m ? `<div class="flash">${esc(m)}</div>` : ''}
    <div class="card" style="text-align:center;padding:16px">
      <div style="font-size:12px;color:var(--muted)">إجمالي مصروفات الرحلة</div>
      <div style="font-size:32px;font-weight:800;color:var(--green)" class="num">${fmt(total)} <span style="font-size:15px">د.ك</span></div>
      <a class="btn sm gold" href="/admin/money/report" style="margin-top:8px">📊 التقرير المالي الكامل</a>
    </div>
    <div class="card" style="border:2px solid var(--gold)"><h3>➕ تسجيل مصروف</h3>
      <form method="post" action="/admin/money/add">
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
    <div class="card"><h3>آخر ما سُجّل</h3>
      ${recent.map(r => `<div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)">
        <div class="grow"><b>${esc(r.cat)}</b> ${r.parent ? `<span class="pill m">${esc(r.parent)}</span>` : ''}
          <div style="font-size:11px;color:var(--muted)">${esc(r.date)}${r.note ? ' — ' + esc(r.note) : ''}${r.who ? ' · ' + esc(r.who.split(' ')[0]) : ''}</div></div>
        <b class="num">${fmt0(r.amount)} ${CUR[r.currency]}</b>
        <form method="post" action="/admin/money/${r.id}/delete" onsubmit="return confirm('حذف هذا المصروف؟')"><button class="btn sm ghost">🗑</button></form>
      </div>`).join('') || '<div style="color:var(--muted)">لا مصروفات بعد</div>'}
    </div>
    <div class="card"><h3>⚙️ إعدادات</h3>
      <form method="post" action="/admin/money/rate" class="row">
        <label class="grow" style="margin:0">سعر الصرف: ١ دينار =</label>
        <input name="rate" type="number" step="0.01" value="${rate()}" style="width:90px">
        <span>ريال</span><button class="btn sm">حفظ</button></form>
      <a class="btn sm ghost block" href="/admin/money/cats" style="margin-top:8px">📋 إدارة البنود (إضافة/حذف)</a>
    </div>
  `, { user: u, active: '/admin' }));
});

money.post('/add', async (c) => {
  const u = c.get('user');
  const b = await c.req.parseBody();
  const amount = Number(b.amount);
  const cur = b.currency === 'SAR' ? 'SAR' : 'KWD';
  if (!(amount > 0)) return back(c, '/admin/money', 'أدخل مبلغاً صحيحاً');
  const cat = db.prepare('SELECT name FROM expense_cats WHERE id = ?').get(Number(b.cat_id));
  if (!cat) return back(c, '/admin/money', 'بند غير معروف');
  db.prepare(`INSERT INTO expenses (cat_id, amount, currency, amount_kwd, note, date, by_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Number(b.cat_id), amount, cur, toKwd(amount, cur), String(b.note || '').trim() || null, today(), u.id, now());
  audit(u.id, 'expense_add', `${cat.name}: ${amount} ${cur}`);
  return back(c, '/admin/money', `✅ سُجّل ${amount} ${CUR[cur]} — ${cat.name}`);
});

money.post('/:id/delete', (c) => {
  const id = Number(c.req.param('id'));
  db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  audit(c.get('user').id, 'expense_delete', `#${id}`);
  return back(c, '/admin/money', 'حُذف المصروف');
});

money.post('/rate', async (c) => {
  const b = await c.req.parseBody();
  const r = Number(b.rate);
  if (r > 0) { setSetting('sar_per_kwd', String(r)); audit(c.get('user').id, 'rate_change', String(r)); }
  return back(c, '/admin/money', 'حُدّث سعر الصرف');
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
function reportData() {
  const rows = db.prepare(`SELECT ec.name, ec.parent, COALESCE(SUM(e.amount_kwd),0) total, COUNT(e.id) n
    FROM expense_cats ec LEFT JOIN expenses e ON e.cat_id = ec.id
    GROUP BY ec.id HAVING n > 0 ORDER BY total DESC`).all();
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
  const { rows, groups, grand } = reportData();
  const days = db.prepare('SELECT date, SUM(amount_kwd) t FROM expenses GROUP BY date ORDER BY date DESC LIMIT 10').all();
  const bar = (pct, color) => `<div style="background:rgba(0,0,0,.06);border-radius:6px;height:9px;overflow:hidden;margin-top:4px">
    <div style="width:${Math.max(2, pct).toFixed(1)}%;height:100%;background:${color};border-radius:6px"></div></div>`;
  const colors = ['#3F7E44', '#7A3B5D', '#C79A3C', '#2563eb', '#b45309', '#0f766e', '#9333ea', '#be123c', '#525252'];
  return c.html(layout('📊 التقرير المالي', `
    <div class="card" style="text-align:center;padding:20px;background:linear-gradient(135deg,var(--green),#2d5f32);color:#fff">
      <div style="font-size:12.5px;opacity:.85">إجمالي مصروفات الرحلة</div>
      <div style="font-size:36px;font-weight:800" class="num">${fmt(grand)}</div>
      <div style="font-size:13px;opacity:.9">دينار كويتي · ما يعادل ${fmt0(grand * rate())} ريال</div>
    </div>
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
      ${days.map(d => `<div class="row" style="padding:4px 0"><span class="num grow" style="font-size:12.5px">${esc(d.date)}</span>
        <b class="num">${fmt(d.t)}</b></div>`).join('')}</div>` : ''}
    `}
    <a class="btn block gold" href="/admin/money/report.xlsx" style="margin:10px 0">📤 تصدير التقرير إلى Excel</a>
    <p style="text-align:center"><a href="/admin/money">← رجوع</a></p>
  `, { user: u, active: '/admin' }));
});

// ===== تصدير التقرير =====
money.get('/report.xlsx', (c) => {
  const u = c.get('user');
  const { rows, groups, grand } = reportData();
  const wb = XLSX.utils.book_new();
  const add = (name, data) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), name.slice(0, 31));
  add('الملخص', [
    ...groups.map(g => ({ المجموعة: g.name, 'المبلغ (د.ك)': Number(g.total.toFixed(3)), 'النسبة٪': Number(g.pct.toFixed(1)) })),
    { المجموعة: 'الإجمالي', 'المبلغ (د.ك)': Number(grand.toFixed(3)), 'النسبة٪': 100 },
  ]);
  add('تفصيل البنود', rows.map(r => ({
    البند: r.name, المجموعة: r.parent || '—', 'المبلغ (د.ك)': Number(r.total.toFixed(3)),
    'النسبة٪': Number(r.pct.toFixed(1)), عدد_العمليات: r.n,
  })));
  add('كل العمليات', db.prepare(`SELECT e.date, ec.name AS cat, ec.parent, e.amount, e.currency, e.amount_kwd, e.note, p.name AS who
    FROM expenses e JOIN expense_cats ec ON ec.id=e.cat_id LEFT JOIN people p ON p.id=e.by_id ORDER BY e.id DESC`).all()
    .map(x => ({
      التاريخ: x.date, البند: x.cat, المجموعة: x.parent || '—', المبلغ: x.amount,
      العملة: x.currency === 'SAR' ? 'ريال' : 'دينار', 'بالدينار': Number(x.amount_kwd.toFixed(3)),
      الملاحظة: x.note, سجّله: x.who,
    })));
  audit(u.id, 'money_export', `إجمالي ${grand.toFixed(3)} د.ك`);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  c.header('Content-Disposition', `attachment; filename="rihla-financial-report-${today()}.xlsx"`);
  return c.body(buf);
});

module.exports = money;
