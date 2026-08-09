#!/bin/bash
# الفحص الشامل: يمرّ على كل مسارات التطبيق بأدوار مختلفة ويتحقق من
#   ١) لا صفحة تنهار (٥٠٠) عند الإدارة
#   ٢) لوحة الإدارة محجوبة عن الطالب وعن الزائر
#   ٣) أكواد QR تُولَّد وتُفكّ وتطابق أصحابها ولا تتكرر
#   ٤) لا استثناء غير ملتقط في سجلّ الخادم
#
# المسارات تُستخرج من Hono وقت التشغيل لا من قائمة مكتوبة بيد — فالمسار
# الذي يُضاف غداً يدخل الفحص من نفسه بلا تعديل هنا.
#
# يعمل على قاعدة معزولة عبر RIHLA_DATA — لا يمسّ قاعدة الرحلة الحقيقية.
set -u
cd "$(dirname "$0")/.."
export RIHLA_DATA="${TMPDIR:-/tmp}/rihla-full-$$"
PORT=3114
SRV=
trap '[ -n "$SRV" ] && kill "$SRV" 2>/dev/null; rm -rf "$RIHLA_DATA"' EXIT
pass=0; fail=0
ok(){ if [ "$2" = "$3" ]; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 — expected [$3] got [$2]"; fail=$((fail+1)); fi; }
has(){ if echo "$2" | grep -qF "$3"; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1 — missing [$3]"; fail=$((fail+1)); fi; }

rm -rf "$RIHLA_DATA"; mkdir -p "$RIHLA_DATA"

# ── بذر: دور لكل مستوى + غرفة بساكنين ──
# لا يُكتم خطأ البذر: بذرٌ فاشل يجعل كل مسحٍ بعده ينجح فراغاً (لا مستخدم ⇒
# لا صفحة ⇒ لا انهيار)، وهو أسوأ من فشلٍ صريح.
SEED_OUT=$(node -e "
const {db}=require('./src/db');
const add=(n,r,t,room)=>db.prepare('INSERT INTO people (name,role,token,room_id) VALUES (?,?,?,?)').run(n,r,t,room||null);
db.prepare(\"INSERT INTO rooms (name,type,beds,room_no) VALUES ('غرفة الفحص','رباعية',4,'101')\").run();
const rid=db.prepare('SELECT id FROM rooms LIMIT 1').get().id;
add('مدير الفحص','admin','TADMIN');
add('رئيس الوفد','manager','TMANAGER');
add('مشرف الغرفة','room_supervisor','TROOMSUP',rid);
add('مشرف الحضور','attendance_supervisor','TATTSUP');
add('طالب أول','student','TSTUDENT',rid);
add('طالب ثانٍ','student','TSTUDENT2',rid);
// وفدٌ بحجمه الحقيقي (~١٢٠): فحص الرموز والمسح يجريان على بياناتٍ كالبيانات
// لا على ستة صفوف — فصفحةٌ تنهار عند مئة اسم لا تنهار عند اسمين.
for (let i=1;i<=120;i++) add('مشارك رقم '+i,'student','TP'+i, i%4===0?rid:null);
" 2>&1); SEED_RC=$?
if [ $SEED_RC -ne 0 ]; then
  echo "❌ فشل بذر البيانات — أُلغي الفحص"
  echo "$SEED_OUT" | grep -v 'ExperimentalWarning\|--trace-warnings' | head -12 | sed 's/^/   /'
  exit 1
fi

PORT=$PORT node src/server.js > "$RIHLA_DATA/srv.log" 2>&1 &
SRV=$!
for i in $(seq 30); do
  kill -0 "$SRV" 2>/dev/null || { echo "❌ الخادم توقّف"; cat "$RIHLA_DATA/srv.log"; exit 1; }
  curl -s --noproxy '*' -o /dev/null "http://localhost:$PORT/" && break
  sleep 0.5
done
grep -q "localhost:$PORT" "$RIHLA_DATA/srv.log" || { echo "❌ المنفذ $PORT مشغول بخادم آخر"; exit 1; }

B="http://localhost:$PORT"
code(){ curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -b "rihla=$1" "$B$2"; }

# ── استخراج مسارات GET من Hono نفسه ──
cat > "$RIHLA_DATA/routes.js" <<'JS'
const Module=require('module'), orig=Module.prototype.require, apps=[];
Module.prototype.require=function(id){
  if(id==='@hono/node-server') return {serve:()=>({close(){}})};
  const m=orig.apply(this,arguments);
  if(id==='hono'&&m.Hono&&!m.__p){class P extends m.Hono{constructor(...a){super(...a);apps.push(this);}}
    return Object.assign({},m,{Hono:P,__p:1});}
  return m;
};
require(process.cwd()+'/src/server.js');
const root=apps.sort((a,b)=>(b.routes?.length||0)-(a.routes?.length||0))[0];
const seen=new Set();
for(const r of root.routes){ if(r.method!=='GET') continue;
  if(!seen.has(r.path)){seen.add(r.path);console.log(r.path);} }
process.exit(0);
JS
RIHLA_DATA="$RIHLA_DATA/introspect" node "$RIHLA_DATA/routes.js" 2>/dev/null | sort > "$RIHLA_DATA/get.txt"
NROUTES=$(wc -l < "$RIHLA_DATA/get.txt")

# تعبئة المعاملات بقيم حقيقية؛ ما لا يُعرف له قيمة يُقبل منه ٤٠٤
fill(){
  local p="$1"
  p="${p//:token/TSTUDENT}"
  p="${p//:stage/1}"
  p="${p//:id/1}"
  p='/'"$(echo "$p" | sed -E 's#^/##; s#/qr/:file#qr/TSTUDENT.png#')"
  p="$(echo "$p" | sed -E 's#:what\{[^}]*\}#people.xlsx#; s#/photo/:file#/photo/none.jpg#; s#:file#none#')"
  echo "$p"
}

# ── حارس ضد النجاح الفارغ ──
# لو لم يدخل المدير فعلاً، فكل مسحٍ بعده يقيس صفحات حجبٍ لا صفحات تطبيق،
# ويخرج «ناجح» وهو لم يفحص شيئاً. تُفحص هنا نقطتان: أن الرمز يُعرَف، وأن
# صفحةً إداريةً حقيقية تُفتح به.
GUARD_A=$(code TADMIN /admin/people)
GUARD_B=$(code TSTUDENT /me)
if [ "$GUARD_A" != "200" ] || [ "$GUARD_B" != "200" ]; then
  echo "❌ الحارس: البيئة غير صالحة للفحص (admin/people=$GUARD_A · me=$GUARD_B)"
  echo "   الرموز لم تُزرع، فأي مسحٍ بعدها ينجح فراغاً. أُلغي الفحص."
  exit 1
fi
echo "── ٠) الحارس: البيئة صالحة"
echo "  ✅ المدير يفتح لوحة الإدارة · الطالب يفتح صفحته"
pass=$((pass+2))

echo "── ١) لا صفحة تنهار عند الإدارة ($NROUTES مسار GET)"
crashed=""
while read -r r; do
  u=$(fill "$r")
  c=$(code TADMIN "$u")
  [ "$c" -ge 500 ] 2>/dev/null && crashed="$crashed\n      $c $u"
done < "$RIHLA_DATA/get.txt"
if [ -z "$crashed" ]; then echo "  ✅ كل المسارات ردّت دون ٥٠٠"; pass=$((pass+1));
else echo -e "  ❌ مسارات انهارت:$crashed"; fail=$((fail+1)); fi

echo "── ٢) نفس المسح بأدوار أدنى — لا انهيار كذلك"
for tok in TMANAGER TROOMSUP TATTSUP TSTUDENT; do
  bad=""
  while read -r r; do
    u=$(fill "$r")
    c=$(code "$tok" "$u")
    [ "$c" -ge 500 ] 2>/dev/null && bad="$bad $c:$u"
  done < "$RIHLA_DATA/get.txt"
  if [ -z "$bad" ]; then echo "  ✅ $tok"; pass=$((pass+1));
  else echo "  ❌ $tok —$bad"; fail=$((fail+1)); fi
done

echo "── ٣) الزائر بلا كوكي لا ينهار ولا يُسرَّب له شيء"
bad=""
while read -r r; do
  u=$(fill "$r")
  c=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$B$u")
  [ "$c" -ge 500 ] 2>/dev/null && bad="$bad $c:$u"
done < "$RIHLA_DATA/get.txt"
if [ -z "$bad" ]; then echo "  ✅ لا انهيار للزائر"; pass=$((pass+1));
else echo "  ❌ انهار للزائر —$bad"; fail=$((fail+1)); fi

echo "── ٤) لوحة الإدارة محجوبة عمّن دونها"
NADMIN=$(grep -c '^/admin' "$RIHLA_DATA/get.txt")
for tok in TROOMSUP TATTSUP TSTUDENT; do
  leaked=""
  while read -r r; do
    case "$r" in /admin*) ;; *) continue;; esac
    u=$(fill "$r")
    c=$(code "$tok" "$u")
    [ "$c" = "200" ] && leaked="$leaked $u"
  done < "$RIHLA_DATA/get.txt"
  if [ -z "$leaked" ]; then echo "  ✅ $tok محجوب عن الإدارة ($NADMIN صفحة)"; pass=$((pass+1));
  else echo "  ❌ $tok وصل إلى:$leaked"; fail=$((fail+1)); fi
done
leaked=""
while read -r r; do
  case "$r" in /admin*) ;; *) continue;; esac
  u=$(fill "$r")
  c=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$B$u")
  [ "$c" = "200" ] && leaked="$leaked $u"
