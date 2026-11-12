# 一键发布 Readly 新版本到 GitHub（Wlaina/readly，源码与安装包同一个仓库），已安装的 Readly 会自动收到更新
# 用法：powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#   - 版本号取自 src-tauri\tauri.conf.json（发布前先改好版本号）
#   - 更新说明写在 release\notes.md（第一行会显示在软件的更新提示里）
#   - 加 -SkipBuild 可跳过打包，直接上传 release 文件夹里已有的文件
#   - 发布前源码要先提交：脚本会给当前提交打上版本标签（例如 v0.8.3）并推送，Releases 里的每个版本都对应一份源码
param([switch]$SkipBuild)
# 打包工具会往错误流写普通日志，PowerShell 5.1 会误判为失败：这里只用退出码判断成败
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$repo = 'Wlaina/readly'
# 旧的安装包仓库：0.8.2 及以前的版本到这里检查更新。过渡期内把新版本也发一份过去，
# 让它们能升级到读新仓库的版本；过渡结束后改成 $false，旧仓库归档为只读（不要删，旧版本靠它兜底）
$legacyRepo = 'Wlaina/readly-releases'
$publishLegacy = $true
$gh = 'C:\Program Files\GitHub CLI\gh.exe'
$conf = Get-Content 'src-tauri\tauri.conf.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $conf.version
$tag = "v$ver"
$notesFile = 'release\notes.md'
if (-not (Test-Path $notesFile)) { throw "请先在 $notesFile 写好更新说明" }
$notes = (Get-Content $notesFile -Raw -Encoding UTF8).Trim()
Write-Host "== 发布 Readly $ver ==" -ForegroundColor Cyan

# 0. 源码检查：工作区必须干净（标签要对应真实发布的代码）
$dirty = git status --porcelain
if ($dirty) { throw "还有没提交的源码改动，请先提交再发布：`n$($dirty -join "`n")" }

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

# 4. 源码：推送当前提交，并打上版本标签
git push origin HEAD
if ($LASTEXITCODE) { throw '推送源码失败' }
git rev-parse -q --verify "refs/tags/$tag" *> $null
if ($LASTEXITCODE) {
  git tag -a $tag -m "Readly $ver"
  if ($LASTEXITCODE) { throw '打标签失败' }
}
git push origin $tag
if ($LASTEXITCODE) { throw '推送标签失败' }

# 5. 上传安装包与 latest.json（两个仓库里的 latest.json 都指向新仓库的安装包）
$assets = @($setup, "$setup.sig", 'release\Readly-arm64.apk', $latestPath)
function Publish-To($target, $useTag) {
  & $gh release view $tag --repo $target *> $null
  if ($LASTEXITCODE) {
    if ($useTag) { & $gh release create $tag @assets --repo $target --title "Readly $ver" --notes $notes --latest --verify-tag }
    else { & $gh release create $tag @assets --repo $target --title "Readly $ver" --notes $notes --latest }
  } else {
    & $gh release upload $tag @assets --repo $target --clobber
  }
  if ($LASTEXITCODE) { throw "上传到 $target 失败" }
  Write-Host "完成：https://github.com/$target/releases/tag/$tag" -ForegroundColor Green
}
Publish-To $repo $true
if ($publishLegacy) { Publish-To $legacyRepo $false }
# 明确以 0 退出：前面原生命令留下的非零退出码不应让整次发布显示为失败
exit 0
