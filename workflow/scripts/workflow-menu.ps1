param(
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$EnvPath = Join-Path $ProjectRoot ".env"
$EnvExamplePath = Join-Path $ProjectRoot ".env.example"
$EnvBackupRoot = Join-Path $ProjectRoot ".env.backups"
$LogRoot = Join-Path $ProjectRoot "logs"
$ConsoleLogPath = Join-Path $LogRoot "workflow-console.log"
$FaqPath = Join-Path $ProjectRoot "docs\workflow-faq.json"
$WikiUrl = "https://example.com/documentation"

function Write-Title([string]$Text) {
  Write-Host ""
  Write-Host ("=" * 66) -ForegroundColor DarkCyan
  Write-Host "  $Text" -ForegroundColor Cyan
  Write-Host ("=" * 66) -ForegroundColor DarkCyan
}

function Wait-Menu {
  Write-Host ""
  [void](Read-Host "按回车键返回")
}

function Ensure-Env {
  if (Test-Path -LiteralPath $EnvPath) { return $true }
  if (-not (Test-Path -LiteralPath $EnvExamplePath)) {
    Write-Host "找不到 .env.example，无法创建配置。" -ForegroundColor Red
    return $false
  }
  Copy-Item -LiteralPath $EnvExamplePath -Destination $EnvPath
  Write-Host "已从 .env.example 创建 .env。" -ForegroundColor Green
  return $true
}

function Backup-Env {
  if (-not (Test-Path -LiteralPath $EnvPath)) { return $null }
  New-Item -ItemType Directory -Force -Path $EnvBackupRoot | Out-Null
  $target = Join-Path $EnvBackupRoot ("env-{0}.bak" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"))
  Copy-Item -LiteralPath $EnvPath -Destination $target
  return $target
}

function Get-EnvMap {
  $map = [ordered]@{}
  if (-not (Test-Path -LiteralPath $EnvPath)) { return $map }
  foreach ($line in [IO.File]::ReadAllLines($EnvPath, [Text.Encoding]::UTF8)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $map[$matches[1]] = $matches[2]
    }
  }
  return $map
}

function Set-EnvValue([string]$Key, [string]$Value) {
  if (-not (Ensure-Env)) { return }
  if ($Value -match "[`r`n]") { throw "环境变量不能包含换行。" }
  $backup = Backup-Env
  $lines = [Collections.Generic.List[string]]::new()
  $lines.AddRange([string[]][IO.File]::ReadAllLines($EnvPath, [Text.Encoding]::UTF8))
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i += 1) {
    if ($lines[$i] -match ("^\s*" + [regex]::Escape($Key) + "\s*=")) {
      $lines[$i] = "$Key=$Value"
      $found = $true
      break
    }
  }
  if (-not $found) { $lines.Add("$Key=$Value") }
  [IO.File]::WriteAllLines($EnvPath, $lines, [Text.UTF8Encoding]::new($false))
  Write-Host "已更新 $Key。修改前配置已备份到：$backup" -ForegroundColor Green
}

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Mask-Value([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "未配置" }
  return "已配置（已隐藏）"
}

function Protect-LogText([string]$Text) {
  if ($null -eq $Text) { return '' }
  $safe = [string]$Text
  $envMap = Get-EnvMap
  foreach ($key in @('MIMO_API_KEY','FEISHU_APP_SECRET','FEISHU_APP_ID','OPENAI_API_KEY','ACCESS_TOKEN','REFRESH_TOKEN','TENANT_ACCESS_TOKEN','AUTHORIZATION','COOKIE')) {
    $value = [string]$envMap[$key]
    if ($value.Length -ge 4) { $safe = $safe.Replace($value, '[REDACTED]') }
  }
  $safe = [regex]::Replace($safe, '(?i)\bBearer\s+[A-Za-z0-9._~+\-/]+=*', 'Bearer [REDACTED]')
  $safe = [regex]::Replace($safe, '(?im)\b(MIMO_API_KEY|FEISHU_APP_SECRET|OPENAI_API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|TENANT_ACCESS_TOKEN|AUTHORIZATION|COOKIE)\s*[=:]\s*([^\s,;]+)', '$1=[REDACTED]')
  $safe = [regex]::Replace($safe, '(?i)\bsk-[A-Za-z0-9_-]{12,}', '[REDACTED_API_KEY]')
  return $safe
}