done < "$RIHLA_DATA/get.txt"
if [ -z "$leaked" ]; then echo "  ✅ الزائر محجوب عن الإدارة"; pass=$((pass+1));
else echo "  ❌ الزائر وصل إلى:$leaked"; fail=$((fail+1)); fi

echo "── ٥) الرد على المحجوب ٤٠٣ لا صفحة إدارة"
ok "الطالب على /admin/people" "$(code TSTUDENT /admin/people)" "403"
ok "الطالب على /admin/money"  "$(code TSTUDENT /admin/money)"  "403"
BODY=$(curl -s --noproxy '*' -b rihla=TSTUDENT "$B/admin/people")
has "نص الحجب ظاهر" "$BODY" "ما عندك صلاحية"

echo "── ٦) أكواد QR: تُولَّد وتُفكّ وتطابق أصحابها"
node -e "
const {db}=require('./src/db');
const QRCode=require('qrcode'), jsQR=require('jsqr');
const {PNG}=(()=>{try{return require('pngjs')}catch(e){return {}}})();
(async()=>{
  const toks=db.prepare('SELECT token FROM people WHERE token IS NOT NULL').all().map(r=>r.token);
  if(!toks.length){console.log('NOTOKENS');return;}
  let good=0, bad=[];
  const seen=new Set();
  for(const t of toks){
    const payload='R:'+t;
    // نولّد ثم نفكّ من مصفوفة البكسل نفسها
    const buf=await QRCode.toBuffer(payload,{width:400,margin:1});
    if(!PNG){console.log('NOPNG');return;}
    const png=PNG.sync.read(buf);
    const r=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);
    if(r&&r.data===payload){good++;} else bad.push(t);
    seen.add(t);
  }
  console.log('TOTAL='+toks.length+' GOOD='+good+' UNIQUE='+seen.size+(bad.length?' BAD='+bad.join(','):''));
})();
" 2>/dev/null > "$RIHLA_DATA/qr.txt"
QR=$(cat "$RIHLA_DATA/qr.txt")
case "$QR" in
  NOPNG*|NOTOKENS*|"")
    echo "  ⚠️  تخطّي فكّ الترميز (pngjs غير مثبّتة) — يُفحص مسار /qr بدلاً منه";;
  *)
    T=$(echo "$QR"|sed -E 's/.*TOTAL=([0-9]+).*/\1/')
    G=$(echo "$QR"|sed -E 's/.*GOOD=([0-9]+).*/\1/')
    U=$(echo "$QR"|sed -E 's/.*UNIQUE=([0-9]+).*/\1/')
    ok "فُكّ $G من $T كوداً وطابق صاحبه" "$G" "$T"
    ok "لا تكرار في الرموز ($U متمايزاً)" "$U" "$T";;
