// لوحة التحكم الشاملة — كل عمليات الرحلة وإحصائياتها في شاشة واحدة
const { db, today, getSlots, slotLabel, getSetting } = require('./db');
const { layout, esc } = require('./views');

// تصنيف الجهاز من بصمة المتصفح
function deviceOf(ua) {
  const s = String(ua || '');
  if (/iPhone/i.test(s)) return 'آيفون';
  if (/iPad/i.test(s)) return 'آيباد';
  if (/Android/i.test(s)) return /Mobile/i.test(s) ? 'أندرويد' : 'تابلت أندرويد';
  if (/Macintosh|Mac OS/i.test(s)) return 'ماك';
  if (/Windows/i.test(s)) return 'ويندوز';
  if (!s) return 'غير معروف';
  return 'أخرى';
}
const DEVICE_ICON = { 'آيفون': '📱', 'آيباد': '📲', 'أندرويد': '🤖', 'تابلت أندرويد': '📲', 'ماك': '💻', 'ويندوز': '🖥️', 'أخرى': '❓', 'غير معروف': '❓' };

function stats() {
  const d = today();
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);

  // ===== الأشخاص =====
  const people = {
    total: q('SELECT COUNT(*) c FROM people WHERE active=1').c,
    byCat: all('SELECT category, COUNT(*) c FROM people WHERE active=1 GROUP BY category ORDER BY c DESC'),
    byRole: all('SELECT role, COUNT(*) c FROM people WHERE active=1 GROUP BY role'),
    noRoom: q("SELECT COUNT(*) c FROM people WHERE active=1 AND room_id IS NULL AND role='student'").c,
    noCircle: q(`SELECT COUNT(*) c FROM people WHERE active=1 AND role NOT IN ('admin','manager')
      AND id NOT IN (SELECT person_id FROM att_group_members)`).c,
    excluded: q('SELECT COUNT(*) c FROM people WHERE active=0').c,
    withPhoto: q("SELECT COUNT(*) c FROM people WHERE active=1 AND photo_status='approved'").c,
    pendingPhoto: q("SELECT COUNT(*) c FROM people WHERE active=1 AND photo_status='pending'").c,
  };

  // ===== الدخول والأجهزة =====
  const logins = all(`SELECT a.who, a.detail, a.ts, p.name FROM audit a LEFT JOIN people p ON p.id=a.who
    WHERE a.action IN ('login','login_new_device') ORDER BY a.id DESC`);
  const deviceCount = {}, seen = new Set();
  const uniqueLogins = [];
  for (const l of logins) {
    const ua = (l.detail || '').split('|')[1] || '';
    const dev = deviceOf(ua);
    if (l.who && !seen.has(l.who)) {
      seen.add(l.who);
      uniqueLogins.push({ id: l.who, name: l.name, device: dev, ts: l.ts });
      deviceCount[dev] = (deviceCount[dev] || 0) + 1;
    }
  }
  const devices = Object.entries(deviceCount).map(([name, n]) => ({ name, n, icon: DEVICE_ICON[name] || '❓' }))
    .sort((a, b) => b.n - a.n);
  const neverLoggedIn = all(`SELECT name, role FROM people WHERE active=1 AND id NOT IN
    (SELECT DISTINCT who FROM audit WHERE who IS NOT NULL AND action IN ('login','login_new_device')) ORDER BY name`);

  // ===== الحضور اليوم =====
  const slots = getSlots().filter(s => s.enabled);
  const attToday = slots.map(s => {
    const r = q(`SELECT
      SUM(status='present') p, SUM(status='late') l, SUM(status='absent') ab, COUNT(*) n
      FROM attendance WHERE date=? AND slot=?`, d, s.key);
    return { key: s.key, label: s.label, time: s.time, who: s.who, present: r.p || 0, late: r.l || 0, absent: r.ab || 0, total: r.n || 0 };
  });
  const presentNow = (() => {
    // آخر موعد مضى اليوم = الحالة الحالية للحضور
    const nowMin = (() => { const dt = new Date(Date.now() + 3 * 3600 * 1000); return dt.getUTCHours() * 60 + dt.getUTCMinutes(); })();
    const passed = slots.filter(s => { const [h, m] = s.time.split(':').map(Number); return h * 60 + m <= nowMin; });
    const last = passed.length ? passed[passed.length - 1] : null;
    if (!last) return null;
    const r = q(`SELECT SUM(status IN ('present','late')) p, COUNT(*) n FROM attendance WHERE date=? AND slot=?`, d, last.key);
    return { label: last.label, present: r.p || 0, marked: r.n || 0 };
  })();

  // ===== الغرف واللجان =====
  const rooms = all(`SELECT r.name, r.beds+r.extra_beds cap,
    (SELECT COUNT(*) FROM people p WHERE p.room_id=r.id AND p.active=1) occ,
    (SELECT stars FROM room_ratings rr WHERE rr.room_id=r.id AND rr.date=?) todayStars
    FROM rooms r ORDER BY r.name`, d);
  const ratedToday = rooms.filter(r => r.todayStars != null).length;
  // كل مهام اليوم بأسمائها — تُعرض أمام الإدارة دفعةً واحدة بلا دخول على كل لجنة
  const PER_DAY = new Set(['daily', 'alt', 'weekly', 'twice']);
  const dow = new Date(d + 'T00:00:00Z').getUTCDay();
  const tripStart = getSetting('trip_start', '2026-08-15');
  const altToday = (() => {
    const diff = Math.round((new Date(d + 'T00:00:00Z') - new Date(tripStart + 'T00:00:00Z')) / 86400000);
    return (((diff % 2) + 2) % 2) === 0;
  })();
  const dueNow = (t) => t.kind === 'alt' ? altToday
    : t.kind === 'weekly' ? dow === (t.weekday ?? 5)
    : t.kind === 'twice' ? (dow === (t.weekday ?? 0) || dow === (t.weekday2 ?? 3)) : true;
  const committees = all('SELECT id, name FROM committees ORDER BY name').map(cm => {
    const tasks = all(`SELECT t.*, (SELECT 1 FROM task_done td WHERE td.task_id=t.id AND td.date=?) done_today
      FROM committee_tasks t WHERE t.committee_id=? ORDER BY t.id`, d, cm.id)
      .filter(dueNow)
      .map(t => ({ title: t.title, isDone: PER_DAY.has(t.kind) ? !!t.done_today : !!t.done }));
    return { name: cm.name, total: tasks.length, done: tasks.filter(t => t.isDone).length, tasks };
  }).filter(cm => cm.total > 0);

  // ===== الباصات والطلبات والمال =====
  const stage = q('SELECT * FROM bus_stages WHERE active=1');
  const busNow = stage ? (() => {
    const r = q(`SELECT SUM(status='boarded') b, SUM(status='exempt') e FROM boardings WHERE stage_id=?`, stage.id);
    return { name: stage.name, boarded: r.b || 0, exempt: r.e || 0, total: people.total };
  })() : null;
  const requests = {
    new: q("SELECT COUNT(*) c FROM requests WHERE status='new'").c,
    processing: q("SELECT COUNT(*) c FROM requests WHERE status='processing'").c,
    done: q("SELECT COUNT(*) c FROM requests WHERE status='done'").c,
  };
  const money = q('SELECT COALESCE(SUM(amount_kwd),0) v, COUNT(*) n FROM expenses');
  // الدفتران منفصلان — والمجموع وحده يخفي أين ذهب المال
  const byLedger = all('SELECT ledger, COALESCE(SUM(amount_kwd),0) v FROM expenses GROUP BY ledger ORDER BY v DESC');
  const quiz = q('SELECT COUNT(*) n, SUM(correct) c FROM quiz_answers WHERE date=?', d);
  const topPoints = all(`SELECT p.name, SUM(pt.value) v FROM people p JOIN points pt ON pt.person_id=p.id
    WHERE p.active=1 GROUP BY p.id ORDER BY v DESC LIMIT 5`);
  const lastBackup = getSetting('last_backup');

  // ===== إحصائيات معمّقة =====
  // اتجاه الحضور آخر ٧ أيام
  const trend = all(`SELECT date,
    SUM(status='present') p, SUM(status='late') l, SUM(status='absent') ab, COUNT(*) n
    FROM attendance GROUP BY date ORDER BY date DESC LIMIT 7`).reverse();

  // الأكثر التزاماً والأكثر غياباً
  const commit = all(`SELECT p.name,
    SUM(a.status='present') pr, SUM(a.status='late') lt, SUM(a.status='absent') ab, COUNT(*) n
    FROM people p JOIN attendance a ON a.person_id=p.id WHERE p.active=1
    GROUP BY p.id HAVING n>0 ORDER BY (pr*1.0/n) DESC, n DESC`);
  const bestAttend = commit.slice(0, 5);
  const worstAttend = [...commit].reverse().filter(x => x.ab > 0).slice(0, 5);

  // النقاط حسب المصدر
  const pointsBySource = all(`SELECT source, SUM(value) v, COUNT(*) n FROM points GROUP BY source ORDER BY v DESC`);
  const SRC = { attendance: 'الحضور', cleanliness: 'جاهزية الغرف', behavior: 'السلوك', quiz: 'سؤال اليوم', other: 'يدوي' };
  pointsBySource.forEach(x => x.label = SRC[x.source] || x.source);
  const totalPoints = pointsBySource.reduce((a, b) => a + b.v, 0);

  // ترتيب الغرف
  const { roomsBoard } = require('./boards');
  const roomRank = roomsBoard().slice(0, 5);

  // المصروفات حسب المجموعة
  const expByGroup = all(`SELECT COALESCE(NULLIF(ec.parent,''), ec.name) g, SUM(e.amount_kwd) v
    FROM expenses e JOIN expense_cats ec ON ec.id=e.cat_id GROUP BY g ORDER BY v DESC LIMIT 6`);

  // نشاط المشرفين (من حضّر أكثر)
  const supervisorActivity = all(`SELECT p.name, COUNT(*) n FROM attendance a
    JOIN people p ON p.id=a.marked_by GROUP BY a.marked_by ORDER BY n DESC LIMIT 5`);

  // الغرف الأدنى جاهزية
  const weakRooms = all(`SELECT r.name, AVG(rr.stars) avg FROM rooms r
    JOIN room_ratings rr ON rr.room_id=r.id GROUP BY r.id ORDER BY avg ASC LIMIT 4`);

  const totalItems = q('SELECT COUNT(*) c FROM room_check_items WHERE active=1').c;

  return { d, people, devices, uniqueLogins, neverLoggedIn, attToday, presentNow, rooms, ratedToday, committees, busNow, requests, money, byLedger, quiz, topPoints, lastBackup,
    trend, bestAttend, worstAttend, pointsBySource, totalPoints, roomRank, expByGroup, supervisorActivity, weakRooms, totalItems };
}

