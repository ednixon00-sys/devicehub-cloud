# agent.ps1 — robust DeviceHub agent
# - Polls /api/pull?deviceId=...
# - Runs queued commands
# - If command starts with "__PSB64__:", decodes UTF-8 base64, writes a temp .ps1, executes with 64-bit PowerShell

$BaseUrl  = $env:BASE_URL; if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = "https://YOUR_APP_DOMAIN" }
$DeviceId = $env:DEVICE_ID; if ([string]::IsNullOrWhiteSpace($DeviceId)) { $DeviceId = "$env:COMPUTERNAME" }
$PollSec  = 5

function Get-PS64Path {
  $win = $env:WINDIR
  $p1 = Join-Path $win "System32\WindowsPowerShell\v1.0\powershell.exe"
  $p2 = Join-Path $win "Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  if (Test-Path $p1) { return $p1 }
  if (Test-Path $p2) { return $p2 }
  $cmd = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  "powershell.exe"
}

$PS64 = Get-PS64Path

function HttpGetJson($url) {
  try { return Invoke-RestMethod -Method GET -Uri $url -Headers @{ "Accept"="application/json" } -TimeoutSec 30 } catch { $null }
}

function Run-External($exe, $args) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = $args
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
  @{ code = $p.ExitCode; output = ($p.StandardOutput.ReadToEnd() + "`n" + $p.StandardError.ReadToEnd()) }
}

function Run-PSB64($payload) {
  $b64 = $payload.Substring("__PSB64__:".Length)
  $script = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
  $dir = "C:\ProgramData\DeviceHub"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = Join-Path $dir ("cmd-" + [Guid]::NewGuid().ToString("N") + ".ps1")
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tmp, $script, $utf8NoBom)
  try { Run-External $PS64 "-NoLogo -NoProfile -ExecutionPolicy Bypass -NonInteractive -File `"$tmp`"" }
  finally { try { Remove-Item -Force -ErrorAction SilentlyContinue $tmp } catch {} }
}

function Run-Plain($command) {
  Run-External $env:ComSpec "/c $command"
}

function Heartbeat {
  try {
    $body = @{
      deviceId = $DeviceId
      hostname = $env:COMPUTERNAME
      username = $env:USERNAME
      os       = (Get-CimInstance Win32_OperatingSystem).Caption
    } | ConvertTo-Json
    Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/heartbeat" -Headers @{ "Content-Type"="application/json" } -Body $body | Out-Null
  } catch {}
}

while ($true) {
  Heartbeat
  $resp = HttpGetJson "$BaseUrl/api/pull?deviceId=$([uri]::EscapeDataString($DeviceId))"
  if ($null -ne $resp -and $resp.command) {
    $cmd = [string]$resp.command
    try {
      if ($cmd.StartsWith("__PSB64__:")) { $r = Run-PSB64 $cmd } else { $r = Run-Plain $cmd }
      # (Optional) POST $r.code/$r.output to a results endpoint if you add one later
    } catch { }
  }
  Start-Sleep -Seconds $PollSec
}
