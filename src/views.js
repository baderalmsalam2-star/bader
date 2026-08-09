// القالب العام والمكوّنات المشتركة — موبايل أولاً، RTL، ألوان الشعار
const { ROLE_NAMES, isManager, isSupervisor, committeesOf, circlesSupervisedBy, roomsSupervisedBy, canRateRooms } = require('./auth');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// الاسم المختصر في القوائم: الأول + الأخير — الأسماء الخماسية تكسر السطر على الجوال.
// وإن تشابه مختصران أُضيف اسم الأب للتمييز، فلا يختلط طالبان أبداً.
let _shortMap = null;
const _two = (nm) => { const w = String(nm ?? '').trim().split(/\s+/); return w.length <= 2 ? String(nm ?? '') : w[0] + ' ' + w[w.length - 1]; };
function buildShortNames(rows) {
  _shortMap = new Map();
  const cnt = new Map();
  for (const r of rows) { const s = _two(r.name); cnt.set(s, (cnt.get(s) || 0) + 1); }
  for (const r of rows) {
    const w = String(r.name).trim().split(/\s+/);
    let s = _two(r.name);
    if (cnt.get(s) > 1 && w.length > 2) s = w[0] + ' ' + w[1] + ' ' + w[w.length - 1];
    _shortMap.set(r.id, s);
  }
}
function shortName(p) {
  if (!p) return '';
  if (typeof p === 'string') return _two(p);
  return (_shortMap && _shortMap.get(p.id)) || _two(p.name);
}

