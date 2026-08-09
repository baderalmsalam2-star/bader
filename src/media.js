// الإعلامية: منشور له رابط، وزر «تفاعلت» مقفل حتى يُفتح الرابط.
//
// القفل حكمٌ على الخادم لا زينة في المتصفح: الرابط لا يُعطى للمشارك مباشرة، بل
// يمرّ بمسار تحويل يسجّل الفتح ثم يحوّله. فمن لم يمرّ بالمسار لم يُسجَّل له فتح،
// ومن لم يُسجَّل له فتح تُردّ «تفاعلت» عنه ولو أرسلها بيده. وهكذا يكون رقم
// التفاعل الذي تراه الإعلامية رقماً صادقاً.
const { Hono } = require('hono');
const { db, now, today, audit } = require('./db');
const { requireLevel, deny } = require('./auth');
const { layout, esc, safeUrl } = require('./views');

const media = new Hono();        // للمشاركين — يُركَّب على /media
const adminMedia = new Hono();   // للإدارة — يُركَّب على /admin/media
adminMedia.use('*', requireLevel('manager'));

const back = (c, path, msg) => c.redirect(path + (msg ? `?m=${encodeURIComponent(msg)}` : ''));

const activePosts = () => db.prepare('SELECT * FROM media_posts WHERE active = 1 ORDER BY id DESC').all();
const engageOf = (postId, personId) =>
  db.prepare('SELECT * FROM media_engage WHERE post_id = ? AND person_id = ?').get(postId, personId) || null;

// بطاقة المنشور كما يراها المشارك — ثلاث حالات: لم يفتح / فتح ولم يتفاعل / تفاعل
function postCard(post, eng) {
  const opened = !!(eng && eng.opened_at);
  const acked = !!(eng && eng.acked_at);
  const pts = post.points ? `<span class="pill o">${post.points} نقاط</span>` : '';
  return `<div class="card" style="${acked ? '' : 'border:2px solid var(--gold)'}">
    <div class="row"><h3 class="grow" style="margin:0">📣 ${esc(post.title)}</h3>${pts}</div>
    ${post.note ? `<div style="font-size:13px;color:var(--muted);margin:6px 0">${esc(post.note)}</div>` : ''}
    <a class="btn block ${opened ? 'ghost' : ''}" href="/media/${post.id}/go" target="_blank" rel="noopener"
       style="margin-top:8px">${opened ? '↗ افتح الرابط مرة أخرى' : '↗ افتح الرابط'}</a>
    ${acked
      ? `<div class="flash" style="margin-top:8px">✅ شكراً — سُجّل تفاعلك${post.points ? ` وحصلت على ${post.points} نقاط` : ''}</div>`
      : opened
        ? `<form method="post" action="/media/${post.id}/ack">
             <button class="btn block" style="margin-top:8px">👍 تفاعلت</button></form>`
        : `<button class="btn block ghost" disabled style="margin-top:8px;opacity:.55">🔒 تفاعلت</button>
           <div style="font-size:11.5px;color:var(--muted);text-align:center;margin-top:4px">
             افتح الرابط أولاً — ثم يُفتح لك الزر</div>`}
  </div>`;
}

// ===== صفحة المشارك =====
media.get('/', (c) => {
  const u = c.get('user');
  if (!u) return c.redirect('/');
  const m = c.req.query('m');
  const posts = activePosts();
  return c.html(layout('📣 الإعلامية', `
    ${m ? `<div class="flash">${esc(m)}</div>` : ''}
    <div class="card" style="text-align:center;padding:14px">
      <div style="font-size:30px">📣</div><h3 style="margin:4px 0">الإعلامية</h3>
      <div style="font-size:12.5px;color:var(--muted)">افتح الرابط، ثم سجّل تفاعلك — تفاعلك يرفع الرحلة</div>
    </div>
    ${posts.length ? posts.map(p => postCard(p, engageOf(p.id, u.id))).join('')
      : '<div class="card" style="text-align:center;color:var(--muted)">لا منشورات حالياً</div>'}
    <p style="text-align:center"><a href="/me">← صفحتي</a></p>
  `, { user: u, active: '/me' }));
});

