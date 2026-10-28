Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -notmatch '--type=' } |
  ForEach-Object { "{0}  {1}  {2}" -f $_.ProcessId, $_.CreationDate.ToString('HH:mm:ss'), $_.CommandLine.Substring(0, [Math]::Min(80, $_.CommandLine.Length)) }
