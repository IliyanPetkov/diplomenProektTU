<#
 =====================================================================
 CloudFS (ТУ-София, Дипломен проект) - Интелигентен Setup за Windows 10
 =====================================================================
 Инсталира Chocolatey + Node.js, проверява средата и стартира сървъра.

 УПОТРЕБА (като Администратор):
   PowerShell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1

 Опции:
   -SkipInstall   : пропуска инсталациите, само проверява и стартира
   -Service name  : стартира само един сервиз (напр. -Service gateway)
 =====================================================================
#>
param(
    [switch]$SkipInstall,
    [string]$Service = ""
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # ускорява Invoke-WebRequest

# ---------------------------------------------------------------------
# Помощни функции за изход
# ---------------------------------------------------------------------
function Write-Step([string]$msg)  { Write-Host "`n[==>] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)    { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red }

$script:FailedChecks = 0
function Register-Failure([string]$msg) {
    Write-Fail $msg
    $script:FailedChecks++
}

# ---------------------------------------------------------------------
# Стъпка 0: Самопроверки на средата
# ---------------------------------------------------------------------
Write-Step "Стъпка 0: Проверка на средата"

# 0.1 Администраторски права (нужни за Chocolatey)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Write-Ok "Скриптът е стартиран с администраторски права."
} else {
    Write-Warn2 "Няма администраторски права - инсталациите може да се провалят."
    Write-Warn2 "Препоръка: десен бутон -> 'Run as Administrator'."
    if (-not $SkipInstall) {
        $script:FailedChecks++
    }
}

# 0.2 Windows версия
$osVer = [Environment]::OSVersion.Version
Write-Ok "Windows версия: $($osVer.Major).$($osVer.Minor) (Build $($osVer.Build))"
if ($osVer.Major -lt 10) { Register-Failure "Изисква се Windows 10 или по-нов." }

# 0.3 .NET Framework >= 4.8 (изискване на Chocolatey)
$dotnetRelease = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full\' -ErrorAction SilentlyContinue).Release
if ($dotnetRelease -ge 528040) {
    Write-Ok ".NET Framework 4.8+ е наличен (Release $dotnetRelease)."
} else {
    Register-Failure ".NET Framework 4.8+ липсва (Release: $dotnetRelease). Инсталирайте го от microsoft.com."
}

# 0.4 Интернет свързаност
try {
    $null = Invoke-WebRequest -Uri 'https://community.chocolatey.org' -UseBasicParsing -TimeoutSec 10 -Method Head
    Write-Ok "Има интернет връзка."
} catch {
    Register-Failure "Няма връзка до chocolatey.org: $($_.Exception.Message)"
}

# 0.5 Локализиране на корена на проекта (папката над scripts/)
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $ProjectRoot 'package.json'))) {
    # Ако скриптът не е в scripts/, опитай текущата директория
    if (Test-Path (Join-Path (Get-Location) 'package.json')) {
        $ProjectRoot = (Get-Location).Path
    } else {
        Register-Failure "Не е намерен package.json. Стартирайте скрипта от корена на проекта."
    }
}
if (Test-Path (Join-Path $ProjectRoot 'package.json')) {
    Write-Ok "Корен на проекта: $ProjectRoot"
}

if ($script:FailedChecks -gt 0 -and -not $SkipInstall) {
    Write-Host ""
    Write-Fail "Предварителните проверки не мина ($script:FailedChecks проблема). Прекъсване."
    exit 1
}

# ---------------------------------------------------------------------
# Стъпка 1: Chocolatey
# ---------------------------------------------------------------------
Write-Step "Стъпка 1: Chocolatey пакетен мениджър"

if (Get-Command choco -ErrorAction SilentlyContinue) {
    $chocoVer = (choco --version 2>$null)
    Write-Ok "Chocolatey вече е инсталиран (v$chocoVer)."
} elseif ($SkipInstall) {
    Register-Failure "Chocolatey липсва, а -SkipInstall е зададен."
} else {
    Write-Host "  Инсталиране на Chocolatey..." -ForegroundColor Gray
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
    Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

    # Обновяване на PATH в текущата сесия
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path','User')

    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Ok "Chocolatey инсталиран успешно (v$(choco --version))."
    } else {
        Register-Failure "Инсталацията на Chocolatey не мина. Рестартирайте терминала и опитайте пак."
    }
}

# ---------------------------------------------------------------------
# Стъпка 2: Node.js LTS (>= 22.5 заради node:sqlite)
# ---------------------------------------------------------------------
Write-Step "Стъпка 2: Node.js LTS (изисква се >= 22.5 за вградения SQLite)"

function Get-NodeVersion {
    try { return [version]((node --version 2>$null) -replace '^v','') } catch { return $null }
}

$nodeVer = Get-NodeVersion
$minNode = [version]'22.5.0'

