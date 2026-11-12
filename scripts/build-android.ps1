# 一键打包 Readly 安卓 APK（arm64），复用 D:\Android 里已有的 SDK / JDK
# 用法：powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$env:JAVA_HOME = 'D:\Android\jdk-17.0.21+9'
$env:ANDROID_HOME = 'D:\Android\sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$ndk = Get-ChildItem "$env:ANDROID_HOME\ndk" -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $ndk) { throw "未找到 NDK，请先安装：sdkmanager `"ndk;28.2.13676358`"" }
$env:NDK_HOME = $ndk.FullName
$env:Path = "$env:JAVA_HOME\bin;" + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

Set-Location $root

# 收尾：结束本次打包可能留下的 Gradle / Kotlin 守护进程（它们会占着输出管道，让终端一直显示“运行中”）
function Stop-BuildDaemons {
  Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'GradleDaemon|KotlinCompileDaemon|kotlin-daemon' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# 首次运行：生成安卓工程
if (-not (Test-Path 'src-tauri\gen\android')) {
  npx tauri android init --ci
  if ($LASTEXITCODE) { throw 'tauri android init 失败' }
}

$start = Get-Date
$so = 'src-tauri\target\aarch64-linux-android\release\libreadly_lib.so'
$jni = 'src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a'

# 1. 编译前端 + Rust。未开 Windows 开发者模式时，最后一步“创建符号链接”会失败，忽略即可
$ErrorActionPreference = 'Continue'
npx tauri android build --apk --target aarch64
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $so) -or (Get-Item $so).LastWriteTime -lt $start.AddSeconds(-5)) {
  # cargo 没有重新编译（代码未变）也没关系，只要 .so 存在
  if (-not (Test-Path $so)) { throw 'Rust 编译失败，没有生成 libreadly_lib.so' }
}

# 2. 手动复制 .so（代替符号链接）
New-Item -ItemType Directory -Force $jni | Out-Null
$link = Join-Path $jni 'libreadly_lib.so'
if (Test-Path $link) { Remove-Item $link -Force }
Copy-Item $so $link

# 3. 直接调用 Gradle，跳过其中重复的 Rust 编译
$env:READLY_SKIP_RUST = '1'
Push-Location 'src-tauri\gen\android'
# --no-daemon：打包完就退出，不留后台进程占着输出（否则调用方会一直等）
.\gradlew.bat --no-daemon assembleArm64Release -PtargetList=aarch64 -PabiList=arm64-v8a -ParchList=arm64
$code = $LASTEXITCODE
Pop-Location
if ($code) { Stop-BuildDaemons; throw 'Gradle 打包失败' }

$unsigned = Get-ChildItem 'src-tauri\gen\android\app\build\outputs\apk' -Recurse -Filter '*arm64-release-unsigned.apk' | Select-Object -First 1
if (-not $unsigned) { throw '没找到 release APK' }

# 签名：首次自动生成专用 keystore（请妥善保管，换签名后手机需卸载重装）
$ksDir = Join-Path $root 'keystore'
$ks = Join-Path $ksDir 'readly.jks'
$pwFile = Join-Path $ksDir 'password.txt'
if (-not (Test-Path $ks)) {
  New-Item -ItemType Directory -Force $ksDir | Out-Null
  $pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  Set-Content -Path $pwFile -Value $pw -Encoding ascii -NoNewline
  keytool -genkeypair -v -keystore $ks -alias readly -keyalg RSA -keysize 2048 -validity 36500 `
    -storepass $pw -keypass $pw -dname 'CN=Readly, OU=Personal, O=Readly, C=CN' | Out-Null
}
$pw = (Get-Content $pwFile -Raw).Trim()

$bt = Get-ChildItem "$env:ANDROID_HOME\build-tools" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$out = Join-Path $root 'release'
New-Item -ItemType Directory -Force $out | Out-Null
$aligned = Join-Path $out 'readly-aligned.apk'
$final = Join-Path $out 'Readly-arm64.apk'
& "$($bt.FullName)\zipalign.exe" -f -p 4 $unsigned.FullName $aligned
& "$($bt.FullName)\apksigner.bat" sign --ks $ks --ks-key-alias readly --ks-pass "pass:$pw" --key-pass "pass:$pw" --out $final $aligned
Remove-Item $aligned
& "$($bt.FullName)\apksigner.bat" verify $final
Stop-BuildDaemons
Write-Host "完成：$final"
