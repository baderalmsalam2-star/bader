#!/bin/bash
# يشغّل كل ملفات الاختبار في هذا المجلد ويجمع النتيجة.
# لا يتوقف عند أول فشل — تُرى كل الأعطال في مرور واحد.
cd "$(dirname "$0")/.."
rc=0
for f in tests/*.sh; do
  [ "$(basename "$f")" = "run.sh" ] && continue
  echo; echo "═══ $(basename "$f") ═══"
  bash "$f" 2>&1 | grep -v 'ExperimentalWarning: SQLite\|--trace-warnings'
  [ "${PIPESTATUS[0]}" -eq 0 ] || rc=1
done
echo
[ $rc -eq 0 ] && echo "✅ كل الاختبارات ناجحة" || echo "❌ بعض الاختبارات فشلت"
exit $rc