const CSS = `
:root{--green:#3F7E44;--maroon:#7A3B5D;--gold:#C79A3C;--bg:#f6f4ee;--card:#fff;--ink:#1a1a1a;--muted:rgba(0,0,0,.55);--line:rgba(0,0,0,.08)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--ink);font-family:'IBM Plex Sans Arabic','Segoe UI',system-ui,sans-serif;font-size:15px;line-height:1.6;
  /* زخرفة هندسية خفيفة مستوحاة من سجاد الحرم — الأخضر والعنابي بالتساوي */
  background-image:
    repeating-linear-gradient(60deg,rgba(63,126,68,.035) 0 1px,transparent 1px 28px),
    repeating-linear-gradient(-60deg,rgba(122,59,93,.035) 0 1px,transparent 1px 28px);
  background-attachment:fixed}
a{color:var(--green);text-decoration:none}
.wrap{max-width:640px;margin:0 auto;padding:14px 14px 90px}
.wide .wrap{max-width:1080px}
/* الترويسة: أخضر الشعار خالصاً + شريط عنابي أسفلها (توازن نظيف بلا تدرّج باهت) */
header.top{background:var(--green);color:#fff;padding:12px 16px;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:20;
  box-shadow:0 2px 10px rgba(0,0,0,.12)}
header.top::after{content:'';position:absolute;bottom:0;right:0;left:0;height:3px;background:var(--maroon)}
header.top .t{font-weight:700;font-size:15px;flex:1}
header.top .hlogo{height:30px;width:auto;flex:none;border-radius:5px;background:rgba(255,255,255,.92);padding:2px 4px}
.brandlogo{display:block;max-width:180px;max-height:88px;width:auto;margin:0 auto}
header.top a{color:#fff;opacity:.9;font-size:13px}
.card{background:var(--card);border-radius:14px;padding:14px 16px;margin:10px 0;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.card h3{margin:0 0 8px;font-size:14.5px;color:var(--maroon)}
/* عناوين الأقسام عنابية مع خط أخضر — توازن اللونين */
h2.sec{font-size:16px;margin:18px 4px 8px;color:var(--maroon);border-bottom:2px solid rgba(63,126,68,.22);padding-bottom:5px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.btn{display:inline-block;background:var(--green);color:#fff;border:none;border-radius:11px;padding:11px 18px;font:600 14px 'IBM Plex Sans Arabic',sans-serif;cursor:pointer;text-align:center}
.btn.sec{background:var(--maroon)} .btn.gold{background:var(--gold)} .btn.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
.btn.sm{padding:7px 12px;font-size:13px;border-radius:9px}
.btn.block{display:block;width:100%}
.btn:disabled{opacity:.45}
input,select,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:#fff}
label{font-size:12.5px;color:var(--muted);display:block;margin:10px 0 4px}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:11.5px;font-weight:600}
.pill.g{background:rgba(63,126,68,.12);color:var(--green)} .pill.m{background:rgba(122,59,93,.12);color:var(--maroon)}
.pill.o{background:rgba(199,154,60,.16);color:#8a6516} .pill.r{background:rgba(200,40,40,.1);color:#b22}
.pill.b{background:rgba(37,99,235,.12);color:#1d4ed8;border:1px solid rgba(37,99,235,.25)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:right;color:var(--muted);font-weight:600;font-size:12px;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:8px;border-bottom:1px solid var(--line)}
.num{font-variant-numeric:tabular-nums}
.stat{background:var(--card);border-radius:14px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.stat .v{font-size:24px;font-weight:700;color:var(--green)} .stat .l{font-size:11.5px;color:var(--muted)}
.stat.warn .v{color:#b22}
nav.bottom{position:fixed;bottom:0;right:0;left:0;background:#fff;border-top:1px solid var(--line);display:flex;z-index:30;padding-bottom:env(safe-area-inset-bottom)}
nav.bottom a{flex:1;text-align:center;padding:9px 2px 7px;font-size:10.5px;color:var(--muted);display:flex;flex-direction:column;gap:2px;align-items:center}
nav.bottom{border-top:3px solid var(--maroon)}
nav.bottom a.on{color:var(--green);font-weight:700}
nav.bottom .ic{font-size:19px;line-height:1}
.row{display:flex;align-items:center;gap:10px}
.row .grow{flex:1}
.person-tap{display:flex;align-items:center;gap:10px;padding:11px 12px;background:#fff;border-radius:12px;margin:6px 0;border:2px solid transparent;cursor:pointer;user-select:none}
.person-tap.present{border-color:var(--green);background:rgba(63,126,68,.07)}
.person-tap.absent{border-color:#c33;background:rgba(200,40,40,.06)}
.person-tap .st{font-size:18px;width:26px;text-align:center}
/* صف التحضير: زر حاضر وزر غائب — ضغطة واحدة لكل حالة، بلا دورات */
.prow{display:flex;align-items:center;gap:9px;padding:8px 10px;background:#fff;border-radius:12px;margin:6px 0;border:2px solid transparent}
.prow.present{border-color:var(--green);background:rgba(63,126,68,.06)}
.prow.absent{border-color:#c33;background:rgba(200,40,40,.05)}
.prow.late{border-color:var(--gold);background:rgba(199,154,60,.09)}
.prow .nm{flex:1;min-width:0;font-weight:600;font-size:13.5px;line-height:1.35}
.mk{flex:none;width:44px;height:44px;border-radius:11px;border:1.5px solid var(--line);background:#fff;font-size:19px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.4;padding:0}
.mk.on{opacity:1;border-width:2px}
.mk.yes.on{background:var(--green);border-color:var(--green);color:#fff}
.mk.no.on{background:#c33;border-color:#c33;color:#fff}
.mk.late.on{background:var(--gold);border-color:var(--gold);color:#fff}
.msgbar{background:linear-gradient(135deg,var(--maroon),#5d2c47);color:#fff;border-radius:14px;padding:16px;margin:10px 0}
.msgbar .d{font-size:11px;opacity:.75}
.flash{background:rgba(63,126,68,.1);border:1px solid rgba(63,126,68,.3);color:var(--green);border-radius:10px;padding:10px 14px;margin:10px 0;font-size:13.5px}
.qrbox{text-align:center;padding:10px}
.qrbox img{width:180px;height:180px;border-radius:10px;border:1px solid var(--line)}
.stars{direction:ltr;display:inline-flex;gap:4px;font-size:26px;cursor:pointer;user-select:none}
.stars span{color:#ccc} .stars span.on{color:var(--gold)}
.searchbox{position:sticky;top:52px;z-index:15;background:var(--bg);padding:6px 0}
/* بطاقة قابلة للطي: العنوان ظاهر والتفاصيل تُفتح بالسهم */
details.fold{background:var(--card);border-radius:14px;margin:9px 0;box-shadow:0 1px 3px rgba(0,0,0,.06);overflow:hidden}
details.fold>summary{list-style:none;cursor:pointer;padding:13px 15px;display:flex;align-items:center;gap:9px;flex-wrap:wrap;user-select:none}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary::after{content:'⌄';margin-inline-start:auto;font-size:22px;line-height:1;color:var(--muted);transition:transform .2s;flex:none}
details.fold[open]>summary::after{transform:rotate(180deg)}
details.fold[open]>summary{border-bottom:1px solid var(--line)}
details.fold>summary:hover{background:rgba(63,126,68,.04)}
details.fold .foldbody{padding:12px 15px 14px}
details.fold .ttl{font-weight:700;font-size:14.5px;color:var(--maroon)}
/* زر القفز فوق/تحت — يظهر تلقائياً في القوائم الطويلة */
#jump{position:fixed;bottom:96px;left:14px;z-index:28;width:46px;height:46px;border-radius:50%;border:none;
  background:var(--maroon);color:#fff;font-size:20px;box-shadow:0 4px 14px rgba(0,0,0,.28);cursor:pointer;display:none;
  align-items:center;justify-content:center;padding:0}
@media(min-width:700px){#jump{bottom:26px;left:26px}}
.avat{width:34px;height:34px;border-radius:50%;object-fit:cover;flex:none;border:1px solid var(--line);background:#eee}
.avat.lg{width:96px;height:96px;border-width:2px}
.bk{color:#fff;font-size:20px;line-height:1;padding:2px 6px;opacity:.9;cursor:pointer}
/* فهرس الأحرف السريع (مثل جهات اتصال الآيفون) */
#alphaidx{position:fixed;right:0;top:130px;bottom:95px;width:26px;z-index:25;display:flex;flex-direction:column;justify-content:center;align-items:center;user-select:none;touch-action:none}
#alphaidx span{font-size:10.5px;font-weight:700;color:var(--green);line-height:1.3;padding:0 7px}
#alphabub{display:none;position:fixed;top:42%;right:40px;width:66px;height:66px;background:var(--green);color:#fff;border-radius:18px;font-size:36px;font-weight:800;align-items:center;justify-content:center;z-index:26;box-shadow:0 8px 24px rgba(0,0,0,.25)}
[data-alpha]{margin-left:0;margin-right:20px}
@media(min-width:700px){#alphaidx{right:242px}#alphabub{right:292px}}
aside.side{display:none}
/* القائمة الجانبية للشاشات الواسعة والطويلة (آيباد/كمبيوتر) — الجوال الأفقي يبقى بواجهة الجوال */
@media(min-width:700px) and (min-height:520px){
  nav.bottom{display:none}
  body{font-size:15.5px;padding-right:238px}
  aside.side{display:flex;flex-direction:column;position:fixed;top:0;right:0;bottom:0;width:238px;background:#fff;border-left:1px solid var(--line);z-index:40}
  aside.side .brand{background:#fff;color:var(--green);font-weight:700;font-size:14px;padding:16px 14px;line-height:1.5;position:relative;text-align:center;border-bottom:3px solid var(--maroon)}
  aside.side .brand .sub{color:var(--maroon);font-weight:600}
  aside.side nav{flex:1;padding:10px 8px;overflow-y:auto}
  aside.side nav a{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:11px;color:var(--ink);font-size:14px;font-weight:500;margin:2px 0}
  aside.side nav a .ic{font-size:19px;width:24px;text-align:center}
  aside.side nav a:hover{background:rgba(63,126,68,.07)}
  aside.side nav a.on{background:rgba(63,126,68,.12);color:var(--green);font-weight:700}
  aside.side .who{padding:14px 16px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
  aside.side .who b{color:var(--ink)}
  .wrap{max-width:880px;padding:18px 26px 40px} .wide .wrap{max-width:1180px}
  .g4{grid-template-columns:repeat(4,1fr)} .g3{grid-template-columns:repeat(3,1fr)}
}
video#cam{width:100%;border-radius:14px;background:#000;max-height:340px;object-fit:cover}
.bignum{font-size:44px;font-weight:800;text-align:center}
.bignum.red{color:#b22}.bignum.green{color:var(--green)}
`;