function Write-SafeLog([string]$Text) {
  if (-not (Test-Path -LiteralPath $LogRoot)) { New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null }
  $line = "[$([DateTimeOffset]::Now.ToString('o'))] $(Protect-LogText $Text)"
  [IO.File]::AppendAllText($ConsoleLogPath, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Show-ConfigStatus {
  Write-Title "配置状态（敏感值已遮罩）"
  if (-not (Test-Path -LiteralPath $EnvPath)) {
    Write-Host ".env：未创建" -ForegroundColor Yellow
    return
  }
  $envMap = Get-EnvMap
  Write-Host ".env：已存在"
  Write-Host "Mimo API Key：$(Mask-Value $envMap['MIMO_API_KEY'])"
  Write-Host "Mimo 模型：$($envMap['MIMO_MODEL'])"
  Write-Host "飞书 App ID：$(Mask-Value $envMap['FEISHU_APP_ID'])"
  Write-Host "飞书 App Secret：$(Mask-Value $envMap['FEISHU_APP_SECRET'])"
  $real = $envMap['FEISHU_ENABLE_REAL_API'] -eq '1' -and $envMap['FEISHU_DRY_RUN'] -eq '0'
  if ($real) { Write-Host "飞书模式：真实 API（已开启）" -ForegroundColor Red }
  else { Write-Host "飞书模式：安全 / Dry-run" -ForegroundColor Green }
  Write-Host "ChatGPT 专用登录态：$(if (Test-Path -LiteralPath (Join-Path $ProjectRoot '.chrome-chatgpt-debug-profile')) {'已创建'} else {'未创建'})"
}

function Invoke-Npm([string[]]$Arguments) {
  Write-Host ""
  Write-Host ("执行：npm.cmd " + ($Arguments -join " ")) -ForegroundColor DarkGray
  Write-SafeLog ("COMMAND npm.cmd " + ($Arguments -join " "))
  Push-Location $ProjectRoot
  try {
    & npm.cmd @Arguments 2>&1 | ForEach-Object {
      $line = [string]$_
      Write-Host $line
      Write-SafeLog $line
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      $message = "命令失败，退出码：$exitCode"
      Write-SafeLog "ERROR $message"
      Write-Host $message -ForegroundColor Red
      Write-Host "可在“诊断与自检”中一键导出报错。" -ForegroundColor Yellow
    }
    return
  } catch {
    Write-SafeLog "ERROR $($_.Exception.Message)"
    Write-Host "执行失败：$($_.Exception.Message)" -ForegroundColor Red
    return
  }
  finally { Pop-Location }
}

function Export-Diagnostics([ValidateSet('Both','Clipboard')][string]$Mode) {
  $scriptPath = Join-Path $ProjectRoot 'scripts\export-error-log.ps1'
  if (-not (Test-Path -LiteralPath $scriptPath)) { Write-Host "找不到报错导出脚本。" -ForegroundColor Red; return }
  try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Mode $Mode }
  catch { Write-SafeLog "ERROR 导出诊断失败：$($_.Exception.Message)"; Write-Host "导出失败：$($_.Exception.Message)" -ForegroundColor Red }
}

function Start-NpmWindow([string]$ScriptName) {
  if ($ScriptName -notmatch '^[A-Za-z0-9:._-]+$') { throw "非法 npm 脚本名。" }
  $command = "cd /d `"$ProjectRoot`" && npm.cmd run $ScriptName"
  Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList @('/k', $command) -WindowStyle Normal
}

function Read-ClientId {
  $root = Join-Path $ProjectRoot "客户照片"
  Write-Host ""
  Write-Host "现有客户："
  if (Test-Path -LiteralPath $root) {
    Get-ChildItem -Directory -LiteralPath $root | Sort-Object Name | ForEach-Object {
      $count = @(Get-ChildItem -File -LiteralPath $_.FullName | Where-Object { $_.Extension -match '^\.(jpg|jpeg|png|webp)$' }).Count
      Write-Host ("  {0} - {1} 张图片" -f $_.Name, $count)
    }
  }
  $clientId = (Read-Host "输入客户编号，例如 client_001；留空取消").Trim()
  if (-not $clientId) { return $null }
  if ($clientId -notmatch '^client_\d{3}$') {
    Write-Host "客户编号格式不正确。" -ForegroundColor Red
    return $null
  }
  $clientDir = Join-Path $root $clientId
  if (-not (Test-Path -LiteralPath $clientDir)) {
    Write-Host "客户目录不存在：$clientDir" -ForegroundColor Red
    return $null
  }
  $photoCount = @(Get-ChildItem -File -LiteralPath $clientDir | Where-Object { $_.Extension -match '^\.(jpg|jpeg|png|webp)$' }).Count
  if ($photoCount -lt 1) {
    Write-Host "该客户目录没有可用图片，请重新上传。" -ForegroundColor Red
    return $null
  }
  return $clientId
}

function Set-SafeFeishuMode {
  Set-EnvValue "FEISHU_DRY_RUN" "1"
  Set-EnvValue "FEISHU_ENABLE_REAL_API" "0"
  Write-Host "已切换到安全模式。若长连接正在运行，请停止后重新启动。" -ForegroundColor Green
}

function Enable-RealFeishuMode {
  if (-not (Ensure-Env)) { return }
  $envMap = Get-EnvMap
  if ([string]::IsNullOrWhiteSpace($envMap['FEISHU_APP_ID']) -or [string]::IsNullOrWhiteSpace($envMap['FEISHU_APP_SECRET'])) {
    Write-Host "请先配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。" -ForegroundColor Red
    return
  }
  Write-Host "真实模式会连接飞书、下载客户照片、启动工作流并回传图片。" -ForegroundColor Yellow
  $confirm = Read-Host "确认启用请输入：启用真实飞书"
  if ($confirm -ne "启用真实飞书") {
    Write-Host "已取消。" -ForegroundColor Yellow
    return
  }
  Set-EnvValue "FEISHU_DRY_RUN" "0"
  Set-EnvValue "FEISHU_ENABLE_REAL_API" "1"
  Write-Host "真实模式已开启。正式启动前请运行生产配置检查。" -ForegroundColor Red
}

function Restore-EnvBackup {
  if (-not (Test-Path -LiteralPath $EnvBackupRoot)) {
    Write-Host "没有找到 .env 备份。" -ForegroundColor Yellow
    return
  }
  $items = @(Get-ChildItem -File -LiteralPath $EnvBackupRoot -Filter 'env-*.bak' | Sort-Object LastWriteTime -Descending)
  if ($items.Count -eq 0) { Write-Host "没有找到 .env 备份。" -ForegroundColor Yellow; return }
  for ($i = 0; $i -lt $items.Count; $i += 1) { Write-Host ("{0}. {1}" -f ($i + 1), $items[$i].Name) }
  $raw = Read-Host "选择要恢复的编号；留空取消"
  $index = 0
  if (-not [int]::TryParse($raw, [ref]$index) -or $index -lt 1 -or $index -gt $items.Count) {
    Write-Host "已取消或编号无效。" -ForegroundColor Yellow
    return
  }
  $confirm = Read-Host "恢复会覆盖当前 .env，确认请输入 RESTORE"
  if ($confirm -ne 'RESTORE') { Write-Host "已取消。"; return }
  [void](Backup-Env)
  Copy-Item -LiteralPath $items[$index - 1].FullName -Destination $EnvPath -Force
  Write-Host "已恢复：$($items[$index - 1].Name)" -ForegroundColor Green
}

function Show-EnvironmentCheck {
  Write-Title "运行环境检查"
  try { Write-Host "Node：$(& node --version)" } catch { Write-Host "Node：未找到" -ForegroundColor Red }
  try { Write-Host "npm：$(& npm.cmd --version)" } catch { Write-Host "npm：未找到" -ForegroundColor Red }
  $chrome = @(
    $env:CHATGPT_BROWSER_PATH,
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($chrome) { Write-Host "Chrome：$((Get-Item -LiteralPath $chrome).VersionInfo.FileVersion)" }
  else { Write-Host "Chrome：未找到" -ForegroundColor Red }
  Write-Host "依赖目录：$(if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules')) {'已安装'} else {'未安装'})"
  Show-ConfigStatus
}

function Search-Faq {
  if (-not (Test-Path -LiteralPath $FaqPath)) { Write-Host "FAQ 数据文件不存在。" -ForegroundColor Red; return }
  $items = Get-Content -Raw -Encoding UTF8 -LiteralPath $FaqPath | ConvertFrom-Json
  Write-Title "问题查询"
  $query = (Read-Host "输入关键词，例如：上传失败、Mimo 401、飞书没反应；输入 ? 查看全部问题").Trim()
  if (-not $query) { return }
  if ($query -eq '?') {
    for ($i = 0; $i -lt $items.Count; $i += 1) { Write-Host ("{0}. {1}" -f ($i + 1), $items[$i].question) }
    $raw = Read-Host "输入问题编号"
    $index = 0
    if (-not [int]::TryParse($raw, [ref]$index) -or $index -lt 1 -or $index -gt $items.Count) { return }
    $matches = @($items[$index - 1])
  } else {
    $matches = @($items | Where-Object {
      $haystack = ($_.question + ' ' + ($_.keywords -join ' ') + ' ' + $_.answer)
      $haystack.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
  }
  if ($matches.Count -eq 0) {
    Write-Host "没有直接命中。可尝试更短的关键词，或输入 ? 查看问题目录。" -ForegroundColor Yellow
    return
  }
  foreach ($item in $matches | Select-Object -First 8) {
    Write-Host ""
    Write-Host "问：$($item.question)" -ForegroundColor Cyan
    Write-Host "答：$($item.answer)"
    Write-Host "来源：$($item.source)" -ForegroundColor DarkGray
  }
}

function Show-ConfigMenu {
  while ($true) {
    Write-Title "配置与账号"
    Write-Host "1. 查看配置状态（敏感值遮罩）"
    Write-Host "2. 创建 .env（已存在则不覆盖）"
    Write-Host "3. 配置 Mimo API Key"
    Write-Host "4. 配置飞书 App ID"
    Write-Host "5. 配置飞书 App Secret"
    Write-Host "6. 用记事本编辑完整 .env（自动备份）"
    Write-Host "7. 切换飞书安全模式"
    Write-Host "8. 启用飞书真实 API"
    Write-Host "9. 恢复 .env 备份"
    Write-Host "0. 返回主菜单"
    switch ((Read-Host "请选择").Trim()) {
      '1' { Show-ConfigStatus; Wait-Menu }
      '2' { [void](Ensure-Env); Wait-Menu }
      '3' { $v = Read-Secret "输入 Mimo API Key（输入过程不显示；留空取消）"; if ($v) { Set-EnvValue 'MIMO_API_KEY' $v }; Wait-Menu }
      '4' { $v = (Read-Host "输入飞书 App ID；留空取消").Trim(); if ($v) { Set-EnvValue 'FEISHU_APP_ID' $v }; Wait-Menu }
      '5' { $v = Read-Secret "输入飞书 App Secret（输入过程不显示；留空取消）"; if ($v) { Set-EnvValue 'FEISHU_APP_SECRET' $v }; Wait-Menu }
      '6' { if (Ensure-Env) { $b = Backup-Env; Write-Host "编辑前备份：$b"; Start-Process notepad.exe -ArgumentList @($EnvPath) }; Wait-Menu }
      '7' { Set-SafeFeishuMode; Wait-Menu }
      '8' { Enable-RealFeishuMode; Wait-Menu }
      '9' { Restore-EnvBackup; Wait-Menu }
      '0' { return }
      default { Write-Host "无效选项。" -ForegroundColor Yellow }
    }
  }
}

function Show-LocalMenu {
  while ($true) {
    Write-Title "本地客户流程"
    Write-Host "1. 打开专用 Chrome / 登录 ChatGPT"
    Write-Host "2. 检查 ChatGPT 登录态"
    Write-Host "3. 上传客户照片"
    Write-Host "4. Mimo 工作流 Dry-run"
    Write-Host "5. 正式生成 Top4 人像海报"
    Write-Host "6. 查看工作流摘要"
    Write-Host "7. 断点续跑生图"
    Write-Host "8. 仅补下载已生成图片"
    Write-Host "9. 清理旧 ChatGPT 对话标签"
    Write-Host "0. 返回主菜单"
    switch ((Read-Host "请选择").Trim()) {
      '1' { Invoke-Npm @('run','open-login'); Wait-Menu }
      '2' { Invoke-Npm @('run','test-open'); Wait-Menu }
      '3' { Invoke-Npm @('run','client-upload'); Wait-Menu }
      '4' { $id = Read-ClientId; if ($id) { Invoke-Npm @('run','mimo:workflow:dry-run','--','--client-id',$id) }; Wait-Menu }
      '5' {
        $id = Read-ClientId
        if ($id) {
          $envMap = Get-EnvMap
          if ([string]::IsNullOrWhiteSpace($envMap['MIMO_API_KEY'])) { Write-Host "Mimo API Key 未配置。" -ForegroundColor Red }
          else {
            Write-Host "将调用 Mimo API 和 ChatGPT 网页端，并按 4 路并发正式生图。" -ForegroundColor Yellow
            if ((Read-Host "确认执行请输入 RUN") -eq 'RUN') {
              Invoke-Npm @('run','mimo:workflow','--','--client-id',$id,'--client-photo-dir',"客户照片/$id",'--max-parallel','4')
            }
          }
        }
        Wait-Menu
      }
      '6' { Invoke-Npm @('run','workflow:summary'); Wait-Menu }
      '7' { Invoke-Npm @('run','generate:resume'); Wait-Menu }
      '8' { Invoke-Npm @('run','generate:collect'); Wait-Menu }
      '9' { Invoke-Npm @('run','cleanup-tabs'); Wait-Menu }
      '0' { return }
      default { Write-Host "无效选项。" -ForegroundColor Yellow }
    }
  }
}

function Show-FeishuMenu {
  while ($true) {
    Write-Title "飞书自动化"
    Write-Host "1. 检查飞书基础配置"
    Write-Host "2. 生产配置检查"
    Write-Host "3. 飞书入口 Dry-run"
    Write-Host "4. 启动飞书长连接（新窗口）"
    Write-Host "5. 切换安全模式"
    Write-Host "6. 启用真实 API"
    Write-Host "7. 打开飞书底层逻辑 Wiki"
    Write-Host "0. 返回主菜单"
    switch ((Read-Host "请选择").Trim()) {
      '1' { Invoke-Npm @('run','feishu:check-config'); Wait-Menu }
      '2' { Invoke-Npm @('run','feishu:check-config','--','--production'); Wait-Menu }
      '3' { Invoke-Npm @('run','feishu:dry-run'); Wait-Menu }
      '4' { Start-NpmWindow 'feishu:long-connect'; Write-Host "长连接已在新窗口启动；关闭该窗口即停止服务。" -ForegroundColor Green; Wait-Menu }
      '5' { Set-SafeFeishuMode; Wait-Menu }
      '6' { Enable-RealFeishuMode; Wait-Menu }
      '7' { Start-Process $WikiUrl; Wait-Menu }
      '0' { return }
      default { Write-Host "无效选项。" -ForegroundColor Yellow }
    }
  }
}

function Show-DiagnosticsMenu {
  while ($true) {
    Write-Title "诊断与自检"
    Write-Host "1. 运行环境检查"
    Write-Host "2. 检查并修复运行环境（Node/npm/Chrome/依赖）"
    Write-Host "3. 核心离线自检"
    Write-Host "4. 上传服务自检"
    Write-Host "5. 模板评分自检"
    Write-Host "6. 本地工作流自检"
    Write-Host "7. 飞书入口自检"
    Write-Host "8. npm 依赖安全审计"
    Write-Host "9. 一键生成脱敏诊断包并复制到剪贴板"
    Write-Host "10. 仅复制脱敏错误摘要到剪贴板"
    Write-Host "11. 模板与审美资产自检"
    Write-Host "12. 开源打包脱敏检查（安装态可能因 node_modules 失败）"
    Write-Host "13. v1.4 模板拟合认证自检"
    Write-Host "0. 返回主菜单"
    switch ((Read-Host "请选择").Trim()) {
      '1' { Show-EnvironmentCheck; Wait-Menu }
      '2' { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot 'scripts\repair-environment.ps1') -Repair; Wait-Menu }
      '3' { Invoke-Npm @('run','self-test'); Wait-Menu }
      '4' { Push-Location $ProjectRoot; try { & node scripts/client-upload-server.mjs --self-test } finally { Pop-Location }; Wait-Menu }
      '5' { Invoke-Npm @('run','template-score:self-test'); Wait-Menu }
      '6' { Invoke-Npm @('run','workflow:local-core:self-test'); Wait-Menu }
      '7' { Invoke-Npm @('run','feishu:self-test'); Wait-Menu }
      '8' { Invoke-Npm @('audit','--omit=dev'); Wait-Menu }
      '9' { Export-Diagnostics 'Both'; Wait-Menu }
      '10' { Export-Diagnostics 'Clipboard'; Wait-Menu }
      '11' { Invoke-Npm @('run','assets:self-test'); Wait-Menu }
      '12' { Invoke-Npm @('run','open-source:check'); Wait-Menu }
      '13' { Invoke-Npm @('run','template:fit:self-test'); Wait-Menu }
      '0' { return }
      default { Write-Host "无效选项。" -ForegroundColor Yellow }
    }
  }
}

function Show-TemplateAssetMenu {
  while ($true) {
    Write-Title "模板与审美资产"
    Write-Host "1. 从本地文件夹导入模板"
    Write-Host "2. 查看待审核草稿"
    Write-Host "3. 查看草稿详情"
    Write-Host "4. 确认草稿入库"
    Write-Host "5. 驳回草稿"
    Write-Host "6. 使用 ChatGPT 网页备援解析"
    Write-Host "7. 搜索审美资产"
    Write-Host "8. 停用审美资产"
    Write-Host "9. 恢复审美资产"
    Write-Host "10. 标记为推荐资产"
    Write-Host "11. 标记为普通资产"
    Write-Host "12. 记录资产反馈"
    Write-Host "13. 导出全部资产"
    Write-Host "14. 重建模板与资产索引"
    Write-Host "15. 运行资产自检"
    Write-Host "0. 返回主菜单"
    switch ((Read-Host "请选择").Trim()) {
      '1' {
        $folder = (Read-Host "模板图片文件夹；留空使用 模板导入\inbox").Trim()
        if (-not $folder) { $folder = '模板导入\inbox' }
        Invoke-Npm @('run','template:ingest','--','--source-dir',$folder)
        Wait-Menu
      }
      '2' { Invoke-Npm @('run','template:review','--','--list','--status','awaiting_review'); Wait-Menu }
      '3' { $id=(Read-Host "draft_id").Trim(); if($id){Invoke-Npm @('run','template:review','--','--show',$id)}; Wait-Menu }
      '4' { $id=(Read-Host "draft_id").Trim(); if($id){Invoke-Npm @('run','template:review','--','--approve',$id)}; Wait-Menu }
      '5' { $id=(Read-Host "draft_id").Trim(); $reason=(Read-Host "驳回原因").Trim(); if($id){Invoke-Npm @('run','template:review','--','--reject',$id,'--reason',$reason)}; Wait-Menu }
      '6' { $id=(Read-Host "draft_id").Trim(); if($id){Invoke-Npm @('run','template:web-fallback','--','--draft',$id)}; Wait-Menu }
      '7' { $q=(Read-Host "资产关键词").Trim(); Invoke-Npm @('run','template:review','--','--search',$q); Wait-Menu }
      '8' { $id=(Read-Host "asset_id").Trim(); if($id){Invoke-Npm @('run','template:review','--','--disable-asset',$id)}; Wait-Menu }
      '9' { $id=(Read-Host "asset_id").Trim(); if($id){Invoke-Npm @('run','template:review','--','--enable-asset',$id)}; Wait-Menu }
      '10' { $id=(Read-Host "asset_id").Trim(); if($id){Invoke-Npm @('run','template:review','--','--recommend-asset',$id)}; Wait-Menu }
      '11' { $id=(Read-Host "asset_id").Trim(); if($id){Invoke-Npm @('run','template:review','--','--normal-asset',$id)}; Wait-Menu }
      '12' {
        $id=(Read-Host "asset_id").Trim(); $sentiment=(Read-Host "反馈类型 like / dislike / note").Trim(); $note=(Read-Host "备注").Trim()
        if($id){Invoke-Npm @('run','template:review','--','--feedback-asset',$id,'--sentiment',$sentiment,'--note',$note)}
        Wait-Menu
      }
      '13' { Invoke-Npm @('run','template:review','--','--export-assets'); Wait-Menu }
      '14' { Invoke-Npm @('run','assets:rebuild-index'); Wait-Menu }
      '15' { Invoke-Npm @('run','assets:self-test'); Wait-Menu }
      '0' { return }
      default { Write-Host "无效选项。" -ForegroundColor Yellow }
    }
  }
}

function Show-TemplateFitLabMenu {
  while ($true) {
    Write-Title "模板拟合实验室 v1.4"
    Write-Host "评分：本地视觉 35% + GPT视觉 35% + 人工 30%；复刻 ≥90 后，泛化连续三次 ≥90。"
    Write-Host "1. GPT 网页分类并拆解新模板"
    Write-Host "2. 人工确认低置信度类别"
    Write-Host "3. 开始模板拟合"
    Write-Host "4. 查看拟合任务与分类素材库"
    Write-Host "5. 继续下一轮拟合/认证"
    Write-Host "6. 提交本轮人工评分与硬门槛"
    Write-Host "7. 添加泛化测试输入"
    Write-Host "8. 完成三连后正式认证入库"
    Write-Host "9. 导出 OpenClaw 脱敏学习包"
    Write-Host "10. 运行 v1.4 离线自检"
    Write-Host "0. 返回主菜单"
    switch ((Read-Host "请选择").Trim()) {
      '1' {
        $image=(Read-Host "模板图片完整路径").Trim()
        if($image){Invoke-Npm @('run','template:classify','--','--image',$image)}
        Wait-Menu
      }
      '2' {
        $draft=(Read-Host "draft_id").Trim(); $category=(Read-Host "类别 poster / portrait_photo / business_card / social_media / ecommerce").Trim()
        if($draft -and $category){Invoke-Npm @('run','template:classify','--','--draft',$draft,'--confirm-category',$category)}
        Wait-Menu
      }
      '3' {
        $draft=(Read-Host "draft_id").Trim()
        if($draft){Invoke-Npm @('run','template:fit','--','--draft',$draft,'--classification-confirmed')}
        Wait-Menu
      }
      '4' { Invoke-Npm @('run','template:library'); Wait-Menu }
      '5' { $fit=(Read-Host "fit_id").Trim(); if($fit){Invoke-Npm @('run','template:fit-resume','--','--fit',$fit)}; Wait-Menu }
      '6' {
        $fit=(Read-Host "fit_id").Trim(); $attempt=(Read-Host "attempt_id").Trim(); $score=(Read-Host "你的评分 0-100").Trim()
        if($fit -and $attempt -and $score){
          Write-Host "若任一硬门槛不通过，请输入对应英文名；多个用逗号：required_text_exact,logo_integrity,identity_preserved,canvas_and_core_region_valid,category_valid,assets_active" -ForegroundColor Yellow
          $failed=(Read-Host "未通过硬门槛；全部通过则留空").Trim()
          $args=@('run','template:fit-review','--','--fit',$fit,'--attempt',$attempt,'--human-score',$score)
          foreach($gate in @('required_text_exact','logo_integrity','identity_preserved','canvas_and_core_region_valid','category_valid','assets_active')){
            $ok=-not (($failed -split ',').Trim() -contains $gate); $args += @('--gate',"$gate=$($ok.ToString().ToLower())")
          }
          $note=(Read-Host "人工备注；可留空").Trim(); if($note){$args += @('--note',$note)}
          Invoke-Npm $args
        }
        Wait-Menu
      }
      '7' {
        $fit=(Read-Host "fit_id").Trim(); $case=(Read-Host "case_id").Trim(); $json=(Read-Host "测试输入 JSON 完整路径").Trim()
        if($fit -and $case -and $json){Invoke-Npm @('run','template:certify','--','--fit',$fit,'--set-input',$case,'--input-json',$json)}
        Wait-Menu
      }
      '8' { $fit=(Read-Host "fit_id").Trim(); if($fit){Invoke-Npm @('run','template:certify','--','--fit',$fit)}; Wait-Menu }
      '9' { Invoke-Npm @('run','learning:export'); Wait-Menu }
      '10' { Invoke-Npm @('run','template:fit:self-test'); Wait-Menu }
      '0' { return }
      default { Write-Host "无效选项。" -ForegroundColor Yellow }
    }
  }
}

function Show-FoldersMenu {
  while ($true) {
    Write-Title "目录与结果"
    Write-Host "1. 打开项目目录"
    Write-Host "2. 打开客户照片目录"
    Write-Host "3. 打开生成结果目录"
    Write-Host "4. 打开 workflow 目录"
    Write-Host "5. 打开回滚备份目录"
    Write-Host "6. 打开封装使用说明"
    Write-Host "0. 返回主菜单"
    $choice = (Read-Host "请选择").Trim()
    $path = switch ($choice) {
      '1' { $ProjectRoot }
      '2' { Join-Path $ProjectRoot '客户照片' }
      '3' { Join-Path $ProjectRoot '生成结果' }
      '4' { Join-Path $ProjectRoot 'workflow' }
      '5' { 'C:/ExampleWorkspace/workspace' }
      '6' { Join-Path $ProjectRoot 'docs\WORKFLOW_CONSOLE_GUIDE.md' }
      '0' { return }
      default { $null }
    }
    if ($path) {
      if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Force -Path $path | Out-Null }
      Start-Process $path
    }
  }
}

function Invoke-SelfTest {
  $errors = [Collections.Generic.List[string]]::new()
  foreach ($required in @('package.json','.env.example','config\template_categories.json','scripts\workflow-menu.ps1','scripts\repair-environment.ps1','scripts\template-asset-core.mjs','scripts\template-ingest.mjs','scripts\template-review.mjs','scripts\template-web-fallback.mjs','scripts\assets-self-test.mjs','scripts\template-fit-core.mjs','scripts\template-fit.mjs','scripts\template-fit-self-test.mjs','scripts\learning-export.mjs','prompts\template_asset_extraction_prompt.md','prompts\template_v14_classification_extraction_prompt.md','prompts\template_v14_visual_judge_prompt.md','docs\workflow-faq.json','启动工作流.cmd','一键导出报错.cmd')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $required))) { $errors.Add("缺少 $required") }
  }
  try {
    $faq = Get-Content -Raw -Encoding UTF8 -LiteralPath $FaqPath | ConvertFrom-Json
    if ($faq.Count -lt 15) { $errors.Add("FAQ 条目不足 15 条") }
    foreach ($item in $faq) {
      if (-not $item.question -or -not $item.answer -or -not $item.source) { $errors.Add("FAQ 条目字段不完整") }
    }
  } catch { $errors.Add("FAQ JSON 无法解析：$($_.Exception.Message)") }
  try {
    $package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
    if (-not $package.scripts.menu) { $errors.Add("package.json 缺少 menu 脚本") }
    if (-not $package.scripts.'diagnose:export') { $errors.Add("package.json 缺少 diagnose:export 脚本") }
    if (-not $package.scripts.'template:ingest') { $errors.Add("package.json 缺少 template:ingest 脚本") }
    if (-not $package.scripts.'assets:self-test') { $errors.Add("package.json 缺少 assets:self-test 脚本") }
    if (-not $package.scripts.'template:fit') { $errors.Add("package.json 缺少 template:fit 脚本") }
    if (-not $package.scripts.'template:fit:self-test') { $errors.Add("package.json 缺少 template:fit:self-test 脚本") }
    if (-not $package.scripts.'learning:export') { $errors.Add("package.json 缺少 learning:export 脚本") }
  } catch { $errors.Add("package.json 无法解析") }
  if ($errors.Count -gt 0) {
    Write-Host "封装自检失败：" -ForegroundColor Red
    $errors | ForEach-Object { Write-Host "- $_" }
    exit 1
  }
  Write-Host "封装自检通过：入口、二级菜单、FAQ 和配置模板均有效。" -ForegroundColor Green
}

if ($SelfTest) { Invoke-SelfTest; exit 0 }

Push-Location $ProjectRoot
try {
  :MainLoop while ($true) {
    Clear-Host
    Write-Title "人像写真自动化工作流控制台"
    Write-Host "项目：$ProjectRoot" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "1. 配置与账号"
    Write-Host "2. 本地客户流程"
    Write-Host "3. 飞书自动化"
    Write-Host "4. 模板与审美资产"
    Write-Host "5. 诊断与自检"
    Write-Host "6. 问题查询"
    Write-Host "7. 目录与结果"
    Write-Host "8. 模板拟合实验室 v1.4"
    Write-Host "0. 退出"
    try {
      switch ((Read-Host "请选择一级菜单").Trim()) {
        '1' { Show-ConfigMenu }
        '2' { Show-LocalMenu }
        '3' { Show-FeishuMenu }
        '4' { Show-TemplateAssetMenu }
        '5' { Show-DiagnosticsMenu }
        '6' { Search-Faq; Wait-Menu }
        '7' { Show-FoldersMenu }
        '8' { Show-TemplateFitLabMenu }
        '0' { break MainLoop }
        default { Write-Host "无效选项。" -ForegroundColor Yellow; Start-Sleep -Milliseconds 700 }
      }
    } catch {
      Write-SafeLog "ERROR 未处理异常：$($_.Exception.Message)`n$($_.ScriptStackTrace)"
      Write-Host "发生错误：$($_.Exception.Message)" -ForegroundColor Red
      Write-Host "错误已记录，可进入“诊断与自检”一键导出。" -ForegroundColor Yellow
      Wait-Menu
    }
  }
} finally {
  Pop-Location
}
