// صفحة الصلاحيات — من يدخل أين، ولماذا. تُبنى من الإسناد الفعلي لا من الدور وحده.
const { Hono } = require('hono');
const { db, audit, now } = require('./db');
const { ROLE_NAMES, isAdmin, isManager, deny, circlesSupervisedBy, roomsSupervisedBy, committeesOf, canRateRooms } = require('./auth');
const { layout, esc, catPill, rolePill, shortName } = require('./views');

const perms = new Hono();

// ما الذي يفتحه هذا الشخص فعلاً؟ الدور + الإسناد معاً
function abilitiesOf(p) {
  const circles = circlesSupervisedBy(p.id);
  const rooms = roomsSupervisedBy(p);
  const coms = committeesOf(p.id);
  const heads = db.prepare(`SELECT c.name FROM committee_members m JOIN committees c ON c.id = m.committee_id
    WHERE m.person_id = ? AND m.is_head = 1`).all(p.id);
  const mgr = isManager(p);
  const list = [];
  const add = (icon, what, why, key) => list.push({ icon, what, why, key });

  add('👤', 'صفحته الشخصية', 'كل مشارك', 'me');
  add('🏆', 'لوحة الشرف والترتيب', 'كل مشارك', 'boards');
  add('✍️', 'كتابة فائدة وزيارة غرفة', 'كل مشارك', 'benefits');

  if (circles.length) add('📿', `تحضير ${circles.length} حلقة`, circles.map(x => x.name).join('، '), 'attendance');
  if (p.role === 'attendance_supervisor' && !circles.length) add('📿', 'تحضير الجميع', 'مشرف حضور بلا حلقة مسندة', 'attendance');
  if (rooms.length) add('🛏', `تحضير ${rooms.length} غرفة واعتماد زوّارها`, rooms.map(x => x.name).join('، '), 'roomcheck');
  if (coms.length) add('🤝', 'مهام لجانه', coms.map(x => x.name).join('، ') + (heads.length ? ` — رئيس ${heads.map(h => h.name).join('، ')}` : ''), 'committees');
  if (canRateRooms(p)) add('✅', 'جولة تقييم الغرف ومنح نقاط السلوك', mgr ? 'إداري' : 'عضو لجنة الجودة', 'rate');
  if (mgr) {
    add('⚙️', 'لوحة الإدارة كاملة', ROLE_NAMES[p.role], 'admin');
    add('📊', 'لوحة التحكم والإحصائيات', ROLE_NAMES[p.role], 'dashboard');
    add('💰', 'المصروفات والتقارير', ROLE_NAMES[p.role], 'money');
    add('🎖️', 'اعتماد الفوائد ولوحات الشرف', ROLE_NAMES[p.role], 'honor');
  }
  if (isAdmin(p)) add('🔒', 'التحليلات والأجهزة (خاص بالمؤسس)', 'المؤسس وحده', 'analytics');
  return { list, circles, rooms, coms, heads, mgr };
}