// بوابة الفتح: تسجّل الفتح ثم تحوّل للرابط. أول فتح هو المحفوظ — فإعادة الفتح
// لا تزحزح الوقت المسجَّل.
media.get('/:id/go', (c) => {
  const u = c.get('user');
  if (!u) return deny(c);
  const post = db.prepare('SELECT * FROM media_posts WHERE id = ? AND active = 1').get(Number(c.req.param('id')));
  if (!post) return back(c, '/media', 'المنشور غير متاح');
  const url = safeUrl(post.url);
  if (!url) return back(c, '/media', 'رابط هذا المنشور غير صالح — أبلغ الإدارة');
  db.prepare(`INSERT INTO media_engage (post_id, person_id, opened_at) VALUES (?, ?, ?)
    ON CONFLICT(post_id, person_id) DO UPDATE SET opened_at = COALESCE(media_engage.opened_at, excluded.opened_at)`)
    .run(post.id, u.id, now());
  return c.redirect(url);
});

// «تفاعلت» — تُردّ عمّن لم يُسجَّل له فتح، ولو أرسل الطلب بيده
media.post('/:id/ack', (c) => {
  const u = c.get('user');
  if (!u) return deny(c);
  const post = db.prepare('SELECT * FROM media_posts WHERE id = ? AND active = 1').get(Number(c.req.param('id')));
  if (!post) return back(c, '/media', 'المنشور غير متاح');
  const eng = engageOf(post.id, u.id);
  if (!eng || !eng.opened_at) return back(c, '/media', '🔒 افتح الرابط أولاً ثم سجّل تفاعلك');
  if (eng.acked_at) return back(c, '/media', 'تفاعلك مسجَّل مسبقاً');
  db.prepare('UPDATE media_engage SET acked_at = ? WHERE post_id = ? AND person_id = ?').run(now(), post.id, u.id);
  if (post.points) {
    db.prepare(`INSERT INTO points (person_id, source, value, note, date, added_by, ts)
                VALUES (?, 'media', ?, ?, ?, NULL, ?)`)
      .run(u.id, post.points, `الإعلامية: ${post.title}`.slice(0, 120), today(), now());
  }
  audit(u.id, 'media_ack', `#${post.id} ${post.title}`);
  return back(c, '/media', `✅ سُجّل تفاعلك${post.points ? ` — +${post.points} نقاط` : ''}`);
});

// ===== لوحة الإدارة =====
function counts(postId) {
  const r = db.prepare(`SELECT
      SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) opened,
      SUM(CASE WHEN acked_at  IS NOT NULL THEN 1 ELSE 0 END) acked
    FROM media_engage WHERE post_id = ?`).get(postId);
  return { opened: r.opened || 0, acked: r.acked || 0 };
}

adminMedia.get('/', (c) => {
  const u = c.get('user');
  const m = c.req.query('m');
  const posts = db.prepare('SELECT * FROM media_posts ORDER BY id DESC').all();
  const total = db.prepare('SELECT COUNT(*) c FROM people WHERE active = 1').get().c;
  const pct = (n) => total ? Math.round(n / total * 100) : 0;
  return c.html(layout('📣 الإعلامية', `
    ${m ? `<div class="flash">${esc(m)}</div>` : ''}
    <div class="card" style="border:2px solid var(--gold)"><h3>➕ منشور جديد</h3>
      <form method="post" action="/admin/media/add">
        <label>العنوان</label><input name="title" required maxlength="120" placeholder="مثال: تغطية اليوم الأول">
        <label>الرابط</label><input name="url" type="url" required inputmode="url" placeholder="https://...">
        <label>ملاحظة (اختياري)</label><input name="note" maxlength="200" placeholder="مثال: أعجب بالمنشور وأعد نشره">
        <label>نقاط التفاعل</label><input name="points" type="number" min="0" max="50" value="0" style="width:100px">
        <button class="btn block" style="margin-top:10px">نشر</button></form></div>
    <div style="font-size:12px;color:var(--muted);text-align:center;margin:6px 0">
      «فتح» = مرّ بالرابط فعلاً · «تفاعل» = ضغط الزر بعد الفتح — من ${total} مشاركاً
    </div>
    ${posts.map(p => {
      const { opened, acked } = counts(p.id);
      const bad = !safeUrl(p.url);
      return `<div class="card" style="${p.active ? '' : 'opacity:.6'}">
        <div class="row"><b class="grow">${esc(p.title)}</b>
          ${p.points ? `<span class="pill o">${p.points} نقاط</span>` : ''}
          <span class="pill ${p.active ? 'g' : 'r'}">${p.active ? 'منشور' : 'موقوف'}</span></div>
        <div style="font-size:11.5px;color:var(--muted);word-break:break-all;margin:4px 0">${esc(p.url)}
          ${bad ? '<span class="pill r">رابط غير صالح</span>' : ''}</div>
        ${p.note ? `<div style="font-size:12.5px">${esc(p.note)}</div>` : ''}
        <div class="grid2 g3" style="margin-top:6px">
          <div class="stat"><div class="v num">${opened}</div><div class="l">فتحوا الرابط (${pct(opened)}٪)</div></div>
          <div class="stat"><div class="v num">${acked}</div><div class="l">سجّلوا تفاعلهم (${pct(acked)}٪)</div></div>
        </div>
        <div class="row" style="margin-top:8px;gap:6px">
          <a class="btn sm ghost grow" href="/admin/media/${p.id}">👥 من تفاعل</a>
          <form method="post" action="/admin/media/${p.id}/toggle"><button class="btn sm ghost">${p.active ? '⏸ إيقاف' : '▶ نشر'}</button></form>
          <form method="post" action="/admin/media/${p.id}/delete" onsubmit="return confirm('حذف المنشور وكل تفاعلاته؟')">
            <button class="btn sm ghost">🗑</button></form>
        </div></div>`;
    }).join('') || '<div class="card" style="text-align:center;color:var(--muted)">لا منشورات بعد</div>'}
    <p style="text-align:center"><a href="/admin">← لوحة الإدارة</a></p>
  `, { user: u, active: '/admin' }));
});

