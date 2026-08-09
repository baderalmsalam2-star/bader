// قاعدة بيانات رحلة المدينة النبوية — SQLite (node:sqlite)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'rihla.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,              -- ملكي / رئاسي / رباعية
  beds INTEGER NOT NULL DEFAULT 4,
  extra_beds INTEGER NOT NULL DEFAULT 0,
  room_no TEXT,
  label TEXT,                      -- سويت الضيافة / سويت الأكل ...
  supervisor_id INTEGER REFERENCES people(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'رجال',   -- شباب / ثانوي / رجال
  role TEXT NOT NULL DEFAULT 'student',    -- admin / manager / room_supervisor / attendance_supervisor / student
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  civil_id TEXT,                            -- الرقم المدني (يظهر للإدارة فقط)
  phone TEXT,
  token TEXT NOT NULL UNIQUE,               -- رمز الدخول الشخصي (رابط + QR)
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  user_no TEXT,                             -- رقم المشارك في كشف اللجنة
  track TEXT,                               -- المسار العلمي (من منصة خليل)
  birth_year INTEGER
);

CREATE TABLE IF NOT EXISTS att_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  supervisor_id INTEGER REFERENCES people(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS att_group_members (
  group_id INTEGER NOT NULL REFERENCES att_groups(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, person_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,               -- YYYY-MM-DD
  slot TEXT NOT NULL,               -- fajr / asr
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  status TEXT NOT NULL,             -- present / absent / excused
  marked_by INTEGER,
  ts TEXT NOT NULL,
  UNIQUE (date, slot, person_id)
);

CREATE TABLE IF NOT EXISTS points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
  source TEXT NOT NULL,             -- cleanliness / behavior / attendance / other
  value INTEGER NOT NULL,
  note TEXT,
  date TEXT NOT NULL,
  added_by INTEGER,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 0 AND 99),
  note TEXT,
  rated_by INTEGER,
  UNIQUE (room_id, date)
);

-- فائدة اليوم: يكتبها الطالب، ولا تُنشر إلا باعتماد الإدارة (لا دردشة مفتوحة)
CREATE TABLE IF NOT EXISTS benefits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',   -- new / approved / rejected
  approved_by INTEGER,
  ts TEXT NOT NULL
);

-- الزيارات بين الغرف: يسجّلها الزائر ويعتمدها مشرف الغرفة المُزارة
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / approved
  approved_by INTEGER,
  ts TEXT NOT NULL,
  UNIQUE (visitor_id, room_id, date)
);

-- تقييم مكان كل ساكن (سريره وأغراضه) — الافتراض «مرتّب»، ولا يُسجَّل خلافه إلا بضغطة
CREATE TABLE IF NOT EXISTS place_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  rated_by INTEGER,
  ts TEXT,
  UNIQUE (person_id, date)
);

-- مشرفون مشاركون في الغرفة نفسها: أيّهم سجّل، سجّل عن الجميع (الصلاحية داخل غرفته وحدها)
CREATE TABLE IF NOT EXISTS room_supervisors (
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, person_id)
);

-- بنود جاهزية الغرفة: معايير محسوسة (نعم/لا) بدل تقدير نجوم شخصي
CREATE TABLE IF NOT EXISTS room_check_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bus_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS boardings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_id INTEGER NOT NULL REFERENCES bus_stages(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  status TEXT NOT NULL,             -- boarded / exempt
  bus_no INTEGER,
  note TEXT,                        -- سبب الاستثناء
  marked_by INTEGER,
  ts TEXT NOT NULL,
  UNIQUE (stage_id, person_id)
);

CREATE TABLE IF NOT EXISTS daily_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  author TEXT
);

