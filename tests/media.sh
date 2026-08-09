#!/bin/bash
# اختبار الإعلامية: زر «تفاعلت» مقفل حتى يُفتح الرابط فعلاً.
#
# يعمل على قاعدة معزولة في مجلد مؤقّت عبر RIHLA_DATA — لا يمسّ قاعدة الرحلة
# الحقيقية بحال. شغّله من جذر المشروع:  bash tests/media.sh
set -u
cd "$(dirname "$0")/.."
export RIHLA_DATA="${TMPDIR:-/tmp}/rihla-test-$$"
PORT=3112
SRV=
trap '[ -n "$SRV" ] && kill "$SRV" 2>/dev/null; rm -rf "$RIHLA_DATA"' EXIT

A(){ curl -s --noproxy '*' -b rihla=TESTADMIN "$@"; }   # المؤسس
S(){ curl -s --noproxy '*' -b rihla=TESTSTUD  "$@"; }   # طالب
pass=0; fail=0
ok(){ if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 — expected [$3] got [$2]"; fail=$((fail+1)); fi; }
has(){ if echo "$2" | grep -qF "$3"; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 — missing [$3]"; fail=$((fail+1)); fi; }
no(){ if echo "$2" | grep -qF "$3"; then echo "  ❌ $1 — should not contain [$3]"; fail=$((fail+1)); else echo "  ✅ $1"; pass=$((pass+1)); fi; }
q(){ node -e "const{db}=require('./src/db');$1" 2>/dev/null; }
unq(){ python3 -c "import urllib.parse,sys;print(urllib.parse.unquote(sys.argv[1]))" "$1"; }

rm -rf "$RIHLA_DATA"; mkdir -p "$RIHLA_DATA"
q "db.prepare(\"INSERT INTO people (name,role,token) VALUES ('مدير الاختبار','admin','TESTADMIN')\").run();
   db.prepare(\"INSERT INTO people (name,role,token) VALUES ('طالب الاختبار','student','TESTSTUD')\").run();"
PORT=$PORT node src/server.js > "$RIHLA_DATA/srv.log" 2>&1 &
SRV=$!
for i in $(seq 30); do
  kill -0 "$SRV" 2>/dev/null || { echo "❌ الخادم توقّف"; cat "$RIHLA_DATA/srv.log"; exit 1; }
  curl -s --noproxy '*' -o /dev/null "http://localhost:$PORT/" && break
  sleep 0.5
done
grep -q "localhost:$PORT" "$RIHLA_DATA/srv.log" || { echo "❌ المنفذ $PORT مشغول"; exit 1; }
STUD=$(q "console.log(db.prepare(\"SELECT id FROM people WHERE token='TESTSTUD'\").get().id)")

echo "── ١) النشر من الإدارة"
A -X POST -d "title=تغطية اليوم&url=https://example.com/post&note=أعد النشر&points=5" \
  "http://localhost:$PORT/admin/media/add" > /dev/null
ID=$(q "const r=db.prepare('SELECT id FROM media_posts').get();console.log(r?r.id:'')")
ok "أُنشئ المنشور" "$(q "console.log(db.prepare('SELECT COUNT(*) c FROM media_posts').get().c)")" "1"

echo "── ٢) الرابط الخبيث مرفوض"
A -X POST -d "title=خبيث&url=javascript:alert(1)" "http://localhost:$PORT/admin/media/add" > /dev/null
ok "لم يُقبل javascript:" "$(q "console.log(db.prepare('SELECT COUNT(*) c FROM media_posts').get().c)")" "1"
A -X POST -d "title=ملف&url=file:///etc/passwd" "http://localhost:$PORT/admin/media/add" > /dev/null
ok "لم يُقبل file:" "$(q "console.log(db.prepare('SELECT COUNT(*) c FROM media_posts').get().c)")" "1"

echo "── ٣) قبل الفتح: الزر مقفل في الواجهة"
H=$(S "http://localhost:$PORT/media")
has "الزر معروض مقفلاً" "$H" "🔒 تفاعلت"
has "شرح سبب القفل" "$H" "افتح الرابط أولاً"
no "لا نموذج إرسال قبل الفتح" "$H" "/media/$ID/ack"

echo "── ٤) «تفاعلت» تُردّ عمّن لم يفتح — ولو أرسلها بيده"
R=$(S -o /dev/null -w '%{redirect_url}' -X POST "http://localhost:$PORT/media/$ID/ack")
has "الردّ رسالة قفل" "$(unq "$R")" "افتح الرابط أولاً"
ok "لا تفاعل مسجَّل" "$(q "console.log(db.prepare('SELECT COUNT(*) c FROM media_engage WHERE acked_at IS NOT NULL').get().c)")" "0"
ok "لا نقاط مُنحت" "$(q "console.log(db.prepare(\"SELECT COUNT(*) c FROM points WHERE source='media'\").get().c)")" "0"

echo "── ٥) فتح الرابط: تحويل للرابط الحقيقي وتسجيل الفتح"
R=$(S -o /dev/null -w '%{redirect_url}' "http://localhost:$PORT/media/$ID/go")
ok "حُوّل للرابط" "$R" "https://example.com/post"
ok "سُجّل الفتح" "$(q "console.log(db.prepare('SELECT COUNT(*) c FROM media_engage WHERE opened_at IS NOT NULL').get().c)")" "1"

echo "── ٦) بعد الفتح: الزر مفتوح"
H=$(S "http://localhost:$PORT/media")
no "لم يعد مقفلاً" "$H" "🔒 تفاعلت"
has "ظهر نموذج التفاعل" "$H" "/media/$ID/ack"

echo "── ٧) التفاعل يُسجَّل ويمنح النقاط"
S -X POST "http://localhost:$PORT/media/$ID/ack" > /dev/null
ok "سُجّل التفاعل" "$(q "console.log(db.prepare('SELECT COUNT(*) c FROM media_engage WHERE acked_at IS NOT NULL').get().c)")" "1"
ok "مُنحت ٥ نقاط" "$(q "console.log(db.prepare(\"SELECT COALESCE(SUM(value),0) v FROM points WHERE source='media' AND person_id=$STUD\").get().v)")" "5"

echo "── ٨) لا تفاعل مرتين ولا نقاط مضاعفة"
S -X POST "http://localhost:$PORT/media/$ID/ack" > /dev/null
ok "النقاط ما زالت ٥" "$(q "console.log(db.prepare(\"SELECT COALESCE(SUM(value),0) v FROM points WHERE source='media' AND person_id=$STUD\").get().v)")" "5"

echo "── ٩) إعادة الفتح لا تزحزح وقت الفتح الأول"
O1=$(q "console.log(db.prepare('SELECT opened_at FROM media_engage').get().opened_at)")
sleep 1; S -o /dev/null "http://localhost:$PORT/media/$ID/go"
ok "وقت الفتح كما هو" "$(q "console.log(db.prepare('SELECT opened_at FROM media_engage').get().opened_at)")" "$O1"

echo "── ١٠) المنشور الموقوف لا يُفتح ولا يُتفاعل معه"
A -X POST "http://localhost:$PORT/admin/media/$ID/toggle" > /dev/null
R=$(S -o /dev/null -w '%{redirect_url}' "http://localhost:$PORT/media/$ID/go")
has "الفتح مرفوض" "$(unq "$R")" "غير متاح"
no "لا يظهر للمشارك" "$(S "http://localhost:$PORT/media")" "تغطية اليوم"
A -X POST "http://localhost:$PORT/admin/media/$ID/toggle" > /dev/null

echo "── ١١) الطالب لا يفتح لوحة الإعلامية الإدارية"
ok "الإدارة محجوبة عن الطالب" "$(S -o /dev/null -w '%{http_code}' "http://localhost:$PORT/admin/media")" "403"

echo "── ١٢) الصفحات تفتح بلا خطأ"
for p in "/media" "/me" "/admin/media" "/admin/media/$ID" "/admin"; do
  ok "$p" "$(A -o /dev/null -w '%{http_code}' "http://localhost:$PORT$p")" "200"
done

echo "── ١٣) لوحة الإدارة تُظهر الأرقام الصادقة"
H=$(A "http://localhost:$PORT/admin/media")
has "عدّاد من فتح" "$H" "فتحوا الرابط"
has "عدّاد من تفاعل" "$H" "سجّلوا تفاعلهم"

echo
echo "════ ناجح: $pass · فاشل: $fail ════"
exit $fail