if ($nodeVer -and $nodeVer -ge $minNode) {
    Write-Ok "Node.js v$nodeVer е наличен и покрива изискването."
} else {
    if ($nodeVer) { Write-Warn2 "Намерен е Node.js v$nodeVer - твърде стар (нужен >= $minNode)." }
    if ($SkipInstall) {
        Register-Failure "Node.js >= $minNode липсва, а -SkipInstall е зададен."
    } else {
        Write-Host "  Инсталиране/обновяване на Node.js LTS чрез Chocolatey..." -ForegroundColor Gray
        choco upgrade nodejs-lts -y --no-progress | Out-Null

        $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                    [System.Environment]::GetEnvironmentVariable('Path','User')

        $nodeVer = Get-NodeVersion
        if ($nodeVer -and $nodeVer -ge $minNode) {
            Write-Ok "Node.js v$nodeVer инсталиран успешно."
        } else {
            Register-Failure "Node.js >= $minNode не е наличен след инсталацията (намерена: $nodeVer). Рестартирайте терминала."
        }
    }
}

# Самопроверка: node:sqlite модулът е наличен
if ($nodeVer -and $nodeVer -ge $minNode) {
    $sqliteCheck = & node --experimental-sqlite -e "require('node:sqlite'); console.log('ok')" 2>$null
    if ($sqliteCheck -eq 'ok') {
        Write-Ok "Модулът node:sqlite работи."
    } else {
        Register-Failure "node:sqlite не се зарежда. Нужен е Node.js >= 22.5."
    }
}

# ---------------------------------------------------------------------
# Стъпка 3: Проектни зависимости и директории
# ---------------------------------------------------------------------
Write-Step "Стъпка 3: Зависимости и директории на проекта"

Push-Location $ProjectRoot
try {
    # Проектът използва само вградени Node модули, но пазим npm install за бъдещи deps
    $pkg = Get-Content package.json -Raw | ConvertFrom-Json
    if ($pkg.dependencies -or $pkg.devDependencies) {
        Write-Host "  npm install..." -ForegroundColor Gray
        & npm install --no-audit --no-fund 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Ok "npm зависимостите са инсталирани." }
        else { Register-Failure "npm install завърши с код $LASTEXITCODE." }
    } else {
        Write-Ok "Проектът няма външни npm зависимости (само вградени Node модули)."
    }

    # Директории, нужни за runtime (SQLite база и storage възли)
    foreach ($dir in @('data', 'storage_nodes\node1', 'storage_nodes\node2', 'storage_nodes\node3', 'storage_nodes\node4')) {
        $p = Join-Path $ProjectRoot $dir
        if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
    }
    Write-Ok "Директориите data\ и storage_nodes\node1-4 са готови."

    # Ключови файлове
    foreach ($f in @('src\index.js', 'migrations\001_initial_schema.sql')) {
        if (Test-Path (Join-Path $ProjectRoot $f)) { Write-Ok "Намерен: $f" }
        else { Register-Failure "Липсва файл: $f" }
    }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------
# Стъпка 4: Проверка дали порт 8080 е свободен
# ---------------------------------------------------------------------
Write-Step "Стъпка 4: Проверка на порт 8080 (Gateway)"

$portBusy = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
if ($portBusy) {
    $proc = Get-Process -Id $portBusy[0].OwningProcess -ErrorAction SilentlyContinue
    Write-Warn2 "Порт 8080 е зает от процес '$($proc.ProcessName)' (PID $($proc.Id))."
    Write-Warn2 "Ако това е предишно копие на CloudFS - спрете го или използвайте друг порт чрез `$env:PORT_GATEWAY."
} else {
    Write-Ok "Порт 8080 е свободен."
}

# ---------------------------------------------------------------------
# Финална самопроверка
# ---------------------------------------------------------------------
Write-Step "Финална самопроверка"

if ($script:FailedChecks -gt 0) {
    Write-Fail "Открити са $script:FailedChecks проблема. Коригирайте ги и пуснете скрипта отново."
    exit 1
}
Write-Ok "Всички проверки преминаха."

# ---------------------------------------------------------------------
# Стъпка 5: Стартиране на сървъра
# ---------------------------------------------------------------------
Write-Step "Стъпка 5: Стартиране на CloudFS"

Push-Location $ProjectRoot
try {
    if ($Service) {
        Write-Host "  Стартиране само на сервиз: $Service" -ForegroundColor Gray
        Write-Host "  Ctrl+C за спиране.`n" -ForegroundColor Gray
        & node --experimental-sqlite "src\services\$Service\index.js"
    } else {
        Write-Host "  Стартиране на пълния монолитен режим (всички микросервизи + gateway)." -ForegroundColor Gray
        Write-Host "  След старт системата ще е достъпна на: http://localhost:8080" -ForegroundColor Green
        Write-Host "  Ctrl+C за спиране (graceful shutdown).`n" -ForegroundColor Gray
        & node --experimental-sqlite src\index.js
    }
} finally {
    Pop-Location
}
