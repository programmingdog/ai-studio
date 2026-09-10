#requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet("Initialize", "Check", "Prepare", "DeployPlatform", "BuildClient", "UploadClient", "PublishClient", "Verify", "Promote", "All")]
  [string]$Stage = "All",
  [string]$Version,
  [string]$ReleaseNotes,
  [string]$ReleaseNotesFile,
  [string]$ConfigPath,
  [int]$RolloutPercent = 0,
  [switch]$CommitAllChanges,
  [switch]$PublishUpdate,
  [switch]$NonInteractive,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$script:ToolsRoot = Split-Path -Parent $PSCommandPath
$script:RepositoryRoot = Split-Path -Parent $script:ToolsRoot
$script:ExampleConfigPath = Join-Path $script:ToolsRoot "release.config.example.json"
if (-not $ConfigPath) { $ConfigPath = Join-Path $script:ToolsRoot "release.config.json" }
if (-not [IO.Path]::IsPathRooted($ConfigPath)) { $ConfigPath = Join-Path $script:RepositoryRoot $ConfigPath }
$script:Config = $null
$script:State = $null
$script:StatePath = $null

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Info([string]$Message) {
  Write-Host "    $Message" -ForegroundColor DarkGray
}

function Fail([string]$Message) {
  throw $Message
}

function Get-PropertyValue($Object, [string]$Name, $Default = $null) {
  if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) {
    return $Object.$Name
  }
  return $Default
}

function Get-ApiCollection($Response, [string]$Label, [string]$RequiredProperty) {
  $value = $Response
  for ($depth = 0; $depth -lt 4 -and $null -ne $value -and $value -isnot [System.Array]; $depth++) {
    $wrapper = $null
    foreach ($name in @("items", "releases", "records", "data", "result")) {
      $property = $value.PSObject.Properties[$name]
      if ($null -ne $property) {
        $wrapper = $property
        break
      }
    }
    if ($null -eq $wrapper) { break }
    $value = $wrapper.Value
  }

  $items = if ($null -eq $value) { @() } else { @($value) }
  foreach ($item in $items) {
    if ($null -eq $item -or $null -eq $item.PSObject.Properties[$RequiredProperty]) {
      $properties = if ($null -eq $item) { "<null>" } else { @($item.PSObject.Properties.Name) -join ", " }
      Fail "$Label 返回了无法识别的数据结构（需要属性 $RequiredProperty，实际属性：$properties）"
    }
  }
  return [pscustomobject]@{ items = $items }
}

function Get-ApiObject($Response, [string]$Label) {
  $value = $Response
  for ($depth = 0; $depth -lt 4 -and $null -ne $value; $depth++) {
    if ($value -is [System.Array]) {
      if (@($value).Count -ne 1) { Fail "$Label 返回的对象数量不是 1" }
      $value = @($value)[0]
      continue
    }
    $wrapper = $null
    foreach ($name in @("data", "result", "release")) {
      $property = $value.PSObject.Properties[$name]
      if ($null -ne $property) {
        $wrapper = $property
        break
      }
    }
    if ($null -eq $wrapper) { break }
    $value = $wrapper.Value
  }
  if ($null -eq $value -or $value -is [System.Array]) { Fail "$Label 没有返回有效对象" }
  return [pscustomobject]@{ item = $value }
}

function Read-Utf8Text([string]$Path) {
  return [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
}

function ConvertTo-Utf8JsonBytes($Value, [int]$Depth = 10) {
  $json = $Value | ConvertTo-Json -Depth $Depth
  # PowerShell functions enumerate arrays by default. Without the unary comma,
  # a byte[] becomes Object[] and Windows PowerShell sends "123 13 10 ..."
  # instead of the JSON payload.
  return ,([Text.UTF8Encoding]::new($false).GetBytes($json))
}

function Resolve-RepositoryPath([string]$Path) {
  $expanded = [Environment]::ExpandEnvironmentVariables($Path)
  if ([IO.Path]::IsPathRooted($expanded)) { return [IO.Path]::GetFullPath($expanded) }
  return [IO.Path]::GetFullPath((Join-Path $script:RepositoryRoot $expanded))
}

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { Fail "缺少命令：$Name" }
}

function Format-NativeCommand([string]$Command, [string[]]$Arguments) {
  $safe = $Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
  return "$Command $($safe -join ' ')"
}