adminMedia.post('/add', async (c) => {
  const u = c.get('user');
  const b = await c.req.parseBody();
  const title = String(b.title || '').trim();
  const url = safeUrl(b.url);
  if (!title) return back(c, '/admin/media', 'اكتب عنواناً');
  if (!url) return back(c, '/admin/media', 'الرابط غير صالح — يجب أن يبدأ بـ http أو https');
  const points = Math.max(0, Math.min(50, Number(b.points) || 0));
  db.prepare(`INSERT INTO media_posts (title, url, note, points, date, created_by, ts)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(title, url, String(b.note || '').trim() || null, points, today(), u.id, now());
  audit(u.id, 'media_add', title);
  return back(c, '/admin/media', '✅ نُشر');
});

adminMedia.post('/:id/toggle', (c) => {
  const id = Number(c.req.param('id'));
  db.prepare('UPDATE media_posts SET active = 1 - active WHERE id = ?').run(id);
  audit(c.get('user').id, 'media_toggle', `#${id}`);
  return back(c, '/admin/media');
});

adminMedia.post('/:id/delete', (c) => {
  const id = Number(c.req.param('id'));
  db.prepare('DELETE FROM media_posts WHERE id = ?').run(id);
  audit(c.get('user').id, 'media_delete', `#${id}`);
  return back(c, '/admin/media', 'حُذف المنشور');
});

// من فتح ومن تفاعل — بالأسماء، ومن لم يفتح أصلاً
adminMedia.get('/:id', (c) => {
  const u = c.get('user');
  const post = db.prepare('SELECT * FROM media_posts WHERE id = ?').get(Number(c.req.param('id')));
  if (!post) return back(c, '/admin/media', 'المنشور غير موجود');
  const rows = db.prepare(`SELECT p.id, p.name, p.category, e.opened_at, e.acked_at
    FROM people p LEFT JOIN media_engage e ON e.person_id = p.id AND e.post_id = ?
    WHERE p.active = 1 ORDER BY (e.acked_at IS NULL), (e.opened_at IS NULL), p.name`).all(post.id);
  const t = (s) => s ? esc(String(s).slice(11, 16)) : '';
  return c.html(layout(`📣 ${post.title}`, `
    <div class="card"><h3>${esc(post.title)}</h3>
      <div style="font-size:11.5px;color:var(--muted);word-break:break-all">${esc(post.url)}</div></div>
    <div class="card"><table>
      <tr><th>المشارك</th><th>فتح</th><th>تفاعل</th></tr>
      ${rows.map(r => `<tr><td>${esc(r.name)}</td>
        <td>${r.opened_at ? `<span class="pill g">✓ ${t(r.opened_at)}</span>` : '<span class="pill r">—</span>'}</td>
        <td>${r.acked_at ? `<span class="pill g">✓ ${t(r.acked_at)}</span>` : '<span class="pill r">—</span>'}</td></tr>`).join('')}
    </table></div>
    <p style="text-align:center"><a href="/admin/media">← الإعلامية</a></p>
  `, { user: u, active: '/admin' }));
});

module.exports = { media, adminMedia, activePosts, engageOf, postCard };
