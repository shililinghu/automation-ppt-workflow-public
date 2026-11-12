param(
  [ValidateSet('Zip', 'Clipboard', 'Both')]
  [string]$Mode = 'Both',
  [string]$OutputDir = '',
  [int]$MaxLogFiles = 12,
  [int]$MaxCharsPerFile = 200000,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$EnvPath = Join-Path $ProjectRoot '.env'
if (-not $OutputDir) { $OutputDir = Join-Path $ProjectRoot '诊断包' }

function Get-EnvMap {
  $map = [ordered]@{}
  if (-not (Test-Path -LiteralPath $EnvPath)) { return $map }
  foreach ($line in [IO.File]::ReadAllLines($EnvPath, [Text.Encoding]::UTF8)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $map[$matches[1]] = $matches[2] }
  }
  return $map
}

$EnvMap = Get-EnvMap
$SensitiveKeys = @(
  'MIMO_API_KEY', 'FEISHU_APP_SECRET', 'FEISHU_APP_ID', 'OPENAI_API_KEY',
  'ACCESS_TOKEN', 'REFRESH_TOKEN', 'TENANT_ACCESS_TOKEN', 'AUTHORIZATION', 'COOKIE'
)

function Protect-SensitiveText([string]$Text) {
  if ($null -eq $Text) { return '' }
  $safe = [string]$Text
  foreach ($key in $SensitiveKeys) {
    $value = [string]$EnvMap[$key]
    if ($value.Length -ge 4) { $safe = $safe.Replace($value, '[REDACTED]') }
  }
  $safe = [regex]::Replace($safe, '(?i)\bBearer\s+[A-Za-z0-9._~+\-/]+=*', 'Bearer [REDACTED]')
  $safe = [regex]::Replace($safe, '(?im)\b(MIMO_API_KEY|FEISHU_APP_SECRET|OPENAI_API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|TENANT_ACCESS_TOKEN|AUTHORIZATION|COOKIE)\s*[=:]\s*([^\s,;]+)', '$1=[REDACTED]')
  $safe = [regex]::Replace($safe, '(?im)("(?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|authorization|cookie)"\s*:\s*")[^"]*(")', '$1[REDACTED]$2')
  $safe = [regex]::Replace($safe, '(?i)\bsk-[A-Za-z0-9_-]{12,}', '[REDACTED_API_KEY]')
  return $safe
}

function Get-CommandVersion([string]$Command, [string[]]$Arguments) {
  try {
    $value = & $Command @Arguments 2>$null | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $value) { return '未找到' }
    return [string]$value
  } catch { return '未找到' }
}