CREATE TABLE IF NOT EXISTS committees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL DEFAULT ''   -- الإشراف الفني / الإدارة العامة
);
CREATE TABLE IF NOT EXISTS committee_members (
  committee_id INTEGER NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  is_head INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (committee_id, person_id)
);
CREATE TABLE IF NOT EXISTS committee_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  committee_id INTEGER NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'once', -- daily / once
  date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  done_by INTEGER,
  done_at TEXT
);

-- إنجاز المهام اليومية: صف لكل (مهمة، يوم) — فتتصفّر الـ checklist تلقائياً كل يوم
CREATE TABLE IF NOT EXISTS task_done (
  task_id INTEGER NOT NULL REFERENCES committee_tasks(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  done_by INTEGER,
  done_at TEXT,
  PRIMARY KEY (task_id, date)
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  committee_id INTEGER REFERENCES committees(id) ON DELETE SET NULL,
  category TEXT,                    -- طلب / اقتراح / نقص / بلاغ طبي
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', -- new / processing / done
  ts TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS medical (
  person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  allergies TEXT, meds TEXT, chronic TEXT, notes TEXT
);

-- إنجاز القرآن اليومي: حفظ جديد / مراجعة / سرد — يعلّمه مشرف الحلقة لحظة التسميع
CREATE TABLE IF NOT EXISTS quran_marks (
  date TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- hifz / murajaa / sard
  marked_by INTEGER,
  ts TEXT NOT NULL,
  PRIMARY KEY (date, person_id, kind)
);

-- السؤال اليومي التفاعلي (اختيار من متعدد) — نقاط لأول إجابة صحيحة فقط
CREATE TABLE IF NOT EXISTS daily_quiz (
  date TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  options TEXT NOT NULL,            -- JSON: ["أ","ب","ج","د"]
  correct INTEGER NOT NULL,         -- فهرس الخيار الصحيح
  points INTEGER NOT NULL DEFAULT 5,
  author TEXT
);
CREATE TABLE IF NOT EXISTS quiz_answers (
  date TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  choice INTEGER NOT NULL,
  correct INTEGER NOT NULL,         -- 1 إن أصاب
  ts TEXT NOT NULL,
  PRIMARY KEY (date, person_id)
);

CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  title TEXT NOT NULL,
  scope TEXT DEFAULT 'الجميع'
);

CREATE TABLE IF NOT EXISTS prayer_times (
  date TEXT NOT NULL,
  city TEXT NOT NULL,               -- المدينة / مكة
  fajr TEXT, dhuhr TEXT, asr TEXT, maghrib TEXT, isha TEXT,
  source TEXT NOT NULL DEFAULT 'api', -- api / manual
  PRIMARY KEY (date, city)
);

-- المصروفات: بنود قابلة للإضافة + تسجيل سريع بعملتين (دينار/ريال)
CREATE TABLE IF NOT EXISTS expense_cats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent TEXT NOT NULL DEFAULT '',   -- المجموعة الرئيسية (الخدمات، العلمية...)
  ord INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cat_id INTEGER NOT NULL REFERENCES expense_cats(id) ON DELETE RESTRICT,
  amount REAL NOT NULL,              -- المبلغ كما أُدخل
  currency TEXT NOT NULL,            -- KWD / SAR
  amount_kwd REAL NOT NULL,          -- المحوَّل للدينار (أساس التقارير)
  note TEXT,
  date TEXT NOT NULL,
  by_id INTEGER,
  ts TEXT NOT NULL
);

-- جلسات الدخول: كل جهاز دخل بأي حساب — لمراقبة حساب المؤسس خاصة
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,        -- بصمة الجهاز (ua+ip)
  ua TEXT,
  ip TEXT,
  device TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  UNIQUE (person_id, fingerprint)
);

-- لوحات الشرف اليدوية: القرآن (من اللجنة العلمية) والمتميزون (بترشيح)
CREATE TABLE IF NOT EXISTS honor_boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,               -- quran / distinguished
  date TEXT NOT NULL,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
  name TEXT,                        -- اسم حر لمن ليس في القائمة
  note TEXT,                        -- سبب التميز / الإنجاز
  added_by INTEGER,
  ts TEXT NOT NULL
);

