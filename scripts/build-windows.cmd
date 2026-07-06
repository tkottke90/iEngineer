@echo off
setlocal EnableDelayedExpansion
REM ============================================================================
REM  Build the iRacing Engineer Tauri client NATIVELY on Windows, WITH
REM  push-to-talk STT (whisper.cpp + Vulkan). Produces a runnable exe with the
REM  frontend embedded (custom-protocol).
REM
REM  RUN FROM: "x64 Native Tools Command Prompt for VS 2022" (Developer Command
REM  Prompt) so the MSVC toolchain (cl.exe, link.exe, Windows SDK) is on PATH.
REM  From the repo root:
REM      scripts\build-windows.cmd            (release, default)
REM      scripts\build-windows.cmd --debug    (faster compile, larger exe)
REM
REM  Prerequisites (install once):
REM    - Rust (https://rustup.rs) with the default x86_64-pc-windows-msvc toolchain
REM    - Visual Studio Build Tools 2022 (Desktop C++ workload)  -> cl.exe, link.exe
REM    - CMake (https://cmake.org)  -> on PATH  (whisper.cpp builds via cmake)
REM    - LunarG Vulkan SDK (https://vulkan.lunarg.com)  -> sets VULKAN_SDK
REM    - Node.js LTS  -> npm
REM    - (optional) LLVM/Clang  -> better whisper bindings; falls back to bundled
REM ============================================================================

REM ── Resolve repo root (this script lives in <root>\scripts) ─────────────────
pushd "%~dp0.." || (echo ERROR: cannot locate repo root & exit /b 1)
set "REPO_ROOT=%CD%"
popd

set "PROFILE=release"
set "PROFILE_FLAG=--release"
if /I "%~1"=="--debug" (
  set "PROFILE=debug"
  set "PROFILE_FLAG="
  echo [i] Debug build selected ^(faster compile, larger exe^)
)

set "SRC_TAURI=%REPO_ROOT%\apps\tauri-client\src-tauri"
set "EXE=%SRC_TAURI%\target\%PROFILE%\iracing-engineer.exe"
set "MODEL=%SRC_TAURI%\models\ggml-base.en.bin"

echo.
echo === Checking prerequisites ===
where cargo >nul 2>&1 || (echo ERROR: cargo not found. Install Rust from https://rustup.rs & goto :fail)
where npm   >nul 2>&1 || (echo ERROR: npm not found. Install Node.js LTS. & goto :fail)
where cmake >nul 2>&1 || (echo ERROR: cmake not found. Install CMake and add it to PATH. & goto :fail)
if "%VULKAN_SDK%"=="" (
  echo ERROR: VULKAN_SDK is not set. Install the LunarG Vulkan SDK, then open a NEW
  echo        shell so the environment variable takes effect.
  goto :fail
)
where cl >nul 2>&1 || echo [!] cl.exe not on PATH - if the build fails compiling whisper.cpp, launch the "x64 Native Tools Command Prompt for VS 2022" and re-run.
echo   cargo, npm, cmake OK
echo   VULKAN_SDK = %VULKAN_SDK%

if not exist "%MODEL%" (
  echo.
  echo [!] Whisper model missing at: %MODEL%
  echo     STT loads it at runtime; download it once with:
  echo       curl -L -o "%MODEL%" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  echo     ^(or set WHISPER_MODEL_PATH to an existing copy^)
)

echo.
echo === Installing workspace dependencies ^(npm^) ===
cd /d "%REPO_ROOT%" || goto :fail
call npm install || goto :fail

REM Verify the workspace links exist and are valid (checking a real file THROUGH the
REM junction catches a broken link, e.g. a node_modules copied from macOS). If not,
REM do a clean reinstall so npm recreates the Windows junctions.
if not exist "%REPO_ROOT%\node_modules\@iracing-engineer\types\package.json" (
  echo [!] Workspace link node_modules\@iracing-engineer\types is missing or broken.
  echo     Doing a clean reinstall ^(removing node_modules^)...
  if exist "%REPO_ROOT%\node_modules" rmdir /s /q "%REPO_ROOT%\node_modules"
  call npm install || goto :fail
)
if not exist "%REPO_ROOT%\node_modules\@iracing-engineer\types\package.json" (
  echo [!] npm did not create the @iracing-engineer workspace links - creating them
  echo     manually with mklink /J ^(junctions; no admin needed^)...
  if not exist "%REPO_ROOT%\node_modules\@iracing-engineer" mkdir "%REPO_ROOT%\node_modules\@iracing-engineer"
  REM Remove any empty placeholder/broken link npm left (plain rmdir removes only the
  REM junction/empty dir - it does NOT touch the link target's contents).
  rmdir "%REPO_ROOT%\node_modules\@iracing-engineer\types" 2>nul
  rmdir "%REPO_ROOT%\node_modules\@iracing-engineer\ui" 2>nul
  rmdir "%REPO_ROOT%\node_modules\@iracing-engineer\tauri-client" 2>nul
  mklink /J "%REPO_ROOT%\node_modules\@iracing-engineer\types" "%REPO_ROOT%\packages\types"
  mklink /J "%REPO_ROOT%\node_modules\@iracing-engineer\ui" "%REPO_ROOT%\packages\ui"
  mklink /J "%REPO_ROOT%\node_modules\@iracing-engineer\tauri-client" "%REPO_ROOT%\apps\tauri-client"
)
if not exist "%REPO_ROOT%\node_modules\@iracing-engineer\types\package.json" (
  echo.
  echo ERROR: could not link the @iracing-engineer workspace packages.
  echo Look at the mklink output just above for the real cause. Common ones:
  echo   - "Cannot create a file when that file already exists" -^> a leftover dir;
  echo     delete node_modules\@iracing-engineer and re-run.
  echo   - "You do not have sufficient privilege" / policy-blocked -^> mklink is
  echo     restricted; enable Windows Developer Mode, or run this from an elevated shell.
  echo   - "The system cannot find the path specified" -^> confirm packages\types exists
  echo     ^(are you in the repo ROOT?^).
  goto :fail
)

echo.
echo === Building workspace packages ^(types, then ui^) ===
REM The Tauri frontend imports @iracing-engineer/types and @iracing-engineer/ui,
REM which resolve to their built dist/ output. Build them first (ui depends on types).
call npm run build -w packages/types || goto :fail
call npm run build -w packages/ui || goto :fail

echo.
echo === Building frontend ^(vite^) ===
cd /d "%REPO_ROOT%\apps\tauri-client" || goto :fail
call npm run build || goto :fail

echo.
echo === Building Windows binary ^(custom-protocol + stt / Vulkan^) ===
echo     This compiles whisper.cpp on the first run - it can take several minutes.
cd /d "%SRC_TAURI%" || goto :fail
cargo build %PROFILE_FLAG% --features "custom-protocol stt" || goto :fail

echo.
if not exist "%EXE%" (
  echo ERROR: expected exe not found at:
  echo   %EXE%
  goto :fail
)
echo === Done ===
echo Built: %EXE%
for %%A in ("%EXE%") do echo Size:  %%~zA bytes
echo.
echo Run it directly, or copy it to the racing rig. Ensure ggml-base.en.bin sits
echo next to it under a "models\" folder, or set WHISPER_MODEL_PATH.
endlocal
exit /b 0

:fail
echo.
echo *** BUILD FAILED ***  See the error above.
echo If it failed compiling whisper.cpp, the usual causes are: not running from the
echo VS Native Tools prompt, VULKAN_SDK unset, or CMake missing from PATH.
endlocal
exit /b 1
