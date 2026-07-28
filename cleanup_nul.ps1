try {
    # Remove nested exporter/exporter folder using .NET (handles reserved names like 'nul')
    [System.IO.Directory]::Delete('D:\self project\S3 bucket\exporter\exporter', $true)
    Write-Output "REMOVED: exporter/exporter"
} catch {
    Write-Output "ERROR: $($_.Exception.Message)"
}

# Check if it's gone
if (Test-Path 'D:\self project\S3 bucket\exporter\exporter') {
    Write-Output "STILL EXISTS: exporter/exporter"
} else {
    Write-Output "CONFIRMED: exporter/exporter is gone"
}
