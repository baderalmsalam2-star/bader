// حساب النقاط ولوحتا الشرف (غرف بالعدل + أفراد حسب الفئة)
const { db } = require('./db');

// مجموع نقاط شخص
function personPoints(personId) {
  return db.prepare('SELECT COALESCE(SUM(value),0) v FROM points WHERE person_id = ?').get(personId).v;
}

// لوحة الشرف الفردية — موحّدة لكل المشاركين معاً (بلا فئات، بقرار الإدارة)
// نطاق تواريخ الرحلة — نقاط خارجه لا تُحتسب مهما دخلت القاعدة
function tripRange() {
  const { getSetting } = require('./db');
  return [getSetting('trip_start', '2026-08-15'), getSetting('trip_end', '2026-08-29')];
}
function individualBoard(limit = 20) {
  const [s, e] = tripRange();
  return db.prepare(`
    SELECT p.id, p.name, p.category, r.name AS room, COALESCE(SUM(pt.value),0) AS total
    FROM people p
    LEFT JOIN points pt ON pt.person_id = p.id AND pt.date <= ?
    LEFT JOIN rooms r ON r.id = p.room_id
    WHERE p.active = 1
    GROUP BY p.id ORDER BY total DESC, p.name LIMIT ?`).all(e, limit);
}

// ترتيب الشخص بين الجميع
function rankOf(person) {
  const rows = db.prepare(`
    SELECT p.id, COALESCE(SUM(pt.value),0) AS total
    FROM people p LEFT JOIN points pt ON pt.person_id = p.id
    WHERE p.active = 1
    GROUP BY p.id ORDER BY total DESC`).all();
  const i = rows.findIndex(r => r.id === person.id);
  return { rank: i >= 0 ? i + 1 : null, of: rows.length, total: i >= 0 ? rows[i].total : 0 };
}

// لوحة الغرف — عادلة بغضّ النظر عن الحجم:
// درجة الغرفة = متوسط نجوم الجاهزية (٠-٥ → يوزن ٦٠٪) + متوسط نقاط الفرد الواحد من سكانها (يوزن ٤٠٪)
function roomsBoard() {
  const rooms = db.prepare(`
    SELECT r.id, r.name, r.type, r.room_no,
      (SELECT COUNT(*) FROM people p WHERE p.room_id = r.id AND p.active = 1) AS residents,
      (SELECT AVG(stars) FROM room_ratings rr WHERE rr.room_id = r.id) AS avg_stars,
      (SELECT COALESCE(SUM(pt.value),0) FROM points pt JOIN people p2 ON p2.id = pt.person_id
        WHERE p2.room_id = r.id) AS member_points,
      (SELECT COALESCE(SUM(value),0) FROM points WHERE room_id = r.id) AS room_points
    FROM rooms r ORDER BY r.name`).all();
  const maxPerCapita = Math.max(1, ...rooms.map(r => r.residents ? (r.member_points + r.room_points) / r.residents : 0));
  for (const r of rooms) {
    r.per_capita = r.residents ? Math.round(((r.member_points + r.room_points) / r.residents) * 10) / 10 : 0;
    const starsScore = ((r.avg_stars || 0) / 5) * 60;
    const pcScore = (r.per_capita / maxPerCapita) * 40;
    r.score = Math.round((starsScore + pcScore) * 10) / 10;
  }
  rooms.sort((a, b) => b.score - a.score);
  return rooms;
}

module.exports = { personPoints, individualBoard, rankOf, roomsBoard };
