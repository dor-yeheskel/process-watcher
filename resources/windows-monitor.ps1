param(
    [Parameter(Mandatory = $true)]
    [int]$TargetProcessId,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedIdentity,
    [Parameter(Mandatory = $true)]
    [string]$EventPath,
    [Parameter(Mandatory = $true)]
    [string]$CancelPath
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$reason = 'process_exited'

while ($true) {
    if (Test-Path -LiteralPath $CancelPath) {
        Remove-Item -LiteralPath $CancelPath -Force -ErrorAction SilentlyContinue
        exit 0
    }

    try {
        $processInfo = Get-Process -Id $TargetProcessId -ErrorAction Stop
        $identity = 'windows:' + $processInfo.StartTime.ToUniversalTime().Ticks
        if ($identity -ne $ExpectedIdentity) {
            $reason = 'pid_reused'
            break
        }
    }
    catch {
        break
    }

    [System.Threading.Thread]::Sleep(500)
}

$event = [ordered]@{
    endedAt = (Get-Date).ToUniversalTime().ToString('o')
    reason = $reason
}
$temporaryPath = "$EventPath.$PID.tmp"
[System.IO.File]::WriteAllText($temporaryPath, (($event | ConvertTo-Json -Compress) + [Environment]::NewLine), $utf8)
Move-Item -LiteralPath $temporaryPath -Destination $EventPath -Force