function layout(title, body, { user = null, active = '', wide = false, flash = '', viewingAs = null } = {}) {
  const nav = navFor(user, active);
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#3F7E44">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head><body class="${wide ? 'wide' : ''}">
${user ? `<aside class="side">
  <div class="brand"><img src="/logo.png" alt="رحلة المدينة النبوية" class="brandlogo" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
    <div style="display:none">🕌 رحلة المدينة النبوية ١١<br><span class="sub" style="font-size:11.5px">١٤٤٨هـ / ٢٠٢٦م</span></div></div>
  <nav>${nav.sidebar}</nav>
  <div class="who"><b>${esc(user.name)}</b><br>${rolePillText(user.role)}</div>
</aside>` : ''}
<header class="top">
  <img src="/logo.png" alt="" class="hlogo" onerror="this.remove()">
  <div class="t">${esc(title)}</div>
  ${user ? `<a href="/me" style="font-size:12px">${esc(user.name.split(' ')[0])} ${user.name.split(' ').at(-1) || ''}</a>` : ''}
</header>
<div class="wrap">
${viewingAs ? `<div class="card" style="background:var(--gold);color:#fff;display:flex;align-items:center;gap:10px;padding:11px 14px">
  <div class="grow"><b>👁️ معاينة:</b> أنت تشاهد التطبيق بحساب <b>${esc(user ? user.name : '')}</b></div>
  <a href="/viewas-exit" class="btn sm" style="background:#fff;color:#8a6516">رجوع لحسابي</a></div>` : ''}
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
${body}
</div>
${user ? `<nav class="bottom">${nav.mobile}</nav>` : ''}
<script>
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
// زر القفز: ينزّلك لآخر القائمة، وإذا كنت تحت يرجّعك فوق — بضغطة واحدة
document.addEventListener('DOMContentLoaded',()=>{
  const btn=document.createElement('button');btn.id='jump';btn.type='button';
  document.body.appendChild(btn);
  const atBottom=()=>innerHeight+scrollY>=document.body.scrollHeight-120;
  let last='';
  function refresh(){
    const long=document.body.scrollHeight>innerHeight*1.6, down=!atBottom();
    const state=long+'|'+down;
    if(state===last)return;            // لا نلمس DOM بلا تغيير (يمنع حلقة المراقب)
    last=state;
    btn.style.display=long?'flex':'none';
    btn.textContent=down?'⬇':'⬆';
    btn.title=down?'النزول لآخر القائمة':'الرجوع للأعلى';
  }
  btn.onclick=()=>{const down=!atBottom();
    scrollTo({top:down?document.body.scrollHeight:0,behavior:'smooth'});
    setTimeout(refresh,450);};
  addEventListener('scroll',refresh,{passive:true});
  addEventListener('resize',refresh);
  setInterval(refresh,700);            // بديل خفيف عن مراقبة DOM كاملة
  refresh();
});
// تطبيع عربي للبحث: يتجاهل الهمزات والتاء المربوطة والتشكيل وأل التعريف
window.arNorm = function (s) {
  return String(s || '')
    .replace(/[ً-ْٰ]/g, '')     // التشكيل
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه')
    .replace(/[ىی]/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ').trim();
};
// مطابقة بأوائل الكلمات: «ي» تُظهر يوسف ويونس ويحيى، ولا تُظهر «خليل»
window.arMatch = function (haystack, query) {
  const q = arNorm(query);
  if (!q) return true;
  const words = arNorm(haystack).split(' ');
  return q.split(' ').filter(Boolean).every(term =>
    words.some(w => w.startsWith(term) || w.replace(/^ال/, '').startsWith(term)));
};
// بحث عام: أي <input data-filter="#هدف"> يفلتر بطاقات الهدف أو صفوف جداوله فورياً
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('input[data-filter]').forEach(inp=>{
    const t=document.querySelector(inp.dataset.filter);if(!t)return;
    const els=()=>{
      if(t.tagName==='TABLE'||t.dataset.rows!==undefined)
        return [...t.querySelectorAll('tr')].filter(r=>r.querySelector('td'));
      return [...t.children];
    };
    // data-search يحصر البحث في النص المقصود (لا في خيارات القوائم المنسدلة)
    // البحث بأي جزء من الاسم: «ي» تُظهر يوسف ويونس، و«احمد» تُطابق «أحمد»
    inp.addEventListener('input',()=>{const v=inp.value.trim();
      els().forEach(el=>{const hit=arMatch(el.dataset.search||el.textContent,v);
        el.style.display=hit?'':'none';
        // البطاقة المطوية تُفتح تلقائياً عند مطابقة البحث، وتُغلق عند مسحه
        if(el.tagName==='DETAILS'&&el.classList.contains('fold'))el.open=!!v&&hit;});});
  });
});
// زر رجوع داخل الصفحات الفرعية (مهم للتطبيق المثبّت بلا شريط متصفح)
(()=>{const p=location.pathname;
  if(p.startsWith('/admin/')&&!p.startsWith('/admin/pin')){const h=document.querySelector('header.top');
    if(h){const a=document.createElement('a');a.className='bk';a.textContent='➜';a.title='رجوع';
      a.onclick=()=>{history.length>1?history.back():location.href='/admin';};h.prepend(a);}}})();
