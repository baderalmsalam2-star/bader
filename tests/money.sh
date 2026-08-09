#!/bin/bash
# اختبار المالية: الدفتران (المدينة/مكة) وإقفال اليوم نهائياً عند الفجر.
#
# يعمل على قاعدة معزولة في مجلد مؤقّت عبر RIHLA_DATA — لا يمسّ قاعدة الرحلة
# الحقيقية بحال. شغّله من جذر المشروع:  bash tests/money.sh
set -u
cd "$(dirname "$0")/.."
export RIHLA_DATA="${TMPDIR:-/tmp}/rihla-test-$$"
# منفذ خاص بالاختبار حتى لا يزاحم خادماً شغّالاً على ٣٠٠٠
PORT=3111
SRV=
# التنظيف بالـ PID لا بمطابقة الاسم: خادمٌ ناجٍ من تشغيلة سابقة يحتلّ المنفذ
# ويردّ على الطلبات، فتُقرأ نتائجُه على أنها نتائج هذه التشغيلة.
trap '[ -n "$SRV" ] && kill "$SRV" 2>/dev/null; rm -rf "$RIHLA_DATA"' EXIT
C(){ curl -s --noproxy '*' -b rihla=TESTADMIN "$@"; }
pass=0; fail=0
ok(){ if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 — expected [$3] got [$2]"; fail=$((fail+1)); fi; }
has(){ if echo "$2" | grep -qF "$3"; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 — missing [$3]"; fail=$((fail+1)); fi; }
no(){ if echo "$2" | grep -qF "$3"; then echo "  ❌ $1 — should not contain [$3]"; fail=$((fail+1)); else echo "  ✅ $1"; pass=$((pass+1)); fi; }

rm -rf "$RIHLA_DATA"; mkdir -p "$RIHLA_DATA"
node -e "
const {db}=require('./src/db');
db.prepare(\"INSERT INTO people (name,role,token) VALUES ('مدير الاختبار','admin','TESTADMIN')\").run();
" 2>/dev/null
PORT=$PORT node src/server.js > "$RIHLA_DATA/srv.log" 2>&1 &
SRV=$!
# انتظر إقلاع الخادم، وتحقّق أنه خادمُنا نحن لا خادمٌ آخر يحتلّ المنفذ
for i in $(seq 30); do
  kill -0 "$SRV" 2>/dev/null || { echo "❌ الخادم توقّف — راجع $RIHLA_DATA/srv.log"; cat "$RIHLA_DATA/srv.log"; exit 1; }
  curl -s --noproxy '*' -o /dev/null "http://localhost:$PORT/" && break
  sleep 0.5
done
if ! grep -q "localhost:$PORT" "$RIHLA_DATA/srv.log"; then
  echo "❌ المنفذ $PORT مشغول بخادم آخر — أوقفه ثم أعد الاختبار"; cat "$RIHLA_DATA/srv.log"; exit 1
fi

CAT=$(node -e "const{db}=require('./src/db');console.log(db.prepare('SELECT id FROM expense_cats LIMIT 1').get().id)" 2>/dev/null)
TODAY=$(node -e "const{today}=require('./src/db');console.log(today())" 2>/dev/null)
YEST=$(node -e "const{today}=require('./src/db');const d=new Date(today()+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-1);console.log(d.toISOString().slice(0,10))" 2>/dev/null)

echo "── ١) الدفتران منفصلان"
C -X POST -d "ledger=المدينة&cat_id=$CAT&amount=100&currency=KWD&note=مدينة١" http://localhost:$PORT/admin/money/add > /dev/null
C -X POST -d "ledger=مكة&cat_id=$CAT&amount=50&currency=KWD&note=مكة١"   http://localhost:$PORT/admin/money/add > /dev/null
S=$(node -e "const{db}=require('./src/db');console.log(db.prepare('SELECT ledger,SUM(amount_kwd) v FROM expenses GROUP BY ledger ORDER BY ledger').all().map(r=>r.ledger+'='+r.v).join(' '))" 2>/dev/null)
ok "قُيّد كل مبلغ على دفتره" "$S" "المدينة=100 مكة=50"

echo "── ٢) دفتر مجهول يرجع للدفتر الحالي، لا يُنشئ دفتراً ثالثاً"
C -X POST -d "ledger=الرياض&cat_id=$CAT&amount=7&currency=KWD" http://localhost:$PORT/admin/money/add > /dev/null
N=$(node -e "const{db}=require('./src/db');console.log(db.prepare('SELECT COUNT(DISTINCT ledger) c FROM expenses').get().c)" 2>/dev/null)
ok "عدد الدفاتر ما زال اثنين" "$N" "2"

echo "── ٣) قبل الفجر: القيد يقع على يوم أمس"
node -e "
const{db}=require('./src/db');
db.prepare(\"INSERT INTO prayer_times (date,city,fajr,source) VALUES (?,'المدينة','23:59','manual') ON CONFLICT(date,city) DO UPDATE SET fajr='23:59'\").run('$TODAY');
" 2>/dev/null
C -X POST -d "ledger=المدينة&cat_id=$CAT&amount=33&currency=KWD&note=قبل-الفجر" http://localhost:$PORT/admin/money/add > /dev/null
D=$(node -e "const{db}=require('./src/db');console.log(db.prepare(\"SELECT date FROM expenses WHERE note='قبل-الفجر'\").get().date)" 2>/dev/null)
ok "سُجّل على أمس ($YEST)" "$D" "$YEST"

echo "── ٤) بعد الفجر: القيد يقع على اليوم"
node -e "const{db}=require('./src/db');db.prepare(\"UPDATE prayer_times SET fajr='00:00' WHERE date=? AND city='المدينة'\").run('$TODAY')" 2>/dev/null
C -X POST -d "ledger=المدينة&cat_id=$CAT&amount=44&currency=KWD&note=بعد-الفجر" http://localhost:$PORT/admin/money/add > /dev/null
D=$(node -e "const{db}=require('./src/db');console.log(db.prepare(\"SELECT date FROM expenses WHERE note='بعد-الفجر'\").get().date)" 2>/dev/null)
ok "سُجّل على اليوم ($TODAY)" "$D" "$TODAY"

echo "── ٥) الختم عند الفجر: يوم أمس أُقفل بلقطة إجماليه"
C http://localhost:$PORT/admin/money > /dev/null
SEAL=$(node -e "const{db}=require('./src/db');const r=db.prepare(\"SELECT * FROM money_day_close WHERE date=? AND ledger='المدينة'\").get('$YEST');console.log(r?r.total_kwd+'/'+r.n+'/'+r.fajr:'none')" 2>/dev/null)
ok "خُتم أمس بلقطة ٣٣ د.ك في عملية واحدة" "$SEAL" "33/1/00:00"

echo "── ٦) اليوم المقفل لا يُحذف منه"
ID=$(node -e "const{db}=require('./src/db');console.log(db.prepare(\"SELECT id FROM expenses WHERE note='قبل-الفجر'\").get().id)" 2>/dev/null)
R=$(C -o /dev/null -w '%{redirect_url}' -X POST http://localhost:$PORT/admin/money/$ID/delete)
has "الحذف مرفوض برسالة إقفال" "$(python3 -c "import urllib.parse,sys;print(urllib.parse.unquote(sys.argv[1]))" "$R")" "مقفل نهائياً"
E=$(node -e "const{db}=require('./src/db');console.log(db.prepare('SELECT COUNT(*) c FROM expenses WHERE id=?').get($ID).c)" 2>/dev/null)
ok "المصروف ما زال موجوداً" "$E" "1"

echo "── ٧) اليوم المفتوح يُحذف منه"
ID2=$(node -e "const{db}=require('./src/db');console.log(db.prepare(\"SELECT id FROM expenses WHERE note='بعد-الفجر'\").get().id)" 2>/dev/null)
C -X POST http://localhost:$PORT/admin/money/$ID2/delete > /dev/null
E=$(node -e "const{db}=require('./src/db');console.log(db.prepare('SELECT COUNT(*) c FROM expenses WHERE id=?').get($ID2).c)" 2>/dev/null)
ok "حُذف فعلاً" "$E" "0"

echo "── ٨) الختم لا يتكرر ولا يتغيّر بعد وقوعه"
node -e "const{db}=require('./src/db');db.prepare(\"INSERT INTO expenses (cat_id,amount,currency,amount_kwd,date,ledger,ts) VALUES ($CAT,999,'KWD',999,'$YEST','المدينة','x')\").run()" 2>/dev/null
C http://localhost:$PORT/admin/money > /dev/null
SEAL2=$(node -e "const{db}=require('./src/db');const r=db.prepare(\"SELECT * FROM money_day_close WHERE date=? AND ledger='المدينة'\").get('$YEST');console.log(r.total_kwd+'/'+r.n)" 2>/dev/null)
ok "اللقطة الأصلية محفوظة (٣٣ لا ١٠٣٢)" "$SEAL2" "33/1"

echo "── ٩) الصفحات تفتح بلا خطأ"
for p in "/admin/money" "/admin/money?ledger=%D9%85%D9%83%D8%A9" "/admin/money/report" "/admin/money/report?ledger=%D8%A7%D9%84%D9%85%D8%AF%D9%8A%D9%86%D8%A9" "/admin/money/report?ledger=%D9%85%D9%83%D8%A9" "/admin/money/cats" "/admin/dashboard"; do
  code=$(C -o /dev/null -w '%{http_code}' "http://localhost:$PORT$p")
  ok "$p" "$code" "200"
done
X=$(C -o /dev/null -w '%{http_code}' "http://localhost:$PORT/admin/money/report.xlsx")
ok "تصدير Excel" "$X" "200"

echo "── ١٠) الواجهة تعرض الدفترين والإقفال"
H=$(C http://localhost:$PORT/admin/money)
has "بطاقة دفتر المدينة" "$H" "دفتر المدينة"
has "بطاقة دفتر مكة" "$H" "دفتر مكة"
has "اليوم المالي معروض" "$H" "اليوم المالي الجاري"
has "قائمة الأيام المقفلة" "$H" "أيام مقفلة"
no "قفل يمنع حذف المفتوح" "$(echo "$H" | grep -A2 'بعد-الفجر')" "🔒"

echo
echo "════ ناجح: $pass · فاشل: $fail ════"
exit $fail
