@echo off
setlocal
chcp 65001 >nul
title Reels Studio - install
cd /d "%~dp0"

echo.
echo  REELS STUDIO - one-time install on this computer
echo  ------------------------------------------------
echo.

rem 1) Python 3.10+  (the "py" launcher comes with the installer from python.org)
set "PY="
where py >nul 2>nul && py -3 -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>nul && set "PY=py -3"
if not defined PY (
  python -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo  Python 3.10+ was not found. Installing it now...
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  where py >nul 2>nul && set "PY=py -3"
)
if not defined PY (
  echo.
  echo  Please install Python from https://www.python.org/downloads/
  echo  ^(tick "Add python.exe to PATH"^), then double-click this file again.
  start "" "https://www.python.org/downloads/"
  pause
  exit /b 1
)

rem 2) Private Python environment + packages
echo  [1/3] Preparing the Python environment...
if exist ".venv\pyvenv.cfg" (
  ".venv\Scripts\python.exe" -c "1" >nul 2>nul || rmdir /s /q ".venv"
)
if not exist ".venv\Scripts\python.exe" %PY% -m venv .venv || goto :fail
echo  [2/3] Installing packages (a minute or two)...
rem --use-feature=truststore: works behind antivirus HTTPS scanning (e.g. Avast) / company proxies
".venv\Scripts\python.exe" -m pip install --upgrade --quiet --use-feature=truststore pip
".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt || goto :fail

rem 3) Desktop shortcut
echo  [3/3] Creating the "Reels Studio" desktop shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut(\"$d\Reels Studio.lnk\");" ^
  "$s.TargetPath='%CD%\.venv\Scripts\pythonw.exe'; $s.Arguments='\"%CD%\tools\studio.py\"'; $s.WorkingDirectory='%CD%';" ^
  "$s.IconLocation='%CD%\panel\icon.ico'; $s.Description='Reels Studio: YouTube Shorts to Instagram Reels'; $s.Save()" || goto :fail

echo.
echo  Done! Starting Reels Studio...
start "" ".venv\Scripts\pythonw.exe" "tools\studio.py"
timeout /t 4 >nul
exit /b 0

:fail
echo.
echo  Something went wrong, see the messages above.
pause
exit /b 1