// فهرس الأحرف السريع — يظهر تلقائياً على أي قائمة عليها data-alpha
window.buildAlpha=function(){
  const list=document.querySelector('[data-alpha]');if(!list)return;
  const norm=c=>({'أ':'ا','إ':'ا','آ':'ا'}[c]||c);
  const items=()=>[...list.querySelectorAll('.person-tap,.prow')].filter(e=>e.style.display!=='none');
  const ORDER='ابتثجحخدذرزسشصضطظعغفقكلمنهوي';
  const letters=[...new Set(items().map(e=>norm((e.dataset.name||'')[0])).filter(Boolean))]
    .sort((a,b)=>ORDER.indexOf(a)-ORDER.indexOf(b));
  if(letters.length<5)return; // القوائم القصيرة ما تحتاج فهرس
  let idx=document.getElementById('alphaidx'),bub=document.getElementById('alphabub');
  if(!idx){idx=document.createElement('div');idx.id='alphaidx';document.body.appendChild(idx);
    bub=document.createElement('div');bub.id='alphabub';document.body.appendChild(bub);
    idx.onpointerdown=e=>{go(e.clientY);try{idx.setPointerCapture(e.pointerId)}catch{}};
    idx.onpointermove=e=>{if(e.buttons)go(e.clientY);};
    idx.onpointerup=idx.onpointercancel=()=>{bub.style.display='none';};}
  idx.innerHTML=letters.map(l=>'<span>'+l+'</span>').join('');
  function go(y){const spans=[...idx.children];if(!spans.length)return;
    const top=spans[0].getBoundingClientRect().top,bot=spans[spans.length-1].getBoundingClientRect().bottom;
    const i=Math.min(spans.length-1,Math.max(0,Math.floor((y-top)/((bot-top)/spans.length))));
    const L=spans[i].textContent;bub.textContent=L;bub.style.display='flex';
    const t=items().find(e=>norm((e.dataset.name||'')[0])===L);
    if(t)t.scrollIntoView({block:'center',behavior:'instant'});
    if(navigator.vibrate)navigator.vibrate(8);}
};
document.addEventListener('DOMContentLoaded',()=>buildAlpha());
</script>
</body></html>`;
}

function navFor(user, active) {
  if (!user) return { mobile: '', desk: '' };
  // قائمة مختصرة (٥ عناصر كحد أقصى) — تفاصيل المهام كلها داخل «مهامي»
  const hasCircles = circlesSupervisedBy(user.id).length > 0;
  const hasRooms = roomsSupervisedBy(user).length > 0;
  const hasDuties = hasCircles || hasRooms || isManager(user) ||
    user.role === 'attendance_supervisor' || committeesOf(user.id).length > 0;
  const items = [];
  if (hasDuties) items.push(['/today', '📌', 'مهامي']);
  items.push(['/boards', '🏆', 'لوحة الشرف']);
  if (hasDuties) items.push(['/bus', '🚌', 'الباصات']);
  if (isManager(user)) items.push(['/admin', '⚙️', 'الإدارة']);
  items.push(['/me', '👤', 'صفحتي']);
  const mobile = items.map(([h, ic, l]) => `<a href="${h}" class="${active === h ? 'on' : ''}"><span class="ic">${ic}</span>${l}</a>`).join('');
  const sidebar = items.map(([h, ic, l]) => `<a href="${h}" class="${active === h ? 'on' : ''}"><span class="ic">${ic}</span>${l}</a>`).join('');
  return { mobile, sidebar };
}

const rolePillText = (role) => ROLE_NAMES[role] || role;

// كل دور بلونه: الإشراف العام عنابي، الإداري ذهبي، المشرفون أزرق مميز، الطالب أخضر
const rolePill = (role) => {
  const map = {
    admin: ['m', '👑 المؤسس'],
    manager: ['o', '🎖️ رئيس الوفد'],
    room_supervisor: ['b', '⭐ مشرف غرفة'],
    attendance_supervisor: ['b', '📿 مشرف حضور'],
    student: ['g', 'طالب'],
  };
  const [cls, label] = map[role] || ['g', ROLE_NAMES[role] || role];
  return `<span class="pill ${cls}">${label}</span>`;
};
// شارة صغيرة تظهر بجانب اسم مشرف الغرفة في كل القوائم
const supBadge = (role) => role === 'room_supervisor' ? ' <span class="pill b">⭐ مشرف</span>' : role === 'admin' ? ' <span class="pill m">👑</span>' : '';
const catPill = (cat) => `<span class="pill ${cat === 'شباب' ? 'g' : cat === 'ثانوي' ? 'o' : 'm'}">${esc(cat)}</span>`;

module.exports = { layout, esc, rolePill, catPill, supBadge, shortName, buildShortNames };