function render(c, u) {
  const s = stats();
  const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
  const bar = (p, color) => `<div style="background:rgba(0,0,0,.06);border-radius:6px;height:8px;overflow:hidden;margin-top:4px">
    <div style="width:${Math.max(2, p)}%;height:100%;background:${color};border-radius:6px"></div></div>`;
  const card = (v, l, cls = '') => `<div class="stat ${cls}"><div class="v num">${v}</div><div class="l">${l}</div></div>`;

  return c.html(layout('📊 لوحة التحكم', `
    ${s.presentNow ? `<div class="card" style="background:linear-gradient(135deg,var(--green),#2d5f32);color:#fff;text-align:center;padding:18px">
      <div style="font-size:12.5px;opacity:.85">الحضور الآن — ${esc(s.presentNow.label)}</div>
      <div style="font-size:40px;font-weight:800" class="num">${s.presentNow.present}<span style="font-size:18px;opacity:.8"> / ${s.people.total}</span></div>
      <div style="font-size:12.5px;opacity:.9">${pct(s.presentNow.present, s.people.total)}٪ من الوفد · حُضِّر ${s.presentNow.marked}</div>
    </div>` : ''}

    <h2 class="sec">👥 الوفد</h2>
    <div class="grid2 g4">
      ${card(s.people.total, 'المشاركون')}
      ${card(s.people.byRole.filter(r => r.role !== 'student').reduce((a, b) => a + b.c, 0), 'المشرفون والإدارة')}
      ${card(s.people.noRoom, 'بدون سكن', s.people.noRoom ? 'warn' : '')}
      ${card(s.people.noCircle, 'بدون حلقة', s.people.noCircle ? 'warn' : '')}
    </div>
    <div class="card"><h3>التوزيع حسب الفئة</h3>
      ${s.people.byCat.map(x => `<div style="padding:5px 0">
        <div class="row"><div class="grow">${esc(x.category)}</div><b class="num">${x.c}</b>
          <span class="pill g num">${pct(x.c, s.people.total)}٪</span></div>
        ${bar(pct(x.c, s.people.total), 'var(--green)')}</div>`).join('')}
    </div>

    <h2 class="sec">📲 وصول التطبيق</h2>
    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <div class="grow"><b class="num" style="font-size:22px;color:var(--green)">${s.uniqueLogins.length}</b>
          <span style="color:var(--muted);font-size:13px"> استلموا التطبيق من أصل ${s.people.total}</span></div>
        <span class="pill ${s.neverLoggedIn.length ? 'o' : 'g'}">${s.neverLoggedIn.length} لم يفتحوه بعد</span>
      </div>
      ${bar(pct(s.uniqueLogins.length, s.people.total), 'var(--green)')}
      ${s.neverLoggedIn.length ? `<details class="fold" style="margin-top:10px;box-shadow:none;border:1px solid var(--line)">
        <summary><span class="ttl">⚠️ لم يفتحوا التطبيق بعد (${s.neverLoggedIn.length})</span></summary>
        <div class="foldbody" style="font-size:13px">
          ${s.neverLoggedIn.slice(0, 60).map(p => `<div style="padding:3px 0;border-bottom:1px solid var(--line)">${esc(p.name)}</div>`).join('')}
          ${s.neverLoggedIn.length > 60 ? `<div style="color:var(--muted);padding-top:6px">و${s.neverLoggedIn.length - 60} آخرين...</div>` : ''}
        </div></details>` : ''}
    </div>

    <h2 class="sec">✅ الحضور اليوم — ${esc(s.d)}</h2>
    <div class="card">
      ${s.attToday.map(a => `<div style="padding:8px 0;border-bottom:1px solid var(--line)">
        <div class="row"><div class="grow"><b>${esc(a.label)}</b> <span class="num" style="color:var(--muted);font-size:11.5px">${esc(a.time)}</span></div>
          ${a.total ? `<span class="pill g num">${a.present} حاضر</span>
            ${a.late ? `<span class="pill o num">${a.late} متأخر</span>` : ''}
            ${a.absent ? `<span class="pill r num">${a.absent} غائب</span>` : ''}`
      : '<span class="pill r">لم يُحضَّر</span>'}
        </div>
        ${a.total ? bar(pct(a.present + a.late, s.people.total), 'var(--green)') : ''}</div>`).join('')}
    </div>

    <h2 class="sec">🏠 السكن واللجان</h2>
    <div class="grid2 g4">
      ${card(s.rooms.length, 'الغرف')}
      ${card(s.ratedToday + '/' + s.rooms.length, 'قُيّمت اليوم', s.ratedToday < s.rooms.length ? 'warn' : '')}
      ${card(s.people.withPhoto, 'صور معتمدة')}
      ${card(s.people.pendingPhoto, 'صور تنتظر', s.people.pendingPhoto ? 'warn' : '')}
    </div>
    <div class="card"><h3>إنجاز اللجان اليوم</h3>
      <div class="row" style="margin-bottom:6px">
        <div class="grow" style="font-size:12px;color:var(--muted)">اضغط أي لجنة لترى مهامها — بلا مغادرة الصفحة</div>
        <button class="btn sm ghost" onclick="cmToggle(this)">افتح الكل</button></div>
      <div id="cmlist">
      ${s.committees.map(cm => `<details style="padding:5px 0;border-bottom:1px solid var(--line)">
        <summary style="list-style:none;cursor:pointer">
          <div class="row"><span style="color:var(--muted);font-size:15px">›</span>
            <div class="grow" style="font-size:13.5px">${esc(cm.name)}</div>
            <span class="pill ${cm.done >= cm.total ? 'g' : cm.done ? 'o' : 'r'} num">${cm.done}/${cm.total}</span></div>
          ${bar(pct(cm.done, cm.total), cm.done >= cm.total ? 'var(--green)' : 'var(--gold)')}</summary>
        <div style="padding:6px 14px 2px">
          ${cm.tasks.map(t => `<div class="row" style="padding:3px 0;font-size:12.5px">
            <span>${t.isDone ? '✅' : '⬜'}</span>
            <div class="grow" style="${t.isDone ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(t.title)}</div></div>`).join('')}
        </div></details>`).join('') || '<div style="color:var(--muted)">لا مهام</div>'}
      </div>
      <script>
      // «افتح الكل» — الإدارة ترى كل مهام اليوم دفعةً واحدة بضغطة واحدة
      function cmToggle(btn){
        const ds=[...document.querySelectorAll('#cmlist details')];
        const open=ds.some(x=>!x.open);
        ds.forEach(x=>x.open=open);
        btn.textContent=open?'اطوِ الكل':'افتح الكل';
      }
      <\/script>
    </div>

    ${s.busNow ? `<h2 class="sec">🚌 مرحلة جارية</h2>
    <div class="card" style="border:2px solid var(--gold)">
      <b>${esc(s.busNow.name)}</b>
      <div class="row" style="margin-top:8px">
        ${card(s.busNow.boarded, 'ركبوا')}
        ${card(s.busNow.total - s.busNow.boarded - s.busNow.exempt, 'المتبقّي', 'warn')}
        ${card(s.busNow.exempt, 'مستأذن')}
      </div>
      <a class="btn block sm" href="/bus" style="margin-top:8px">فتح لوحة المتابعة</a>
    </div>` : ''}

    <h2 class="sec">📥 الطلبات والمال</h2>
    <div class="grid2 g4">
      ${card(s.requests.new, 'طلبات جديدة', s.requests.new ? 'warn' : '')}
      ${card(s.requests.processing, 'قيد المعالجة')}
      ${card(s.requests.done, 'منجزة')}
      ${card(Number(s.money.v).toLocaleString('ar-KW', { maximumFractionDigits: 0 }), 'د.ك مصروفات')}
    </div>

    ${s.topPoints.length ? `<h2 class="sec">🏆 المتصدرون</h2>
    <div class="card">${s.topPoints.map((p, i) => `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line)">
      <span style="width:26px">${['🥇', '🥈', '🥉'][i] || (i + 1)}</span>
      <div class="grow">${esc(p.name)}</div><b class="num">${p.v}</b></div>`).join('')}</div>` : ''}

    ${s.trend.length > 1 ? `<h2 class="sec">📈 اتجاه الحضور — آخر ${s.trend.length} أيام</h2>
    <div class="card">
      <div style="display:flex;align-items:flex-end;gap:6px;height:110px;padding:6px 0">
        ${s.trend.map(t => { const h = Math.max(6, pct(t.p + t.l, Math.max(1, t.n)));
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
          <div class="num" style="font-size:10.5px;color:var(--muted)">${pct(t.p + t.l, Math.max(1, t.n))}٪</div>
          <div style="width:100%;background:rgba(0,0,0,.05);border-radius:5px;height:70px;display:flex;align-items:flex-end;overflow:hidden">
            <div style="width:100%;height:${h}%;background:linear-gradient(180deg,var(--green),#2d5f32);border-radius:5px"></div></div>
          <div class="num" style="font-size:9.5px;color:var(--muted)">${esc(t.date.slice(5))}</div></div>`; }).join('')}
      </div></div>` : ''}

    <h2 class="sec">🎯 مصادر النقاط</h2>
    <div class="card">
      <div style="text-align:center;margin-bottom:10px"><b class="num" style="font-size:26px;color:var(--maroon)">${s.totalPoints.toLocaleString('ar-KW')}</b>
        <span style="color:var(--muted);font-size:12.5px"> نقطة موزّعة</span></div>
      ${s.pointsBySource.map((x, i) => `<div style="padding:5px 0">
        <div class="row"><div class="grow">${esc(x.label)}</div><b class="num">${x.v}</b>
          <span class="pill ${i % 2 ? 'm' : 'g'} num">${pct(x.v, s.totalPoints)}٪</span></div>
        ${bar(pct(x.v, s.totalPoints), i % 2 ? 'var(--maroon)' : 'var(--green)')}</div>`).join('') || '<div style="color:var(--muted)">لا نقاط بعد</div>'}
    </div>

    <div class="grid2">
      ${s.bestAttend.length ? `<div class="card"><h3>⭐ الأكثر التزاماً</h3>
        ${s.bestAttend.map((p, i) => `<div class="row" style="padding:4px 0;border-bottom:1px solid var(--line);font-size:13px">
          <span style="width:22px">${['🥇', '🥈', '🥉'][i] || (i + 1)}</span><div class="grow">${esc(p.name.split(' ').slice(0, 2).join(' '))}</div>
          <span class="pill g num">${pct(p.pr, p.n)}٪</span></div>`).join('')}</div>` : ''}
      ${s.worstAttend.length ? `<div class="card"><h3>⚠️ الأكثر غياباً</h3>
        ${s.worstAttend.map(p => `<div class="row" style="padding:4px 0;border-bottom:1px solid var(--line);font-size:13px">
          <div class="grow">${esc(p.name.split(' ').slice(0, 2).join(' '))}</div>
          <span class="pill r num">${p.ab} غياب</span></div>`).join('')}</div>` : ''}
    </div>

    ${s.roomRank.length ? `<h2 class="sec">🏠 ترتيب الغرف</h2>
    <div class="card">
      ${s.roomRank.map((r, i) => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">
        <span style="width:26px">${['🥇', '🥈', '🥉'][i] || (i + 1)}</span>
        <div class="grow">${esc(r.name)}</div>
        <span class="pill g num">${r.avg_stars ? Number(r.avg_stars).toFixed(1) : '—'}/${s.totalItems}</span>
        <b class="num">${r.score}</b></div>`).join('')}
      ${s.weakRooms.length ? `<div style="margin-top:10px;font-size:12.5px;color:var(--muted)">
        الأدنى جاهزية: ${s.weakRooms.map(r => `<span class="pill o">${esc(r.name)} ${Number(r.avg).toFixed(1)}</span>`).join(' ')}</div>` : ''}
    </div>` : ''}

    ${s.byLedger.length ? `<h2 class="sec">💰 الدفتران</h2>
    <div class="card">
      ${s.byLedger.map(x => `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line)">
        <div class="grow">دفتر ${esc(x.ledger)}</div>
        <b class="num">${Number(x.v).toLocaleString('ar-KW', { maximumFractionDigits: 0 })} د.ك</b>
        <span class="pill ${x.ledger === 'مكة' ? 'm' : 'g'} num">${pct(x.v, s.money.v)}٪</span></div>`).join('')}
    </div>` : ''}

    ${s.expByGroup.length ? `<h2 class="sec">💰 المصروفات حسب المجموعة</h2>
    <div class="card">
      ${s.expByGroup.map((x, i) => `<div style="padding:5px 0">
        <div class="row"><div class="grow">${esc(x.g)}</div><b class="num">${Number(x.v).toLocaleString('ar-KW', { maximumFractionDigits: 0 })}</b>
          <span class="pill ${i % 2 ? 'g' : 'm'} num">${pct(x.v, s.money.v)}٪</span></div>
        ${bar(pct(x.v, s.money.v), i % 2 ? 'var(--green)' : 'var(--maroon)')}</div>`).join('')}
      <a href="/admin/money/report" style="font-size:12.5px">التقرير المالي الكامل ←</a>
    </div>` : ''}

    ${s.supervisorActivity.length ? `<h2 class="sec">👷 نشاط المشرفين</h2>
    <div class="card">
      ${s.supervisorActivity.map((p, i) => `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line);font-size:13.5px">
        <span style="width:24px">${i + 1}</span><div class="grow">${esc(p.name)}</div>
        <span class="pill m num">${p.n} تحضير</span></div>`).join('')}
    </div>` : ''}

    <div class="card" style="font-size:12px;color:var(--muted)">
      ${s.quiz.n ? `❓ سؤال اليوم: أجاب ${s.quiz.n}، منهم ${s.quiz.c || 0} صحيح (${pct(s.quiz.c || 0, s.quiz.n)}٪)<br>` : ''}
      👥 المستبعدون مؤقتاً: ${s.people.excluded}<br>
      💾 آخر نسخة احتياطية: ${s.lastBackup ? esc(new Date(s.lastBackup).toLocaleString('ar-KW')) : 'لم تُؤخذ بعد'}
    </div>
  `, { user: u, active: '/admin', wide: true }));
}

module.exports = { render, stats, deviceOf };