perms.get('/', (c) => {
  const u = c.get('user');
  if (!isAdmin(u)) return deny(c);   // خاص بك أنت
  const qv = (c.req.query('q') || '').trim();
  const only = c.req.query('only') || '';
  let people = db.prepare('SELECT * FROM people WHERE active = 1 ORDER BY name').all();
  people = people.map(p => ({ ...p, ab: abilitiesOf(p) }));
  if (only === 'sup') people = people.filter(p => p.ab.list.length > 3);
  if (only === 'mgr') people = people.filter(p => p.ab.mgr);
  const m = c.req.query('m');

  const counts = {
    all: db.prepare('SELECT COUNT(*) c FROM people WHERE active=1').get().c,
    mgr: db.prepare("SELECT COUNT(*) c FROM people WHERE active=1 AND role IN ('admin','manager')").get().c,
  };

  return c.html(layout('الصلاحيات', `
    ${m ? `<div class="flash">${esc(m)}</div>` : ''}
    <div class="card"><h3>🔑 من يفتح أين — ولماذا</h3>
      <div style="font-size:12.5px;color:var(--muted)">
        الصلاحية تُحسب من <b>الدور + الإسناد الفعلي</b> معاً. من يشرف على غرفة يفتح شاشتها ولو كان دوره «طالب».
        غيّر الدور من هنا مباشرة — يسري فوراً بلا إعادة تشغيل.</div>
      <div class="row" style="margin-top:8px">
        <a class="btn sm ${only === '' ? '' : 'ghost'} grow" href="/admin/perms">الكل (${counts.all})</a>
        <a class="btn sm ${only === 'sup' ? '' : 'ghost'} grow" href="/admin/perms?only=sup">من له مهام</a>
        <a class="btn sm ${only === 'mgr' ? '' : 'ghost'} grow" href="/admin/perms?only=mgr">الإداريون (${counts.mgr})</a>
      </div>
    </div>

    <div class="searchbox"><input data-filter="#permlist" placeholder="🔍 ابحث باسم أو صلاحية..." autocomplete="off"></div>
    <div id="permlist" data-rows>
    ${people.map(p => {
      const ab = p.ab;
      const tags = [
        ab.mgr ? '<span class="pill m">إداري</span>' : '',
        ab.rooms.length ? `<span class="pill b">مشرف سكن</span>` : '',
        ab.circles.length ? `<span class="pill g">مشرف حلقة</span>` : '',
        ab.heads.length ? `<span class="pill o">رئيس لجنة</span>` : '',
      ].filter(Boolean).join(' ');
      return `<details class="fold" data-search="${esc([p.name, ROLE_NAMES[p.role], ...ab.list.map(x => x.what + ' ' + x.why)].join(' '))}">
        <summary>
          <span class="ttl">${esc(shortName(p))}</span>
          ${rolePill(p.role)} ${tags}
          <span class="pill ${ab.list.length > 3 ? 'g' : 'm'}">${ab.list.length} صلاحية</span>
        </summary>
        <div class="foldbody">
          <div style="font-size:12px;color:var(--muted);margin-bottom:4px">${esc(p.name)}</div>
          ${ab.list.map(x => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">
            <span style="font-size:17px;width:24px">${x.icon}</span>
            <div class="grow"><div style="font-size:13.5px">${esc(x.what)}</div>
              <div style="font-size:11px;color:var(--muted)">${esc(x.why)}</div></div></div>`).join('')}

          <form method="post" action="/admin/perms/${p.id}/role" class="row" style="margin-top:10px;align-items:flex-end">
            <div class="grow"><label style="margin-top:0">الدور</label>
              ${p.role === 'admin'
                ? `<input value="${esc(ROLE_NAMES.admin)}" disabled title="لا يُعدَّل">`
                : `<select name="role">${Object.entries(ROLE_NAMES).filter(([k]) => k !== 'admin')
                    .map(([k, v]) => `<option value="${k}" ${k === p.role ? 'selected' : ''}>${v}</option>`).join('')}</select>`}</div>
            <div class="grow"><label style="margin-top:0">الفئة</label>
              <select name="category">${require('./db').getCategories().map(x => `<option ${x === p.category ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
            ${p.role === 'admin' ? '' : '<button class="btn sm">حفظ</button>'}
          </form>
          <a href="/admin/people/${p.id}" style="font-size:12px">↩ الملف الكامل (السكن واللجان والرابط)</a>
        </div></details>`;
    }).join('')}
    </div>
  `, { user: u, active: '/admin', wide: true }));
});

perms.post('/:id/role', async (c) => {
  const u = c.get('user');
  if (!isAdmin(u)) return deny(c);
  const id = Number(c.req.param('id'));
  const b = await c.req.parseBody();
  const p = db.prepare('SELECT name, role, category FROM people WHERE id = ?').get(id);
  if (!p || p.role === 'admin') return c.redirect('/admin/perms');
  const role = Object.keys(ROLE_NAMES).includes(String(b.role)) && b.role !== 'admin' ? String(b.role) : p.role;
  const cats = require('./db').getCategories();
  const cat = cats.includes(String(b.category)) ? String(b.category) : p.category;
  db.prepare('UPDATE people SET role = ?, category = ? WHERE id = ?').run(role, cat, id);
  audit(u.id, 'perm_change', `${p.name}: ${ROLE_NAMES[p.role]}→${ROLE_NAMES[role]} · ${p.category}→${cat}`);
  return c.redirect('/admin/perms?m=' + encodeURIComponent(`حُدّث ${p.name}: ${ROLE_NAMES[role]} · ${cat}`));
});

module.exports = { perms, abilitiesOf };
