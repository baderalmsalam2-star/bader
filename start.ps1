$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$Host.UI.RawUI.WindowTitle = "رحلة المدينة النبوية - تشغيل التطبيق"

Write-Host "============================================" -ForegroundColor Green
Write-Host "  تشغيل تطبيق رحلة المدينة النبوية" -ForegroundColor Green
Write-Host "============================================"
Write-Host ""
Write-Host "لا تُغلق هذه النافذة أثناء استخدام التطبيق."
Write-Host ""

Write-Host "[1/2] تشغيل الخادم المحلي..." -ForegroundColor Cyan
$serverLog = Join-Path $root "server.log"
$serverProc = Start-Process -FilePath "node" -ArgumentList "src\server.js" `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $root "server-err.log")

Start-Sleep -Seconds 2

$ok = $false
for ($i = 0; $i -lt 10; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3000/" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { Start-Sleep -Seconds 1 }
}

if (-not $ok) {
  Write-Host ""
  Write-Host "تعذّر تشغيل الخادم. راجع server-err.log" -ForegroundColor Red
  Get-Content (Join-Path $root "server-err.log") -Tail 20 -ErrorAction SilentlyContinue
  Read-Host "اضغط Enter للإغلاق"
  exit 1
}

Write-Host "الخادم يعمل بنجاح (PID $($serverProc.Id))." -ForegroundColor Green
Write-Host ""
Write-Host "[2/2] فتح رابط عام (Cloudflare)..." -ForegroundColor Cyan
Write-Host ""
Write-Host "============================================" -ForegroundColor Yellow
Write-Host "  انتظر ظهور رابط ينتهي بـ trycloudflare.com" -ForegroundColor Yellow
Write-Host "  وهو الرابط الذي تفتحه من أي جهاز" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Yellow
Write-Host ""

try {
  & "$root\cloudflared.exe" tunnel --url http://localhost:3000 --no-autoupdate
} finally {
  Write-Host ""
  Write-Host "تم إيقاف النفق — إيقاف الخادم أيضاً..." -ForegroundColor Yellow
  Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
  Read-Host "اضغط Enter للإغلاق"
}

