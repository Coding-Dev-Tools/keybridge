# Run as Administrator to install Command Code Proxy as a Windows scheduled task.
# Right-click PowerShell -> Run as Administrator, then: .\install-autostart.ps1
#
# Set these environment variables before running, or edit the values below:
#   PROXY_PORT (default: 3456)
#   COMMAND_CODE_API_KEY (required)

$port = if ($env:PROXY_PORT) { $env:PROXY_PORT } else { "3456" }
$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cmdArgs = "/c cd /d `"$repoDir`" && set PROXY_PORT=$port && node proxy.js"
if ($env:COMMAND_CODE_API_KEY) {
  $cmdArgs = "/c cd /d `"$repoDir`" && set PROXY_PORT=$port && set COMMAND_CODE_API_KEY=$env:COMMAND_CODE_API_KEY && node proxy.js"
}

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmdArgs
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "CommandCodeProxy" -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host "Command Code Proxy auto-start installed. It will run on every boot."
