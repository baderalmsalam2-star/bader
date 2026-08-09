#!/bin/bash
# اختبار جاهزية الغرف: البنود لكل طالب + زر «الجميع جاهزون».
#
# يعمل على قاعدة معزولة في مجلد مؤقّت عبر RIHLA_DATA — لا يمسّ قاعدة الرحلة
# الحقيقية بحال. شغّله من جذر المشروع:  bash tests/rooms.sh
set -u
cd "$(dirname "$0")/.."
export RIHLA_DATA="${TMPDIR:-/tmp}/rihla-test-$$"
PORT=3113
SRV=
trap '[ -n "$SRV" ] && kill "$SRV" 2>/dev/null; rm -rf "$RIHLA_DATA"' EXIT

A(){ curl -s --noproxy '*' -b rihla=TESTADMIN "$@"; }
S(){ curl -s --noproxy '*' -b rihla=TESTSTUD  "$@"; }
pass=0; fail=0
ok(){ if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 — expected [$3] got [$2]"; fail=$((fail+1)); fi; }
has(){ if echo "$2" | grep -qF "$3"; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 — missing [$3]"; fail=$((fail+1)); fi; }
q(){ node -e "const{db}=require('./src/db');$1" 2>/dev/null; }
# التهيئة لا تبتلع أخطاءها: خطأٌ صامت هنا يجعل كل اختبار بعده يفشل بلا سبب ظاهر
setup(){ node -e "const{db}=require('./src/db');$1" 2>&1 | grep -v 'ExperimentalWarning\|trace-warnings'; }

rm -rf "$RIHLA_DATA"; mkdir -p "$RIHLA_DATA"
setup "db.prepare(\"INSERT INTO rooms (name,type,room_no,beds) VALUES ('غرفة ١','رباعية','101',4)\").run();
   const r=db.prepare('SELECT id FROM rooms').get().id;
   db.prepare(\"INSERT INTO people (name,role,token) VALUES ('مدير الاختبار','admin','TESTADMIN')\").run();
   db.prepare(\"INSERT INTO people (name,role,token,room_id) VALUES ('طالب أول','student','TESTSTUD',?)\").run(r);
   db.prepare(\"INSERT INTO people (name,role,token,room_id) VALUES ('طالب ثانٍ','student','TOK2',?)\").run(r);"
PORT=$PORT node src/server.js > "$RIHLA_DATA/srv.log" 2>&1 &
SRV=$!
for i in $(seq 30); do
  kill -0 "$SRV" 2>/dev/null || { echo "❌ الخادم توقّف"; cat "$RIHLA_DATA/srv.log"; exit 1; }
  curl -s --noproxy '*' -o /dev/null "http://localhost:$PORT/" && break
  sleep 0.5
done
grep -q "localhost:$PORT" "$RIHLA_DATA/srv.log" || { echo "❌ المنفذ $PORT مشغول"; exit 1; }

RID=$(q "console.log(db.prepare('SELECT id FROM rooms').get().id)")
P1=$(q "console.log(db.prepare(\"SELECT id FROM people WHERE token='TESTSTUD'\").get().id)")
P2=$(q "console.log(db.prepare(\"SELECT id FROM people WHERE token='TOK2'\").get().id)")
PIT=$(q "console.log(db.prepare(\"SELECT GROUP_CONCAT(id) g FROM room_check_items WHERE scope='person' AND active=1\").get().g)")
RIT=$(q "console.log(db.prepare(\"SELECT GROUP_CONCAT(id) g FROM room_check_items WHERE scope='room' AND active=1\").get().g)")
NP=$(q "console.log(db.prepare(\"SELECT COUNT(*) c FROM room_check_items WHERE scope='person' AND active=1\").get().c)")
NR=$(q "console.log(db.prepare(\"SELECT COUNT(*) c FROM room_check_items WHERE scope='room' AND active=1\").get().c)")
TOT=$((NP+NR))
P1A=$(echo "$PIT" | cut -d, -f1)   # أول بند شخصي
P1B=$(echo "$PIT" | cut -d, -f2)   # ثاني بند شخصي

echo "── ١) البنود موزّعة على نطاقين"
ok "بنود الطالب موجودة" "$( [ "$NP" -gt 0 ] && echo yes )" "yes"
ok "بنود الغرفة موجودة" "$( [ "$NR" -gt 0 ] && echo yes )" "yes"

echo "── ٢) الصفحة تعرض بنود كل طالب"
H=$(A "http://localhost:$PORT/room?r=$RID")
has "عنوان بنود الطالب" "$H" "بنود كل طالب"
has "زر الجميع جاهزون" "$H" "الجميع جاهزون"
has "خانة الطالب الأول" "$H" "name=\"p$P1\""
has "خانة الطالب الثاني" "$H" "name=\"p$P2\""

echo "── ٣) بنود كل طالب تُحفظ له وحده"
D="room_id=$RID"
for i in $(echo "$PIT" | tr , ' '); do D="$D&p$P1=$i"; done   # الأول: كل بنوده
D="$D&p$P2=$P1A"                                             # الثاني: بند واحد
A -X POST -d "$D" "http://localhost:$PORT/room/rate" > /dev/null
ok "الأول تحقّقت بنوده كلها" "$(q "console.log(db.prepare('SELECT n FROM person_ready WHERE person_id=$P1').get().n)")" "$NP"
ok "الثاني بند واحد فقط" "$(q "console.log(db.prepare('SELECT n FROM person_ready WHERE person_id=$P2').get().n)")" "1"

echo "── ٤) «جاهز» = كل بنوده — لا بعضها"
ok "الأول جاهز" "$(q "console.log(db.prepare('SELECT ok FROM place_ratings WHERE person_id=$P1').get().ok)")" "1"
ok "الثاني غير جاهز" "$(q "console.log(db.prepare('SELECT ok FROM place_ratings WHERE person_id=$P2').get().ok)")" "0"
ok "نقطة المكان للأول فقط" "$(q "console.log(db.prepare(\"SELECT COUNT(*) c FROM points WHERE source='place'\").get().c)")" "1"

echo "── ٥) بند الطالب لا يُحتسب للغرفة حتى يتحقق عند الجميع"
# لم يُعلَّم أي بند غرفة، والمشترك بين الساكنين بندٌ واحد فقط
ok "درجة الغرفة = ١" "$(q "console.log(db.prepare('SELECT stars FROM room_ratings').get().stars)")" "1"

echo "── ٦) بندٌ تحقّق عند الجميع يُحتسب للغرفة"
D="room_id=$RID&p$P1=$P1A&p$P1=$P1B&p$P2=$P1A&p$P2=$P1B"
A -X POST -d "$D" "http://localhost:$PORT/room/rate" > /dev/null
ok "درجة الغرفة = عدد بنود الطالب" "$(q "console.log(db.prepare('SELECT stars FROM room_ratings').get().stars)")" "$NP"

echo "── ٧) «الجميع جاهزون» يُعلّم كل شيء بضغطة"
A -X POST -d "room_id=$RID" "http://localhost:$PORT/room/rate" > /dev/null   # مسح أولاً
ok "صفر بعد المسح" "$(q "console.log(db.prepare('SELECT stars FROM room_ratings').get().stars)")" "0"
A -X POST -d "room_id=$RID&allready=1" "http://localhost:$PORT/room/rate" > /dev/null
ok "الغرفة كاملة الدرجة" "$(q "console.log(db.prepare('SELECT stars FROM room_ratings').get().stars)")" "$TOT"
ok "الأول جاهز" "$(q "console.log(db.prepare('SELECT ok FROM place_ratings WHERE person_id=$P1').get().ok)")" "1"
ok "الثاني جاهز" "$(q "console.log(db.prepare('SELECT ok FROM place_ratings WHERE person_id=$P2').get().ok)")" "1"
ok "كلاهما نال نقطة المكان" "$(q "console.log(db.prepare(\"SELECT COUNT(*) c FROM points WHERE source='place'\").get().c)")" "2"

echo "── ٨) إعادة الحفظ لا تضاعف النقاط"
A -X POST -d "room_id=$RID&allready=1" "http://localhost:$PORT/room/rate" > /dev/null
ok "نقاط المكان ما زالت ٢" "$(q "console.log(db.prepare(\"SELECT COUNT(*) c FROM points WHERE source='place'\").get().c)")" "2"
ok "نقاط الجاهزية سطر واحد" "$(q "console.log(db.prepare(\"SELECT COUNT(*) c FROM points WHERE source='cleanliness'\").get().c)")" "1"

echo "── ٩) بندٌ غير مفعّل لا يُقبل ولا يرفع الدرجة"
BAD=$(q "const r=db.prepare(\"INSERT INTO room_check_items (title,ord,scope,active) VALUES ('بند معطّل',99,'person',0)\").run();console.log(r.lastInsertRowid)")
A -X POST -d "room_id=$RID&p$P1=$BAD&p$P2=$BAD" "http://localhost:$PORT/room/rate" > /dev/null
ok "لم يُحسب البند المعطّل" "$(q "console.log(db.prepare('SELECT stars FROM room_ratings').get().stars)")" "0"

echo "── ٩ب) بلا بنود شخصية: لا يُحكم على الطالب بجاهزية ولا ضدّها"
q "db.prepare(\"UPDATE room_check_items SET scope='room' WHERE scope='person'\").run();
   db.prepare('DELETE FROM place_ratings').run();"
A -X POST -d "room_id=$RID" "http://localhost:$PORT/room/rate" > /dev/null
ok "لا حكم مسجَّل على أحد" "$(q "console.log(db.prepare('SELECT COUNT(*) c FROM place_ratings').get().c)")" "0"
q "db.prepare(\"UPDATE room_check_items SET scope='person' WHERE id IN ($PIT)\").run();"

echo "── ١٠) الطالب لا يقيّم الغرف"
ok "التقييم محجوب عن الطالب" "$(S -o /dev/null -w '%{http_code}' "http://localhost:$PORT/room?r=$RID")" "403"

echo "── ١١) نطاق البند يُبدَّل من الإدارة"
FIRST=$(echo "$RIT" | cut -d, -f1)
A -X POST "http://localhost:$PORT/admin/checkitems/$FIRST/scope" > /dev/null
ok "صار بند طالب" "$(q "console.log(db.prepare('SELECT scope FROM room_check_items WHERE id=$FIRST').get().scope)")" "person"
A -X POST "http://localhost:$PORT/admin/checkitems/$FIRST/scope" > /dev/null
ok "رجع بند غرفة" "$(q "console.log(db.prepare('SELECT scope FROM room_check_items WHERE id=$FIRST').get().scope)")" "room"

echo "── ١٢) الصفحات تفتح بلا خطأ"
for p in "/room?r=$RID" "/admin/checkitems" "/admin/dashboard" "/boards"; do
  ok "$p" "$(A -o /dev/null -w '%{http_code}' "http://localhost:$PORT$p")" "200"
done

echo
echo "════ ناجح: $pass · فاشل: $fail ════"
exit $fail
