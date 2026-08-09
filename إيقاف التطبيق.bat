@echo off
chcp 65001 >nul
title إيقاف التطبيق
echo إيقاف الخادم والنفق...
taskkill /f /im node.exe >nul 2>&1
taskkill /f /im cloudflared.exe >nul 2>&1
echo تم الإيقاف.
timeout /t 2 >nul