-- ترشيحات المشرفين للمتميزين: سبب مكتوب من شخص آخر (قابل للدفاع عنه)
CREATE TABLE IF NOT EXISTS nominations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  by_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  date TEXT NOT NULL,
  ts TEXT NOT NULL
);


-- الchecklist الشخصية: بنود عامة (يضيفها المؤسس للجميع) + بنود خاصة يضيفها الشخص لنفسه
CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,  -- NULL = بند عام للجميع
  title TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  ts TEXT
);
CREATE TABLE IF NOT EXISTS checklist_done (
  item_id INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY (item_id, person_id, date)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  who INTEGER,
  action TEXT NOT NULL,
  detail TEXT
);
`);

// ترقيات تدريجية للمخطط (تعمل بأمان على قاعدة موجودة)
{
  const cols = db.prepare('PRAGMA table_info(people)').all().map(c => c.name);
  if (!cols.includes('photo_status')) {
    db.exec("ALTER TABLE people ADD COLUMN photo_status TEXT NOT NULL DEFAULT 'none'"); // none / pending / approved
  }
}

// ترقية جدول التقييم: تخزين البنود المحققة
{
  const rc = db.prepare('PRAGMA table_info(room_ratings)').all().map(c => c.name);
  if (!rc.includes('items')) db.exec('ALTER TABLE room_ratings ADD COLUMN items TEXT');
}
// ترقية التكرار: يومية / يوم وترك / أسبوعية / مرتين في الأسبوع / مرة واحدة
{
  const add = (tbl, col, type) => {
    const cs = db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name);
    if (!cs.includes(col)) db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${type}`);
  };
  // قيد stars القديم (1..5) كان ينهار حين لا يتحقق أي بند (0) أو حين تزيد البنود عن ٥.
  // القيد لا يُعدَّل بـ ALTER في SQLite، فنعيد بناء الجدول مرة واحدة.
  {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='room_ratings'").get();
    if (sql && sql.sql.includes('BETWEEN 1 AND 5')) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE room_ratings__new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          stars INTEGER NOT NULL CHECK (stars BETWEEN 0 AND 99),
          note TEXT,
          rated_by INTEGER,
          items TEXT,
          UNIQUE (room_id, date)
        );
        INSERT INTO room_ratings__new (id, room_id, date, stars, note, rated_by, items)
          SELECT id, room_id, date, stars, note, rated_by, items FROM room_ratings;
        DROP TABLE room_ratings;
        ALTER TABLE room_ratings__new RENAME TO room_ratings;
        PRAGMA foreign_keys = ON;`);
    }
  }

  // أعمدة كانت تُضاف يدوياً على القاعدة الحية فقط — بلا هذه الترقيات تنكسر أي قاعدة
  // جديدة أو مستعادة من نسخة قديمة (صفحة اللجان وتعديل المشارك والتصدير)
  add('people', 'user_no', 'TEXT');
  add('people', 'track', 'TEXT');
  add('people', 'birth_year', 'INTEGER');
  add('committees', 'branch', "TEXT NOT NULL DEFAULT ''");
  add('checklist_items', 'repeat_kind', "TEXT NOT NULL DEFAULT 'daily'");
  add('checklist_items', 'weekday', 'INTEGER');
  add('checklist_items', 'weekday2', 'INTEGER');
  add('committee_tasks', 'weekday', 'INTEGER');
  add('committee_tasks', 'weekday2', 'INTEGER');
  // «مرة في الموسم» أُلغيت بقرار الإدارة — تُرحَّل إلى «مرة واحدة»
  db.exec("UPDATE committee_tasks SET kind = 'once' WHERE kind = 'season'");
}

// بنود الجاهزية الافتراضية — معايير محسوسة يراها الجميع (قابلة للتعديل من لوحة الإدارة)
if (db.prepare('SELECT COUNT(*) c FROM room_check_items').get().c === 0) {
  const ins = db.prepare('INSERT INTO room_check_items (title, ord) VALUES (?, ?)');
  ['الأسرّة مرتّبة والأغطية مطويّة',
    'الأرضية نظيفة وخالية من النفايات',
    'الملابس والحقائب مرتّبة في مكانها',
    'دورة المياه نظيفة',
    'لا بقايا طعام أو أكواب مكشوفة',
  ].forEach((t, i) => ins.run(t, i));
}

// بنود المصروفات الافتراضية (حسب اعتماد الإدارة) — تُضاف مرة واحدة وتبقى قابلة للتعديل
if (db.prepare('SELECT COUNT(*) c FROM expense_cats').get().c === 0) {
  const ins = db.prepare('INSERT INTO expense_cats (name, parent, ord) VALUES (?, ?, ?)');
  [
    ['التذاكر', 'الطيران'], ['الفيزا', 'الطيران'],
    ['الفندق', ''],
    ['الباصات', 'النقليات'], ['القطار', 'النقليات'],
    ['سويت الضيافة', 'الخدمات — الضيافة'], ['ضيافة الحرم', 'الخدمات — الضيافة'], ['اللقاء التنويري', 'الخدمات — الضيافة'],
    ['الغداء', 'الخدمات — الوجبات'], ['العشاء', 'الخدمات — الوجبات'],
    ['تموين الغرف', 'الخدمات'],
    ['الإعلامية', ''],
    ['لوحة الشرف', 'العلمية'], ['الاختبارات', 'العلمية'], ['مكافآت المشايخ', 'العلمية'],
    ['الرياضية', ''],
    ['سين جيم', 'الثقافية'], ['ألعاب أخرى', 'الثقافية'],
    ['الطبية', ''],
  ].forEach((x, i) => ins.run(x[0], x[1], i));
}

// ===== helpers =====
const now = () => new Date().toISOString();
const today = () => {
  // تاريخ اليوم بتوقيت السعودية (UTC+3)
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};

function getSetting(key, dflt = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : dflt;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
function audit(who, action, detail) {
  db.prepare('INSERT INTO audit (ts, who, action, detail) VALUES (?, ?, ?, ?)').run(now(), who || null, action, detail || null);
}

// قيم النقاط الافتراضية (قابلة للتعديل من لوحة الإدارة)
const DEFAULT_RULES = {
  attendance_present: 10,   // حضور في موعد الرصد
  attendance_late: 5,       // تأخير (نصف نقاط الحضور)
  cleanliness_star: 2,      // نقاط الغرفة لكل نجمة (١-٥ بغضّ النظر عن عدد السكان)
  benefit_point: 5,       // نقاط الطالب حين تُعتمد فائدته وتُنشر
  visit_point: 3,         // نقاط الزيارة المعتمَدة من مشرف الغرفة المُزارة
  place_point: 2,           // نقاط الطالب حين يكون مكانه (سريره وأغراضه) مرتّباً
  behavior_max: 5,          // أقصى نقاط سلوك تُمنح/تُخصم بالمرة الواحدة
  behavior_person_cap: 10,  // أقصى ما يتلقاه الطالب الواحد في اليوم من كل المانحين مجتمعين
  // ملاحظة: سقف المانح في الغرفة يُحسب تلقائياً = عدد سكانها × سقف الطالب
  // فغرفة بثلاثة سكان ميزانيتها ٣٠، وبثمانية ٨٠ — عادلة بحجم الغرفة لا برقم ثابت
};

// فئات المشاركين — قابلة للتعديل من لوحة الإدارة
const DEFAULT_CATEGORIES = ['شباب', 'ثانوي', 'جامعي', 'موظف', 'كبار'];
function getCategories() {
  const raw = getSetting('categories');
  try { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) return a; } catch { }
  return [...DEFAULT_CATEGORIES];
}

function getRules() {
  const raw = getSetting('points_rules');
  return raw ? { ...DEFAULT_RULES, ...JSON.parse(raw) } : { ...DEFAULT_RULES };
}

// مواعيد التحضير — قابلة للتعديل من لوحة الإدارة
// who: attendance = مشرفو الحلقات (تحضير عام) / room = مشرفو الغرف (تحضير داخل الغرفة)
const DEFAULT_SLOTS = [
  { key: 'fajr', label: 'فجر الحرم', time: '04:30', who: 'attendance', enabled: 1 },
  { key: 'asr', label: 'حلقة العصر', time: '16:00', who: 'attendance', enabled: 1 },
  { key: 'room_night', label: 'تحضير الغرف — ليلاً', time: '00:00', who: 'room', enabled: 1 },
  { key: 'room_morning', label: 'تحضير الغرف — صباحاً', time: '10:00', who: 'room', enabled: 1 },
];
function getSlots() {
  const raw = getSetting('att_slots');
  if (!raw) return DEFAULT_SLOTS.map(s => ({ ...s }));
  const saved = JSON.parse(raw);
  // ندمج مع الافتراضي حتى لا يختفي موعد أساسي
  return DEFAULT_SLOTS.map(d => ({ ...d, ...(saved.find(s => s.key === d.key) || {}) }));
}
function slotLabel(key) {
  const s = getSlots().find(s => s.key === key);
  return s ? s.label : key;
}

// نسخ احتياطي: نسخة يومية في data/backups مع الاحتفاظ بآخر ١٤ نسخة
// نسخة كل ١٢ ساعة (صباحية ومسائية) مع التحقق من سلامتها — يُحتفظ بآخر ٢٨ نسخة (١٤ يوماً)
function backupNow(force = false) {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date(Date.now() + 3 * 3600 * 1000);
    const half = d.getUTCHours() < 12 ? 'ص' : 'م';          // نصفا اليوم
    const f = path.join(dir, `rihla-${today()}-${half}.db`);
    if (force || !fs.existsSync(f)) {
      if (fs.existsSync(f)) fs.unlinkSync(f);   // VACUUM INTO لا يكتب فوق ملف موجود
      db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
      // تحقق من سلامة النسخة: نفتحها ونعدّ الأشخاص
      let verified = false, n = 0;
      try {
        const chk = new DatabaseSync(f, { readOnly: true });
        n = chk.prepare('SELECT COUNT(*) c FROM people').get().c;
        verified = n > 0;
        chk.close();
      } catch { verified = false; }
      if (!verified) { try { fs.unlinkSync(f); } catch { } audit(null, 'backup_failed', 'فشل التحقق من النسخة'); return null; }
      const kb = Math.round(fs.statSync(f).size / 1024);
      setSetting('last_backup', new Date().toISOString());
      audit(null, 'backup', `✅ ${path.basename(f)} — ${n} شخصاً، ${kb}KB (تم التحقق)`);
    }
    // نحتفظ بكل النسخ — القاعدة صغيرة (~300KB)، فالرحلة كلها لا تتجاوز ٢٠ ميجابايت.
    // الحدّ الأقصى ٥٠٠ نسخة كصمّام أمان فقط (يكفي أكثر من سنة).
    const files = fs.readdirSync(dir).filter(x => x.endsWith('.db')).sort();
    if (files.length > 500) files.slice(0, files.length - 500).forEach(x => fs.unlinkSync(path.join(dir, x)));
    return f;
  } catch (e) { console.error('backup failed:', e.message); return null; }
}

module.exports = { db, now, today, getSetting, setSetting, audit, getRules, DEFAULT_RULES, getSlots, slotLabel, DEFAULT_SLOTS, backupNow, getCategories, DEFAULT_CATEGORIES };
