# Builds the protected copy of the calendar and deploys the worker.
# Run from the worker folder:  .\deploy.ps1
$ErrorActionPreference = "Stop"
$src = Join-Path $PSScriptRoot "..\coverage-calendar.html"
$out = Join-Path $PSScriptRoot "public\index.html"
$legacy = '"https://mantledb.sh/v2/sss-e7b1c4a9d2f6/plan"'
$html = [System.IO.File]::ReadAllText((Resolve-Path $src), [System.Text.Encoding]::UTF8)
if (-not $html.Contains($legacy)) { throw "Could not find the team plan address in the calendar file." }
$html = $html.Replace($legacy, '"/api/team/plan"')
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
[System.IO.File]::WriteAllText($out, $html, (New-Object System.Text.UTF8Encoding($false)))
Push-Location $PSScriptRoot
try { npx --yes wrangler@4 deploy } finally { Pop-Location }
