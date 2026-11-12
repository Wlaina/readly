# 一键发布 Readly 新版本到 GitHub（Wlaina/readly-releases），已安装的 Readly 会自动收到更新
# 用法：powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#   - 版本号取自 src-tauri\tauri.conf.json（发布前先改好版本号）
#   - 更新说明写在 release\notes.md（第一行会显示在软件的更新提示里）
#   - 加 -SkipBuild 可跳过打包，直接上传 release 文件夹里已有的文件
param([switch]$SkipBuild)
# 打包工具会往错误流写普通日志，PowerShell 5.1 会误判为失败：这里只用退出码判断成败
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$repo = 'Wlaina/readly-releases'
$gh = 'C:\Program Files\GitHub CLI\gh.exe'
$conf = Get-Content 'src-tauri\tauri.conf.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $conf.version
$tag = "v$ver"
$notesFile = 'release\notes.md'
if (-not (Test-Path $notesFile)) { throw "请先在 $notesFile 写好更新说明" }
$notes = (Get-Content $notesFile -Raw -Encoding UTF8).Trim()
Write-Host "== 发布 Readly $ver ==" -ForegroundColor Cyan

# 更新包签名：私钥只在本机 keystore 文件夹里，务必备份
$env:TAURI_SIGNING_PRIVATE_KEY = Join-Path $root 'keystore\updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''

$setupName = "Readly_${ver}_x64-setup.exe"
$setup = "src-tauri\target\release\bundle\nsis\$setupName"

if (-not $SkipBuild) {
  # 1. Windows：安装包 + 签名文件（.sig）+ 便携版
  npx tauri build --bundles nsis
  if ($LASTEXITCODE) { throw 'Windows 打包失败' }
  Copy-Item $setup "release\Readly-$ver-setup.exe" -Force
  Copy-Item 'src-tauri\target\release\readly.exe' 'release\Readly.exe' -Force
  # 2. 安卓 APK
  powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1
  if ($LASTEXITCODE) { throw '安卓打包失败' }
}
if (-not (Test-Path "$setup.sig")) { throw "缺少签名文件 $setup.sig（打包时没有读到签名私钥？）" }

# 3. 生成 latest.json：Windows 由 Tauri 更新插件读取，安卓由 Readly 自己读取
$base = "https://github.com/$repo/releases/download/$tag"
$latest = [ordered]@{
  version   = $ver
  notes     = $notes
  pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = [ordered]@{
    'windows-x86_64'  = [ordered]@{ signature = (Get-Content "$setup.sig" -Raw).Trim(); url = "$base/$setupName" }
    'android-aarch64' = [ordered]@{ signature = ''; url = "$base/Readly-arm64.apk" }  # Windows 更新插件要求每个平台都有 signature 字段，安卓不用它，留空即可
  }
}
$latestPath = 'release\latest.json'
[IO.File]::WriteAllText((Join-Path $root $latestPath), ($latest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

# 校验：Windows 更新插件要求每个平台都有 signature 和 url，缺一个整份文件都会被拒绝
$check = Get-Content $latestPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($p in $check.platforms.PSObject.Properties) {
  if ($null -eq $p.Value.signature -or -not $p.Value.url) { throw "latest.json 校验失败：$($p.Name) 缺少 signature 或 url" }
}
if (-not $check.platforms.'windows-x86_64'.signature) { throw 'latest.json 校验失败：Windows 签名为空' }
Write-Host 'latest.json 校验通过' -ForegroundColor Green

# 4. 上传到 GitHub（仓库不存在时自动创建为公开仓库，只放安装包）
& $gh repo view $repo *> $null
if ($LASTEXITCODE) {
  & $gh repo create $repo --public --add-readme --description 'Readly 电子书阅读器的安装包与自动更新（源码不在这里）'
  if ($LASTEXITCODE) { throw '创建仓库失败' }
}
$assets = @($setup, "$setup.sig", 'release\Readly-arm64.apk', $latestPath)
& $gh release view $tag --repo $repo *> $null
if ($LASTEXITCODE) {
  & $gh release create $tag @assets --repo $repo --title "Readly $ver" --notes $notes --latest
} else {
  & $gh release upload $tag @assets --repo $repo --clobber
}
if ($LASTEXITCODE) { throw '上传失败' }
Write-Host "完成：https://github.com/$repo/releases/tag/$tag" -ForegroundColor Green
# 明确以 0 退出：前面原生命令留下的非零退出码不应让整次发布显示为失败
exit 0
