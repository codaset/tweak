@echo off
rem Codaset Tweak launcher for Windows: the counterpart of bin/tweak (see
rem docs/design.md, "The launcher"). It runs the tweak binary for this plugin
rem version, downloading it from the GitHub Release on first run with the
rem PowerShell at the end of this file. The release workflow stamps VERSION.
rem Build-only in v1: Windows is untested. Keep CRLF line endings (.gitattributes):
rem cmd misreads labels in a file with LF endings.
setlocal
set "VERSION=0.1.0"

rem Working on Tweak itself: run a local build and skip any download.
if defined TWEAK_BIN goto local

rem TWEAK_STATE_DIR moves the whole state folder.
set "TWEAK_LAUNCH_STATE=%USERPROFILE%\.local\state\codaset-tweak"
if defined TWEAK_STATE_DIR set "TWEAK_LAUNCH_STATE=%TWEAK_STATE_DIR%"
set "TWEAK_LAUNCH_KEPT=%TWEAK_LAUNCH_STATE%\bin\%VERSION%\tweak.exe"
if exist "%TWEAK_LAUNCH_KEPT%" goto run

rem A hook before the first download has nothing to do: no bridge has run,
rem so nothing is capturing. It never downloads, prints or fails an edit.
if /i "%~1"=="hook" exit /b 0

set "TWEAK_LAUNCH_SELF=%~f0"
set "TWEAK_LAUNCH_HERE=%~dp0"
set "TWEAK_LAUNCH_VERSION=%VERSION%"
powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$s = Get-Content -LiteralPath $env:TWEAK_LAUNCH_SELF -Raw; Invoke-Expression ($s -split '(?m)^#=+ PowerShell\r?$')[1]"
if errorlevel 1 exit /b 1

:run
"%TWEAK_LAUNCH_KEPT%" %*
exit /b %ERRORLEVEL%

:local
"%TWEAK_BIN%" %*
exit /b %ERRORLEVEL%

#============================== PowerShell
# Downloads tweak-windows-amd64.exe into the version folder, checks its SHA-256
# against checksums.txt beside this launcher, and renames it into place. Prints
# one line on stderr and exits 1 on any failure.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 may not offer TLS 1.2, which github.com requires.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$version = $env:TWEAK_LAUNCH_VERSION
$kept = $env:TWEAK_LAUNCH_KEPT
$dir = Split-Path -Parent $kept
$name = 'tweak-windows-amd64.exe'
$sums = Join-Path $env:TWEAK_LAUNCH_HERE 'checksums.txt'

function Fail([string]$reason) {
  [Console]::Error.WriteLine("couldn't download tweak $version ($reason): check your connection and run the command again")
  exit 1
}

$want = $null
if (Test-Path -LiteralPath $sums) {
  foreach ($line in Get-Content -LiteralPath $sums) {
    $fields = -split $line
    if ($fields.Count -ge 2 -and ($fields[1] -ceq $name -or $fields[1] -ceq "*$name")) {
      $want = $fields[0]
      break
    }
  }
}
if (-not $want) { Fail "no checksum for $name in $sums" }

try { New-Item -ItemType Directory -Force -Path $dir | Out-Null } catch { Fail "can't create $dir" }

# Each launcher downloads to its own file in the same folder, so the rename into
# place is atomic and two sessions fetching at once are safe.
$tmp = Join-Path $dir ".tweak.$PID.download"
# TWEAK_TEST_DOWNLOAD_URL is for the launchers' tests only: it stands in for the
# GitHub Releases download URL.
$base = if ($env:TWEAK_TEST_DOWNLOAD_URL) { $env:TWEAK_TEST_DOWNLOAD_URL } else { 'https://github.com/codaset/tweak/releases/download' }
$url = "$base/v$version/$name"
try {
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tmp
} catch {
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  Fail ((($_.Exception.Message -split '\r?\n')[0]) + " for $url")
}

# -ne compares case-insensitively; Get-FileHash returns uppercase hex.
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash -ne $want) {
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  Fail "checksum mismatch for $name, download deleted"
}

try {
  Move-Item -LiteralPath $tmp -Destination $kept -Force
} catch {
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  # Another launcher won the race and its binary may be running already.
  if (-not (Test-Path -LiteralPath $kept)) { Fail "can't move the download to $kept" }
}
exit 0
