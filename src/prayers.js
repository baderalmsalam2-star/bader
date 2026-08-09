// أوقات الصلاة — جلب تلقائي (أم القرى عبر aladhan.com) مع إمكانية تعديل يدوي من الإدارة
const { db, getSetting, today } = require('./db');

const CITY_MAP = { 'المدينة': 'Medina', 'مكة': 'Makkah' };

function getPrayers(date, city) {
  return db.prepare('SELECT * FROM prayer_times WHERE date = ? AND city = ?').get(date, city) || null;
}

function savePrayers(date, city, t, source) {
  db.prepare(`INSERT INTO prayer_times (date, city, fajr, dhuhr, asr, maghrib, isha, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(date, city) DO UPDATE SET fajr=excluded.fajr, dhuhr=excluded.dhuhr,
                asr=excluded.asr, maghrib=excluded.maghrib, isha=excluded.isha, source=excluded.source`)
    .run(date, city, t.fajr, t.dhuhr, t.asr, t.maghrib, t.isha, source);
}

// جلب من الإنترنت — لا يمس الأيام المعدَّلة يدوياً
async function fetchFromApi(date, city) {
  const [y, m, d] = date.split('-');
  const url = `https://api.aladhan.com/v1/timingsByCity/${d}-${m}-${y}?city=${CITY_MAP[city] || 'Medina'}&country=Saudi%20Arabia&method=4`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('API ' + res.status);
  const j = await res.json();
  const T = j.data.timings;
  const clean = (s) => s.split(' ')[0];
  return { fajr: clean(T.Fajr), dhuhr: clean(T.Dhuhr), asr: clean(T.Asr), maghrib: clean(T.Maghrib), isha: clean(T.Isha) };
}

// يضمن وجود أوقات اليوم للمدينة الحالية (يجلب عند الحاجة)، ويرجعها
async function ensureToday() {
  const city = getSetting('current_city', 'المدينة');
  const date = today();
  let p = getPrayers(date, city);
  if (!p) {
    try {
      const t = await fetchFromApi(date, city);
      savePrayers(date, city, t, 'api');
      p = getPrayers(date, city);
    } catch { /* بدون إنترنت: نرجع آخر يوم متوفر */
      p = db.prepare('SELECT * FROM prayer_times WHERE city = ? ORDER BY date DESC LIMIT 1').get(city) || null;
    }
  }
  return { city, date, times: p };
}

// جلب فترة كاملة (أيام الرحلة) مقدماً — يُستدعى من لوحة الإدارة
async function fetchRange(startDate, days, city) {
  let ok = 0, fail = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const cur = getPrayers(date, city);
    if (cur && cur.source === 'manual') continue; // لا نلمس المعدَّل يدوياً
    try { savePrayers(date, city, await fetchFromApi(date, city), 'api'); ok++; }
    catch { fail++; }
  }
  return { ok, fail };
}

module.exports = { getPrayers, savePrayers, ensureToday, fetchRange };