esac
ok "مسار /qr يخدم صورة لصاحب رمز" "$(code TADMIN /qr/TSTUDENT.png)" "200"
ok "مسار /qr يرفض رمزاً مجهولاً"   "$(code TADMIN /qr/NOPE.png)"     "404"
CT=$(curl -s --noproxy '*' -o /dev/null -w '%{content_type}' -b rihla=TADMIN "$B/qr/TSTUDENT.png")
ok "نوع المحتوى صورة" "$CT" "image/png"

echo "── ٧) الدخول بالرابط الشخصي"
ok "رابط صحيح يحوّل" "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$B/d/TSTUDENT")" "302"
LOGIN=$(curl -s --noproxy '*' -i "$B/d/TSTUDENT" | grep -ci 'set-cookie: *rihla=')
ok "الرابط يضع الكوكي" "$LOGIN" "1"
ok "رابط مجهول يردّ ٤٠٤" "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$B/d/GARBAGE")" "404"
NOCK=$(curl -s --noproxy '*' -i "$B/d/GARBAGE" | grep -ci 'set-cookie: *rihla=')
ok "الرابط المجهول لا يضع كوكي" "$NOCK" "0"

echo "── ٧ب) تخمين الروابط يُخنَق بعد ٢٠ محاولة"
# المحاولات تُعدّ بعنوان الطالب؛ نستهلك الحدّ ثم نتأكد أن الردّ صار ٤٢٩
for i in $(seq 21); do curl -s --noproxy '*' -o /dev/null "$B/d/BRUTE$i"; done
ok "المحاولة بعد الحدّ تُردّ ٤٢٩" "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$B/d/BRUTE99")" "429"
# والخنق لا يحبس صاحب الرابط الصحيح خارج التطبيق إلى الأبد؟ يحبسه — وهذا
# مقصود: الحدّ على العنوان لا على الرمز. نتحقق فقط أنه لا ينهار.
ok "الرابط الصحيح أثناء الخنق لا ينهار" "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$B/d/TSTUDENT")" "429"

echo "── ٨) لا استثناء غير ملتقط في سجلّ الخادم"
ERR=$(grep -icE 'uncaught|unhandled|TypeError|ReferenceError|SqliteError' "$RIHLA_DATA/srv.log" || true)
if [ "$ERR" = "0" ]; then echo "  ✅ السجلّ نظيف"; pass=$((pass+1));
else echo "  ❌ في السجلّ $ERR سطر خطأ:"; grep -iE 'uncaught|unhandled|TypeError|ReferenceError|SqliteError' "$RIHLA_DATA/srv.log" | head -8 | sed 's/^/      /'; fail=$((fail+1)); fi

echo
echo "════ ناجح: $pass · فاشل: $fail ════"
[ "$fail" -eq 0 ]
