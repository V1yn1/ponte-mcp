param([string]$Workspace = "")
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Instale o Node.js LTS (22.12 ou superior), feche e reabra o terminal. https://nodejs.org/"
}
$PonteNodeVersion = [version]((node -p "process.versions.node").Trim())
if ($PonteNodeVersion -lt [version]"22.12.0") { throw "Node.js 22.12 ou superior necessario." }
& npm.cmd ci --ignore-scripts --no-fund
if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar as dependencias." }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "Falha na compilacao." }
if ($Workspace) { & node dist/cli.js init --workspace $Workspace }
else { & node dist/cli.js init }
if ($LASTEXITCODE -ne 0) { throw "Falha na configuracao." }
Write-Host ""
Write-Host "Instalacao concluida. Execute npm.cmd start."
Write-Host "Em outro terminal, execute node dist/cli.js token admin para acessar o painel."