function Invoke-Native([string]$Command, [string[]]$Arguments, [switch]$Capture) {
  Write-Info (Format-NativeCommand $Command $Arguments)
  if ($DryRun) { return "" }
  if ($Capture) {
    $output = & $Command @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { Fail "$Command 执行失败（退出码 $exitCode）：`n$($output -join "`n")" }
    return ($output -join "`n").Trim()
  }
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { Fail "$Command 执行失败（退出码 $LASTEXITCODE）" }
}

function Read-PlainSecret([string]$EnvironmentName, [string]$Prompt) {
  $existing = [Environment]::GetEnvironmentVariable($EnvironmentName, "Process")
  if ($existing) {
    if ($existing -eq "System.Security.SecureString") { Fail "$EnvironmentName 被错误设置成了 SecureString 对象文本，请删除该环境变量并让脚本交互读取" }
    return $existing
  }
  if ($NonInteractive) { Fail "非交互模式需要环境变量 $EnvironmentName" }
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Confirm-Action([string]$Prompt, [switch]$DefaultNo) {
  if ($NonInteractive) { return -not $DefaultNo }
  $suffix = if ($DefaultNo) { "[y/N]" } else { "[Y/n]" }
  $answer = Read-Host "$Prompt $suffix"
  if (-not $answer) { return -not $DefaultNo }
  return $answer -match '^(y|yes|是)$'
}

function Assert-SemVer([string]$Value, [string]$Label = "版本号") {
  if ($Value -notmatch '^\d+\.\d+\.\d+$') { Fail "$Label 必须是三段数字版本号，例如 0.2.1" }
}

function Compare-SemVer([string]$Left, [string]$Right) {
  Assert-SemVer $Left
  Assert-SemVer $Right
  $a = $Left.Split('.') | ForEach-Object { [int64]$_ }
  $b = $Right.Split('.') | ForEach-Object { [int64]$_ }
  for ($i = 0; $i -lt 3; $i++) {
    if ($a[$i] -lt $b[$i]) { return -1 }
    if ($a[$i] -gt $b[$i]) { return 1 }
  }
  return 0
}

function Load-Config {
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    Fail "缺少配置文件：$ConfigPath。先运行：powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1 -Stage Initialize"
  }
  $script:Config = Read-Utf8Text $ConfigPath | ConvertFrom-Json
  if ((Get-PropertyValue $script:Config "schema_version" 0) -ne 1) { Fail "不支持的发布配置版本" }
}

function Initialize-Config {
  Write-Step "初始化本地发布配置"
  if (Test-Path -LiteralPath $ConfigPath) {
    Write-Host "配置文件已存在：$ConfigPath"
    return
  }
  if ($DryRun) {
    Write-Host "[DryRun] 将从 $script:ExampleConfigPath 创建 $ConfigPath"
    return
  }
  Copy-Item -LiteralPath $script:ExampleConfigPath -Destination $ConfigPath
  Write-Host "已创建：$ConfigPath"
  Write-Host "请填写服务器地址、管理员邮箱和签名私钥路径；不要在该文件中保存密码或 Token。"
}

function Assert-Config([switch]$RequireServer, [switch]$RequireAdmin, [switch]$RequireSigning) {
  $siteOrigin = [string](Get-PropertyValue $script:Config "site_origin")
  $apiBase = [string](Get-PropertyValue $script:Config "api_base_url")
  if ($siteOrigin -notmatch '^https://[^/]+$') { Fail "site_origin 必须是无尾斜杠的 HTTPS 站点地址" }
  if ($apiBase -notmatch '^https://[^/]+/api/v1$') { Fail "api_base_url 必须是 HTTPS /api/v1 地址" }
  Assert-SemVer ([string](Get-PropertyValue $script:Config "minimum_supported_version" "0.0.0")) "最低可运行版本"
  $initialRollout = [int](Get-PropertyValue $script:Config "initial_rollout_percent" 10)
  if ($initialRollout -lt 1 -or $initialRollout -gt 100) { Fail "initial_rollout_percent 必须为 1 到 100" }

  if ($RequireServer) {
    $hostName = [string](Get-PropertyValue $script:Config "server_host")
    $serverUser = [string](Get-PropertyValue $script:Config "server_user")
    $remoteRoot = [string](Get-PropertyValue $script:Config "remote_client_root")
    if ($hostName -match '^REPLACE_' -or $hostName -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]*$') { Fail "请在配置中填写有效的 server_host" }
    if ($serverUser -notmatch '^[a-z_][a-z0-9_-]*$') { Fail "server_user 格式无效" }
    if ($remoteRoot -notmatch '^/[A-Za-z0-9._/-]+$' -or $remoteRoot.Contains("..")) { Fail "remote_client_root 必须是安全的绝对路径" }
    $keyPath = Resolve-RepositoryPath ([string](Get-PropertyValue $script:Config "ssh_key_path"))
    if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { Fail "SSH 私钥不存在：$keyPath" }
  }
  if ($RequireAdmin) {
    $adminEmail = [string](Get-PropertyValue $script:Config "admin_email")
    if ($adminEmail -match '^REPLACE_' -or $adminEmail -notmatch '^[^@\s]+@[^@\s]+$') { Fail "请在配置中填写有效的 admin_email" }
  }
  if ($RequireSigning) {
    $key = [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY", "Process")
    if (-not $key) {
      $key = Resolve-RepositoryPath ([string](Get-PropertyValue $script:Config "signing_private_key_path"))
      if (-not (Test-Path -LiteralPath $key -PathType Leaf)) { Fail "Updater 签名私钥不存在：$key" }
    }
  }
}

function Get-ReleaseNotes {
  if ($ReleaseNotes) { return $ReleaseNotes.Trim() }
  if ($ReleaseNotesFile) {
    $path = Resolve-RepositoryPath $ReleaseNotesFile
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail "更新说明文件不存在：$path" }
    return (Read-Utf8Text $path).Trim()
  }
  if ($script:State -and $script:State.release_notes) { return [string]$script:State.release_notes }
  if ($NonInteractive) { Fail "非交互模式必须提供 -ReleaseNotes 或 -ReleaseNotesFile" }
  return (Read-Host "请输入本次更新说明").Trim()
}

function Initialize-State {
  Assert-SemVer $Version
  $directory = Join-Path $script:RepositoryRoot "release/automation/$Version"
  $script:StatePath = Join-Path $directory "state.json"
  if (Test-Path -LiteralPath $script:StatePath) {
    $script:State = Read-Utf8Text $script:StatePath | ConvertFrom-Json
  } else {
    $script:State = [pscustomobject]@{
      schema_version = 1
      version = $Version
      started_at = [DateTime]::UtcNow.ToString("o")
      release_notes = ""
      git_sha = ""
      github_run_id = 0
      github_run_url = ""
      artifacts = $null
      urls = $null
      desktop_release_id = ""
      desktop_release_status = ""
      rollout_percent = 0
      stages = [pscustomobject]@{}
    }
  }
}

function Save-State {
  if ($DryRun -or -not $script:StatePath) { return }
  $directory = Split-Path -Parent $script:StatePath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  [IO.File]::WriteAllText($script:StatePath, ($script:State | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}

function Set-StateValue([string]$Name, $Value) {
  if ($null -eq $script:State.PSObject.Properties[$Name]) { $script:State | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
  else { $script:State.$Name = $Value }
  Save-State
}

function Complete-StateStage([string]$Name) {
  if ($null -eq $script:State.stages.PSObject.Properties[$Name]) {
    $script:State.stages | Add-Member -NotePropertyName $Name -NotePropertyValue ([DateTime]::UtcNow.ToString("o"))
  } else {
    $script:State.stages.$Name = [DateTime]::UtcNow.ToString("o")
  }
  Save-State
}

function Get-DesktopVersions {
  $packagePath = Join-Path $script:RepositoryRoot "apps/desktop/package.json"
  $tauriPath = Join-Path $script:RepositoryRoot "apps/desktop/src-tauri/tauri.conf.json"
  $cargoPath = Join-Path $script:RepositoryRoot "apps/desktop/src-tauri/Cargo.toml"
  $packageVersion = [string]((Read-Utf8Text $packagePath | ConvertFrom-Json).version)
  $tauriVersion = [string]((Read-Utf8Text $tauriPath | ConvertFrom-Json).version)
  $cargoMatch = [regex]::Match((Read-Utf8Text $cargoPath), '(?m)^version\s*=\s*"([^"]+)"')
  if (-not $cargoMatch.Success) { Fail "无法读取 Cargo.toml 版本号" }
  return [pscustomobject]@{ package = $packageVersion; tauri = $tauriVersion; cargo = $cargoMatch.Groups[1].Value }
}

function Set-DesktopVersion([string]$NewVersion) {
  Assert-SemVer $NewVersion
  $files = @(
    @{ Path = "apps/desktop/package.json"; Pattern = '(?m)^(\s*"version"\s*:\s*")[^"]+("\s*,?)'; Replacement = "`${1}$NewVersion`${2}" },
    @{ Path = "apps/desktop/src-tauri/tauri.conf.json"; Pattern = '(?m)^(\s*"version"\s*:\s*")[^"]+("\s*,?)'; Replacement = "`${1}$NewVersion`${2}" },
    @{ Path = "apps/desktop/src-tauri/Cargo.toml"; Pattern = '(?m)^(version\s*=\s*")[^"]+("\s*)$'; Replacement = "`${1}$NewVersion`${2}" }
  )
  foreach ($file in $files) {
    $path = Join-Path $script:RepositoryRoot $file.Path
    $content = Read-Utf8Text $path
    $regex = [regex]::new($file.Pattern)
    if (-not $regex.IsMatch($content)) { Fail "无法更新版本号：$($file.Path)" }
    if (-not $DryRun) {
      $updated = $regex.Replace($content, $file.Replacement, 1)
      [IO.File]::WriteAllText($path, $updated, [Text.UTF8Encoding]::new($false))
    }
  }
}

function Invoke-Check {
  Write-Step "检查发布环境"
  Assert-Command git
  Assert-Command npm.cmd
  Assert-Command ssh
  Assert-Command scp
  Assert-Config -RequireServer -RequireAdmin -RequireSigning
  $versions = Get-DesktopVersions
  if ($versions.package -ne $versions.tauri -or $versions.package -ne $versions.cargo) {
    Fail "客户端版本号不一致：package=$($versions.package)，tauri=$($versions.tauri)，cargo=$($versions.cargo)"
  }
  Invoke-Native git @("diff", "--check")
  Write-Host "客户端当前版本：$($versions.package)"
  Write-Host "发布环境基础检查通过。"
}

function Invoke-Prepare {
  Write-Step "升级版本并执行发布前检查"
  Assert-SemVer $Version
  $branch = [string](Get-PropertyValue $script:Config "github_branch" "main")
  $currentBranch = Invoke-Native git @("branch", "--show-current") -Capture
  if ($currentBranch -ne $branch) { Fail "当前分支是 $currentBranch，发布分支必须是 $branch" }

  $dirtyBefore = Invoke-Native git @("status", "--porcelain") -Capture
  if ($dirtyBefore -and -not $CommitAllChanges) {
    if ($NonInteractive -or -not (Confirm-Action "工作区已有改动，是否把全部改动纳入本次发布？" -DefaultNo)) {
      Fail "工作区不干净。检查改动后使用 -CommitAllChanges 明确纳入本次发布。"
    }
  }

  $versions = Get-DesktopVersions
  if ($versions.package -ne $versions.tauri -or $versions.package -ne $versions.cargo) { Fail "修改前的三个客户端版本号不一致" }
  if ((Compare-SemVer $Version $versions.package) -lt 0) { Fail "新版本 $Version 不能低于当前版本 $($versions.package)" }
  if ($Version -ne $versions.package) {
    Write-Host "版本升级：$($versions.package) → $Version"
    Set-DesktopVersion $Version
  } else {
    Write-Host "三个客户端版本号已经是 $Version"
  }

  $notes = Get-ReleaseNotes
  if (-not $notes) { Fail "更新说明不能为空" }
  Set-StateValue "release_notes" $notes

  if ([bool](Get-PropertyValue $script:Config "run_npm_ci" $true)) {
    Invoke-Native npm.cmd @("ci", "--no-audit", "--no-fund")
  }
  Invoke-Native npm.cmd @("run", "typecheck")
  Invoke-Native npm.cmd @("run", "build:platform")
  if ([bool](Get-PropertyValue $script:Config "run_python_tests" $true)) {
    Invoke-Native npm.cmd @("run", "test:python")
  }
  Invoke-Native git @("diff", "--check")
  Invoke-Native git @("add", "-A")
  Invoke-Native git @("diff", "--cached", "--check")
  $cached = Invoke-Native git @("diff", "--cached", "--name-only") -Capture
  if ($cached) {
    Invoke-Native git @("commit", "-m", "Release platform and desktop v$Version")
  } else {
    Write-Host "没有需要提交的新改动，沿用当前提交。"
  }
  Invoke-Native git @("push", "origin", $branch)
  $sha = Invoke-Native git @("rev-parse", "HEAD") -Capture
  Set-StateValue "git_sha" $sha
  Complete-StateStage "prepare"
}

function Get-GitHubHeaders([string]$Token) {
  return @{
    Authorization = "Bearer $Token"
    Accept = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent" = "aivs-local-release"
  }
}

function Invoke-GitHubJson([string]$Uri, [string]$Token, [string]$Method = "GET", $Body = $null) {
  $parameters = @{ Uri = $Uri; Method = $Method; Headers = Get-GitHubHeaders $Token }
  if ($null -ne $Body) {
    $parameters.ContentType = "application/json; charset=utf-8"
    $parameters.Body = ConvertTo-Utf8JsonBytes $Body 8
  }
  return Invoke-RestMethod @parameters
}

function Invoke-DeployPlatform {
  Write-Step "触发后台和 API 的生产部署"
  $token = Read-PlainSecret "AIVS_GITHUB_TOKEN" "请输入 GitHub Token"
  $owner = [string](Get-PropertyValue $script:Config "github_owner")
  $repository = [string](Get-PropertyValue $script:Config "github_repository")
  $workflow = [string](Get-PropertyValue $script:Config "github_workflow" "platform.yml")
  $branch = [string](Get-PropertyValue $script:Config "github_branch" "main")
  $sha = Invoke-Native git @("rev-parse", "HEAD") -Capture
  if ($DryRun) {
    Write-Host "[DryRun] 将触发 $owner/$repository 的 $workflow，并部署提交 $sha"
    return
  }
  $base = "https://api.github.com/repos/$owner/$repository"
  $started = [DateTime]::UtcNow.AddMinutes(-1)
  Invoke-GitHubJson "$base/actions/workflows/$workflow/dispatches" $token "POST" @{ ref = $branch; inputs = @{ deploy = "true" } } | Out-Null
  Write-Host "GitHub Actions 已触发，正在查找运行记录……"

  $run = $null
  $discoverDeadline = [DateTime]::UtcNow.AddMinutes(5)
  while (-not $run -and [DateTime]::UtcNow -lt $discoverDeadline) {
    Start-Sleep -Seconds 10
    $response = Invoke-GitHubJson "$base/actions/workflows/$workflow/runs?event=workflow_dispatch&branch=$branch&per_page=20" $token
    $run = @($response.workflow_runs) | Where-Object {
      $_.head_sha -eq $sha -and [DateTime]::Parse($_.created_at).ToUniversalTime() -ge $started
    } | Sort-Object created_at -Descending | Select-Object -First 1
  }
  if (-not $run) { Fail "5 分钟内没有找到刚触发的 GitHub Actions 运行" }
  Set-StateValue "github_run_id" ([int64]$run.id)
  Set-StateValue "github_run_url" ([string]$run.html_url)
  Write-Host "运行地址：$($run.html_url)"

  $timeout = [int](Get-PropertyValue $script:Config "github_deploy_timeout_minutes" 120)
  $deadline = [DateTime]::UtcNow.AddMinutes($timeout)
  $lastStatus = ""
  while ([DateTime]::UtcNow -lt $deadline) {
    $run = Invoke-GitHubJson "$base/actions/runs/$($run.id)" $token
    $statusText = "$($run.status)/$($run.conclusion)"
    if ($statusText -ne $lastStatus) {
      Write-Host "GitHub Actions：$statusText"
      if ($run.status -eq "waiting") { Write-Host "工作流正在等待 production 环境审批。请在运行页面批准后继续。" -ForegroundColor Yellow }
      $lastStatus = $statusText
    }
    if ($run.status -eq "completed") {
      if ($run.conclusion -ne "success") { Fail "生产部署失败：$($run.html_url)" }
      Set-StateValue "github_run_url" ([string]$run.html_url)
      Complete-StateStage "deploy_platform"
      Write-Host "后台和 API 部署成功。"
      return
    }
    Start-Sleep -Seconds 20
  }
  Fail "等待 GitHub Actions 超时：$($run.html_url)"
}

function Get-SshBaseArguments {
  $keyPath = Resolve-RepositoryPath ([string](Get-PropertyValue $script:Config "ssh_key_path"))
  $port = [int](Get-PropertyValue $script:Config "server_port" 22)
  return @("-i", $keyPath, "-p", "$port", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15")
}

function Invoke-Server([string]$RemoteCommand, [switch]$Capture) {
  Assert-Config -RequireServer
  $target = "{0}@{1}" -f (Get-PropertyValue $script:Config "server_user"), (Get-PropertyValue $script:Config "server_host")
  $arguments = @(Get-SshBaseArguments) + @($target, $RemoteCommand)
  return Invoke-Native ssh $arguments -Capture:$Capture
}

function Test-PlatformHealth {
  Write-Step "检查生产服务器健康状态"
  Invoke-Server "set -eu; cd /opt/aivs/current; docker compose --env-file release.env ps; curl --fail --silent http://127.0.0.1:3101/api/v1/health; curl --fail --silent http://127.0.0.1:3200/ >/dev/null" | Out-Null
  Write-Host "生产 API 和管理后台健康检查通过。"
}

function Invoke-BuildClient {
  Write-Step "构建并签名 Windows 客户端"
  Assert-Config -RequireSigning
  $versions = Get-DesktopVersions
  if ($versions.package -ne $Version -or $versions.tauri -ne $Version -or $versions.cargo -ne $Version) {
    Fail "客户端版本号不是目标版本 $Version"
  }
  $privateKeyBefore = [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY", "Process")
  $passwordBefore = [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "Process")
  try {
    if (-not $privateKeyBefore) {
      $env:TAURI_SIGNING_PRIVATE_KEY = Resolve-RepositoryPath ([string](Get-PropertyValue $script:Config "signing_private_key_path"))
    }
    if (-not $passwordBefore) {
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-PlainSecret "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" "请输入 Updater 签名私钥密码"
    }
    $builder = Join-Path $script:RepositoryRoot "build-windows-installer.bat"
    Invoke-Native $builder @("--check")
    Invoke-Native $builder @("--no-pause")
  } finally {
    if (-not $privateKeyBefore) { Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue }
    if (-not $passwordBefore) { Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue }
  }
  if ($DryRun) { return }

  $bundle = Join-Path $script:RepositoryRoot "apps/desktop/src-tauri/target/release/bundle/nsis"
  $exe = Get-ChildItem -LiteralPath $bundle -File -Filter "*.exe" | Where-Object Name -Match ([regex]::Escape($Version)) | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $exe) { Fail "没有找到版本 $Version 的 EXE 安装包" }
  $signaturePath = "$($exe.FullName).sig"
  if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf)) { Fail "没有找到在线升级签名：$signaturePath" }

  $artifactDirectory = Join-Path (Split-Path -Parent $script:StatePath) "artifacts"
  New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
  $baseName = "dreamotion-$Version-x64-setup"
  $targetExe = Join-Path $artifactDirectory "$baseName.exe"
  $targetSignature = Join-Path $artifactDirectory "$baseName.exe.sig"
  Copy-Item -LiteralPath $exe.FullName -Destination $targetExe -Force
  Copy-Item -LiteralPath $signaturePath -Destination $targetSignature -Force
  $artifacts = [pscustomobject]@{
    directory = $artifactDirectory
    exe = $targetExe
    updater = $targetExe
    signature = $targetSignature
    exe_sha256 = (Get-FileHash -LiteralPath $targetExe -Algorithm SHA256).Hash.ToLowerInvariant()
    updater_sha256 = (Get-FileHash -LiteralPath $targetExe -Algorithm SHA256).Hash.ToLowerInvariant()
    signature_sha256 = (Get-FileHash -LiteralPath $targetSignature -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  Set-StateValue "artifacts" $artifacts
  Complete-StateStage "build_client"
  Write-Host "客户端产物已整理到：$artifactDirectory"
}

function Assert-ArtifactState {
  $artifacts = Get-PropertyValue $script:State "artifacts"
  if (-not $artifacts) { Fail "缺少客户端构建记录，请先运行 BuildClient" }
  foreach ($name in @("exe", "updater", "signature")) {
    $path = [string]$artifacts.$name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail "客户端产物不存在：$path" }
  }
}

function Get-RemoteSha256([string]$RemotePath) {
  $output = Invoke-Server "sha256sum $RemotePath" -Capture
  if ($DryRun) { return "" }
  return ($output -split '\s+')[0].ToLowerInvariant()
}

function Invoke-UploadClient {
  Write-Step "上传客户端到 /client/$Version"
  Assert-Config -RequireServer
  Assert-ArtifactState
  $remoteRoot = ([string](Get-PropertyValue $script:Config "remote_client_root")).TrimEnd('/')
  $remoteDirectory = "$remoteRoot/$Version"
  $baseName = "dreamotion-$Version-x64-setup"
  $files = @(
    @{ Local = [string]$script:State.artifacts.exe; Remote = "$baseName.exe"; Hash = [string]$script:State.artifacts.exe_sha256 },
    @{ Local = [string]$script:State.artifacts.signature; Remote = "$baseName.exe.sig"; Hash = [string]$script:State.artifacts.signature_sha256 }
  )
  $exists = Invoke-Server "if [ -d $remoteDirectory ]; then printf exists; else printf missing; fi" -Capture
  if ($exists -eq "exists") {
    Write-Host "服务器版本目录已经存在，将验证文件是否完全一致。"
    foreach ($file in $files) {
      $remoteHash = Get-RemoteSha256 "$remoteDirectory/$($file.Remote)"
      if ($remoteHash -ne $file.Hash) { Fail "服务器已有同版本但文件不同，禁止覆盖：$($file.Remote)" }
    }
  } else {
    $incoming = "$remoteRoot/.incoming-$Version-$PID"
    Invoke-Server "set -eu; test ! -e $remoteDirectory; test ! -e $incoming; mkdir -m 755 $incoming" | Out-Null
    $keyPath = Resolve-RepositoryPath ([string](Get-PropertyValue $script:Config "ssh_key_path"))
    $port = [int](Get-PropertyValue $script:Config "server_port" 22)
    $target = "{0}@{1}:{2}/" -f (Get-PropertyValue $script:Config "server_user"), (Get-PropertyValue $script:Config "server_host"), $incoming
    $scpArguments = @("-i", $keyPath, "-P", "$port", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes") + @($files.Local) + @($target)
    Invoke-Native scp $scpArguments
    Invoke-Server "chmod 644 $incoming/*" | Out-Null
    foreach ($file in $files) {
      $remoteHash = Get-RemoteSha256 "$incoming/$($file.Remote)"
      if (-not $DryRun -and $remoteHash -ne $file.Hash) { Fail "上传后哈希不一致：$($file.Remote)" }
    }
    Invoke-Server "set -eu; test ! -e $remoteDirectory; mv $incoming $remoteDirectory" | Out-Null
  }

  $site = ([string](Get-PropertyValue $script:Config "site_origin")).TrimEnd('/')
  $urls = [pscustomobject]@{
    exe = "$site/client/$Version/$baseName.exe"
    updater = "$site/client/$Version/$baseName.exe"
    signature = "$site/client/$Version/$baseName.exe.sig"
  }
  Set-StateValue "urls" $urls
  if (-not $DryRun) {
    Invoke-WebRequest -Uri $urls.exe -Method Head -UseBasicParsing | Out-Null
    Invoke-WebRequest -Uri $urls.signature -Method Head -UseBasicParsing | Out-Null
    $temporary = Join-Path ([IO.Path]::GetTempPath()) "aivs-$Version-$PID.exe"
    try {
      Invoke-WebRequest -Uri $urls.updater -OutFile $temporary -UseBasicParsing
      $downloadedHash = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($downloadedHash -ne $script:State.artifacts.updater_sha256) { Fail "HTTPS 下载文件与本地更新包哈希不一致" }
    } finally {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }
  Complete-StateStage "upload_client"
  Write-Host "客户端上传并验证完成：$($urls.exe)"
}

function Invoke-AivsApi([string]$Path, [string]$Method = "GET", $Body = $null, [string]$Token = "") {
  $base = ([string](Get-PropertyValue $script:Config "api_base_url")).TrimEnd('/')
  $parameters = @{ Uri = "$base$Path"; Method = $Method; Headers = @{ Accept = "application/json" } }
  if ($Token) { $parameters.Headers.Authorization = "Bearer $Token" }
  if ($null -ne $Body) {
    $parameters.ContentType = "application/json; charset=utf-8"
    $parameters.Body = ConvertTo-Utf8JsonBytes $Body 10
  }
  try {
    return Invoke-RestMethod @parameters
  } catch {
    $response = $_.Exception.Response
    $statusCode = if ($response -and $response.StatusCode) { [int]$response.StatusCode } else { 0 }
    $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { [string]$_.ErrorDetails.Message } else { "" }
    if (-not $detail -and $response) {
      try {
        $stream = $response.GetResponseStream()
        if ($stream) {
          $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
          try { $detail = $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
      } catch { }
    }
    $apiMessage = $detail.Trim()
    if ($apiMessage) {
      try {
        $errorBody = $apiMessage | ConvertFrom-Json
        $rawMessage = Get-PropertyValue $errorBody "message" (Get-PropertyValue $errorBody "msg" $apiMessage)
        $apiMessage = if ($rawMessage -is [System.Array]) { @($rawMessage) -join "；" } else { [string]$rawMessage }
      } catch { }
    }
    if (-not $apiMessage) { $apiMessage = $_.Exception.Message }
    $statusLabel = if ($statusCode) { "HTTP $statusCode" } else { "无 HTTP 状态码" }
    Fail "API $Method $Path 请求失败（$statusLabel）：$apiMessage"
  }
}

function Get-AdminToken {
  Assert-Config -RequireAdmin
  $email = [string](Get-PropertyValue $script:Config "admin_email")
  $password = Read-PlainSecret "AIVS_ADMIN_PASSWORD" "请输入生产管理后台密码"
  try {
    Write-Info "登录生产管理 API：$email"
    $login = Invoke-AivsApi "/admin/auth/login" "POST" @{ email = $email; password = $password }
    if (-not $login.access_token) { Fail "管理后台登录没有返回 access_token" }
    return [string]$login.access_token
  } finally {
    $password = $null
  }
}

function Invoke-PublishClient {
  Write-Step "更新公开下载地址并创建在线升级版本"
  Assert-ArtifactState
  $urls = Get-PropertyValue $script:State "urls"
  if (-not $urls) { Fail "缺少上传地址，请先运行 UploadClient" }
  if ($DryRun) {
    Write-Host "[DryRun] 将更新安装包地址、创建在线升级版本并按配置决定是否发布。"
    return
  }
  $notes = Get-ReleaseNotes
  if (-not $notes) { Fail "更新说明不能为空" }
  Set-StateValue "release_notes" $notes
  $token = Get-AdminToken
  Write-Info "读取当前软件下载配置"
  $downloads = Invoke-AivsApi "/admin/distribution/downloads" "GET" $null $token
  $downloadBody = @{
    windows_download_enabled = $true
    windows_download_url = [string]$script:State.urls.exe
    macos_download_enabled = [bool]$downloads.macos_download_enabled
    macos_download_url = [string]$downloads.macos_download_url
    revision = [int]$downloads.revision
  }
  Write-Info "启用 Windows 下载地址"
  Invoke-AivsApi "/admin/distribution/downloads" "PATCH" $downloadBody $token | Out-Null

  $rollout = if ($RolloutPercent -gt 0) { $RolloutPercent } else { [int](Get-PropertyValue $script:Config "initial_rollout_percent" 10) }
  if ($rollout -lt 1 -or $rollout -gt 100) { Fail "灰度比例必须为 1 到 100" }
  $channel = [string](Get-PropertyValue $script:Config "release_channel" "stable")
  $signature = (Read-Utf8Text ([string]$script:State.artifacts.signature)).Trim()
  $releaseBody = @{
    version = $Version
    channel = $channel
    notes = $notes
    min_supported_version = [string](Get-PropertyValue $script:Config "minimum_supported_version" "0.0.0")
    rollout_percent = $rollout
    artifacts = @(@{
      target = "windows"
      arch = "x86_64"
      url = [string]$script:State.urls.updater
      signature = $signature
    })
  }
  Write-Info "读取线上客户端版本记录"
  $releaseResponse = Invoke-AivsApi "/admin/desktop-releases" "GET" $null $token
  $releases = @((Get-ApiCollection $releaseResponse "客户端版本列表接口" "version").items)
  $release = $releases | Where-Object { $_.version -eq $Version -and $_.channel -eq $channel } | Select-Object -First 1
  if (-not $release) {
    Write-Info "创建 v$Version 客户端版本草稿"
    $release = (Get-ApiObject (Invoke-AivsApi "/admin/desktop-releases" "POST" $releaseBody $token) "创建客户端版本接口").item
  } elseif ($release.status -eq "DRAFT") {
    $release = (Get-ApiObject (Invoke-AivsApi "/admin/desktop-releases/$($release.id)" "PATCH" $releaseBody $token) "更新客户端版本接口").item
  } elseif ($release.status -eq "PUBLISHED") {
    $artifact = @($release.artifacts) | Where-Object { $_.target -eq "windows" -and $_.arch -eq "x86_64" } | Select-Object -First 1
    if (-not $artifact -or $artifact.url -ne $script:State.urls.updater -or $artifact.signature -ne $signature) {
      Fail "线上已发布同版本，但更新包地址或签名不同"
    }
    Write-Host "v$Version 已发布，保留现有发布记录。"
  } else {
    Fail "v$Version 已归档，必须提升版本号后重新发布"
  }

  $shouldPublish = $PublishUpdate -or [bool](Get-PropertyValue $script:Config "publish_update_automatically" $false)
  if ($release.status -eq "DRAFT" -and $shouldPublish) {
    Write-Info "发布 v$Version 客户端版本"
    $release = (Get-ApiObject (Invoke-AivsApi "/admin/desktop-releases/$($release.id)/publish" "POST" @{} $token) "发布客户端版本接口").item
  }
  Set-StateValue "desktop_release_id" ([string]$release.id)
  Set-StateValue "desktop_release_status" ([string]$release.status)
  Set-StateValue "rollout_percent" ([int]$release.rollout_percent)
  Complete-StateStage "publish_client"
  Write-Host "公开下载地址已更新；客户端版本状态：$($release.status)，灰度：$($release.rollout_percent)%"
}

function Invoke-Verify {
  Write-Step "执行最终发布验收"
  Assert-Config -RequireServer
  Assert-ArtifactState
  Test-PlatformHealth
  $urls = Get-PropertyValue $script:State "urls"
  if (-not $urls) { Fail "缺少客户端 URL" }
  if (-not $DryRun) {
    Invoke-WebRequest -Uri ([string]$script:State.urls.exe) -Method Head -UseBasicParsing | Out-Null
    Invoke-WebRequest -Uri ([string]$script:State.urls.updater) -Method Head -UseBasicParsing | Out-Null
    Invoke-WebRequest -Uri "$(([string](Get-PropertyValue $script:Config "site_origin")).TrimEnd('/'))/download" -Method Get -UseBasicParsing | Out-Null

    if ((Get-PropertyValue $script:State "desktop_release_status" "") -eq "PUBLISHED") {
      $api = ([string](Get-PropertyValue $script:Config "api_base_url")).TrimEnd('/')
      $found = $false
      for ($i = 0; $i -lt 500 -and -not $found; $i++) {
        $response = Invoke-WebRequest -Uri "$api/client-config/desktop-updates/windows/x86_64/0.0.0?channel=stable" -Headers @{ "x-update-cohort" = "release-verification-$i" } -UseBasicParsing
        if ($response.StatusCode -eq 200) {
          $payload = $response.Content | ConvertFrom-Json
          if ($payload.version -eq $Version -and $payload.url -eq $script:State.urls.updater) { $found = $true }
        }
      }
      if (-not $found) { Fail "在线升级清单未返回 v$Version；检查发布状态、渠道和灰度" }
    }
  }
  Complete-StateStage "verify"
  Write-Host "v$Version 自动发布流程验收通过。" -ForegroundColor Green
  Write-Host "仍建议使用一台旧版本客户端实际完成一次下载、签名校验、安装和重启。" -ForegroundColor Yellow
}

function Invoke-Promote {
  Write-Step "调整客户端灰度比例"
  $targetRollout = if ($RolloutPercent -gt 0) { $RolloutPercent } else { 100 }
  if ($targetRollout -lt 1 -or $targetRollout -gt 100) { Fail "灰度比例必须为 1 到 100" }
  if ($DryRun) { Write-Host "[DryRun] 将把 v$Version 灰度调整为 $targetRollout%"; return }
  $token = Get-AdminToken
  $channel = [string](Get-PropertyValue $script:Config "release_channel" "stable")
  $releaseResponse = Invoke-AivsApi "/admin/desktop-releases" "GET" $null $token
  $releases = @((Get-ApiCollection $releaseResponse "客户端版本列表接口" "version").items)
  $release = $releases | Where-Object { $_.version -eq $Version -and $_.channel -eq $channel -and $_.status -eq "PUBLISHED" } | Select-Object -First 1
  if (-not $release) { Fail "没有找到已发布的 v$Version" }
  $updated = (Get-ApiObject (Invoke-AivsApi "/admin/desktop-releases/$($release.id)/rollout" "PATCH" @{ rollout_percent = $targetRollout } $token) "调整灰度接口").item
  Set-StateValue "rollout_percent" ([int]$updated.rollout_percent)
  Complete-StateStage "promote"
  Write-Host "v$Version 灰度已调整为 $($updated.rollout_percent)%"
}

function Show-DryRunPlan {
  Write-Step "DryRun 发布计划"
  Invoke-Check
  Write-Host @"
将按顺序执行：
1. 同步三个客户端版本号并运行本地检查
2. 提交并推送 main
3. 调用 GitHub Actions 部署后台和 API
4. 检查服务器健康状态
5. 使用 Tauri 私钥构建并签名 Windows 客户端
6. 原子上传到 /client/$Version
7. 更新公开 EXE 地址并创建在线升级版本
8. 按配置发布小灰度版本并验证升级清单
"@
}

Push-Location $script:RepositoryRoot
try {
  if ($Stage -eq "Initialize") { Initialize-Config; return }
  Load-Config
  if (-not $Version -and $Stage -notin @("Check")) { Fail "阶段 $Stage 需要 -Version，例如 -Version 0.2.1" }
  if ($Version) { Initialize-State }
  if ($DryRun -and $Stage -eq "All") { Show-DryRunPlan; return }

  switch ($Stage) {
    "Check" { Invoke-Check }
    "Prepare" { Invoke-Prepare }
    "DeployPlatform" { Invoke-DeployPlatform; Test-PlatformHealth }
    "BuildClient" { Invoke-BuildClient }
    "UploadClient" { Invoke-UploadClient }
    "PublishClient" { Invoke-PublishClient }
    "Verify" { Invoke-Verify }
    "Promote" { Invoke-Promote }
    "All" {
      Invoke-Prepare
      Invoke-DeployPlatform
      Test-PlatformHealth
      Invoke-BuildClient
      Invoke-UploadClient
      Invoke-PublishClient
      Invoke-Verify
    }
  }
} catch {
  Write-Host "`n发布失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "修复后可以使用同一版本号和对应 -Stage 从失败阶段继续。" -ForegroundColor Yellow
  exit 1
} finally {
  Pop-Location
}
