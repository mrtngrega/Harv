# Live sync over Tailscale (M10c, docs/PLAN.md §6m): lets the user's other Harv reach this one's
# live port, from Tailscale addresses only (100.64.0.0/10). Harv listens on its Tailscale address
# only, checks the caller's Tailscale account, and every batch is sealed with the sync key.
# Run once, as admin. `-Remove` takes the rule away.
param([switch]$Remove)

$name = 'Harv: live sync over Tailscale (4318)'
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) { Write-Output 'Removed.'; exit 0 }
New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort 4318 `
  -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any | Out-Null
Write-Output "Added: $name"
