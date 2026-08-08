param(
    [Parameter(Mandatory=$true)][string]$BaseUrl,
    [Parameter(Mandatory=$true)][string]$GatewayKey,
    [switch]$CallHaloRead
)

$ErrorActionPreference = "Stop"
$base = $BaseUrl.TrimEnd('/')
$key = [uri]::EscapeDataString($GatewayKey)
$mcp = "$base/mcp/$key"

Write-Host "== GET /health ==" -ForegroundColor Cyan
$health = Invoke-RestMethod -Method Get -Uri "$base/health"
$health | ConvertTo-Json -Depth 10
if ($health.tool_count -ne 12) {
    throw "Expected health.tool_count=12, got $($health.tool_count)"
}

$headers = @{
    Accept = "application/json, text/event-stream"
    "Content-Type" = "application/json"
}

Write-Host "`n== initialize ==" -ForegroundColor Cyan
$init = @{
    jsonrpc = "2.0"
    id = 1
    method = "initialize"
    params = @{
        protocolVersion = "2025-11-25"
        capabilities = @{}
        clientInfo = @{ name = "powershell-smoke-test"; version = "1.0.0" }
    }
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri $mcp -Headers $headers -Body $init | ConvertTo-Json -Depth 20

Write-Host "`n== notifications/initialized ==" -ForegroundColor Cyan
$initialized = @{ jsonrpc = "2.0"; method = "notifications/initialized" } | ConvertTo-Json
$response = Invoke-WebRequest -Method Post -Uri $mcp -Headers $headers -Body $initialized
Write-Host "HTTP $($response.StatusCode)"

Write-Host "`n== tools/list ==" -ForegroundColor Cyan
$list = @{ jsonrpc = "2.0"; id = 2; method = "tools/list"; params = @{} } | ConvertTo-Json -Depth 10
$result = Invoke-RestMethod -Method Post -Uri $mcp -Headers $headers -Body $list
$result | ConvertTo-Json -Depth 50
$toolCount = @($result.result.tools).Count
if ($toolCount -ne 12) {
    throw "Expected exactly 12 MCP tools, got $toolCount"
}
Write-Host "Verified: exactly 12 MCP tools." -ForegroundColor Green

if ($CallHaloRead) {
    Write-Host "`n== tools/call halo_query_articles ==" -ForegroundColor Cyan
    $call = @{
        jsonrpc = "2.0"
        id = 3
        method = "tools/call"
        params = @{
            name = "halo_query_articles"
            arguments = @{ page = 0; size = 3; publish_status = "ANY" }
        }
    } | ConvertTo-Json -Depth 10
    Invoke-RestMethod -Method Post -Uri $mcp -Headers $headers -Body $call | ConvertTo-Json -Depth 30
}