function Get-ChromeInfo {
  $paths = @(@(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
  if (-not $paths) { return '未找到' }
  return (Get-Item -LiteralPath $paths[0]).VersionInfo.FileVersion
}

function Get-ConfiguredState([string]$Key) {
  if ([string]::IsNullOrWhiteSpace([string]$EnvMap[$Key])) { return '未配置' }
  return '已配置（值不导出）'
}

function Get-RecentLogFiles {
  $roots = @(
    (Join-Path $ProjectRoot 'logs'),
    (Join-Path $ProjectRoot 'workflow\logs'),
    (Join-Path $env:LOCALAPPDATA 'npm-cache\_logs')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $items = foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -in @('.log', '.txt', '.json', '.ndjson') }
  }
  return @($items | Sort-Object LastWriteTime -Descending | Select-Object -First $MaxLogFiles)
}

function Get-SafeTail([string]$Path) {
  try {
    $text = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    if ($text.Length -gt $MaxCharsPerFile) { $text = "[仅保留末尾 $MaxCharsPerFile 字符]`r`n" + $text.Substring($text.Length - $MaxCharsPerFile) }
    return Protect-SensitiveText $text
  } catch {
    return "[无法读取日志：$($_.Exception.Message)]"
  }
}

if ($SelfTest) {
  $sample = 'MIMO_API_KEY=EXAMPLE_TEST_SECRET Authorization: Bearer abc.def.ghi "app_secret":"very-secret" Cookie=session-secret'
  $safe = Protect-SensitiveText $sample
  if ($safe -match 'EXAMPLE_TEST_SECRET|abc\.def\.ghi|very-secret|session-secret') { throw '脱敏自检失败。' }
  if ($safe -notmatch '\[REDACTED') { throw '脱敏标记自检失败。' }
  Write-Host '报错导出自检通过：敏感值遮蔽规则有效。' -ForegroundColor Green
  exit 0
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
[IO.Directory]::CreateDirectory($OutputDir) | Out-Null
$stage = Join-Path ([IO.Path]::GetTempPath()) ("portrait-diagnostic-$timestamp-$([Guid]::NewGuid().ToString('N'))")
[IO.Directory]::CreateDirectory($stage) | Out-Null

try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  $installReport = Join-Path $ProjectRoot 'install-report.json'
  $summaryLines = [Collections.Generic.List[string]]::new()
  $summaryLines.Add('人像写真工作流 - Agent 诊断摘要')
  $summaryLines.Add("导出时间：$([DateTimeOffset]::Now.ToString('o'))")
  $summaryLines.Add("项目目录：$ProjectRoot")
  $summaryLines.Add("Windows：$($os.Caption) $($os.Version)")
  $summaryLines.Add("PowerShell：$($PSVersionTable.PSVersion)")
  $summaryLines.Add("Node：$(Get-CommandVersion 'node' @('--version'))")
  $summaryLines.Add("npm：$(Get-CommandVersion 'npm.cmd' @('--version'))")
  $summaryLines.Add("Chrome：$(Get-ChromeInfo)")
  $summaryLines.Add("Mimo Key：$(Get-ConfiguredState 'MIMO_API_KEY')")
  $summaryLines.Add("飞书 App ID：$(Get-ConfiguredState 'FEISHU_APP_ID')")
  $summaryLines.Add("飞书 App Secret：$(Get-ConfiguredState 'FEISHU_APP_SECRET')")
  $summaryLines.Add("飞书 Dry-run：$([string]$EnvMap['FEISHU_DRY_RUN'])")
  $summaryLines.Add("飞书真实 API：$([string]$EnvMap['FEISHU_ENABLE_REAL_API'])")
  $summaryLines.Add("node_modules：$(if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules')) { '存在' } else { '不存在' })")
  $summaryLines.Add('隐私说明：未导出 .env、浏览器登录态、客户照片或生成图片；已对日志再次脱敏。')
  [IO.File]::WriteAllLines((Join-Path $stage 'diagnostic-summary.txt'), $summaryLines, [Text.UTF8Encoding]::new($false))

  if (Test-Path -LiteralPath $installReport) {
    $reportText = Protect-SensitiveText ([IO.File]::ReadAllText($installReport, [Text.Encoding]::UTF8))
    [IO.File]::WriteAllText((Join-Path $stage 'install-report-sanitized.json'), $reportText, [Text.UTF8Encoding]::new($false))
  }

  $logBuilder = [Text.StringBuilder]::new()
  $logFiles = @(Get-RecentLogFiles)
  if ($logFiles.Count -eq 0) { [void]$logBuilder.AppendLine('没有找到已记录的日志。请复现一次报错后重新导出。') }
  foreach ($file in $logFiles) {
    [void]$logBuilder.AppendLine('')
    [void]$logBuilder.AppendLine(('=' * 72))
    [void]$logBuilder.AppendLine("来源：$($file.FullName)")
    [void]$logBuilder.AppendLine("修改时间：$($file.LastWriteTime.ToString('o'))")
    [void]$logBuilder.AppendLine(('=' * 72))
    [void]$logBuilder.AppendLine((Get-SafeTail $file.FullName))
  }
  $logText = Protect-SensitiveText $logBuilder.ToString()
  [IO.File]::WriteAllText((Join-Path $stage 'recent-errors-sanitized.log'), $logText, [Text.UTF8Encoding]::new($false))

  $agentNote = @'
请 Agent 先阅读 diagnostic-summary.txt 和 recent-errors-sanitized.log，定位最早出现的有效错误。
诊断包已脱敏，且故意不包含 .env、Cookie、Chrome profile、客户照片和生成图片。
如仍缺信息，请让用户复现错误后再次一键导出；不要要求用户直接发送密钥或 Cookie。
'@
  [IO.File]::WriteAllText((Join-Path $stage 'README_FOR_AGENT.txt'), $agentNote, [Text.UTF8Encoding]::new($false))

  $clipboardText = Protect-SensitiveText (($summaryLines -join "`r`n") + "`r`n`r`n最近错误：`r`n" + $logText)
  if ($clipboardText.Length -gt 30000) { $clipboardText = $clipboardText.Substring(0, 30000) + "`r`n[剪贴板内容已截断，完整信息见 ZIP]" }

  $zipPath = $null
  if ($Mode -in @('Zip', 'Both')) {
    $zipPath = Join-Path $OutputDir "人像写真诊断包-$timestamp.zip"
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal -Force
    Write-Host "诊断包已生成：$zipPath" -ForegroundColor Green
    Write-Output "DIAGNOSTIC_ZIP=$zipPath"
  }
  if ($Mode -in @('Clipboard', 'Both')) {
    try { Set-Clipboard -Value $clipboardText; Write-Host '脱敏错误摘要已复制到剪贴板。' -ForegroundColor Green }
    catch { $clipboardText | & "$env:SystemRoot\System32\clip.exe"; Write-Host '脱敏错误摘要已复制到剪贴板。' -ForegroundColor Green }
    Write-Output 'CLIPBOARD=READY'
  }
} finally {
  if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage, $true) }
}
