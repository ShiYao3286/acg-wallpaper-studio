# 旧方案联动示例:PowerShell 随机壁纸脚本(计划任务版)
# 换图成功后写 wallpaper_meta.json,ACG壁纸工作室 会实时感知并同步 UI
# 用法:计划任务每 30 分钟执行本脚本(建议配 run-hidden.vbs 静默启动)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# === 可选:游戏运行时跳过 ===
$GameProcs = @('YourGameClient-Win64-Shipping')   # 改成你的游戏进程名
foreach ($gp in $GameProcs) {
    if (Get-Process -Name $gp -ErrorAction SilentlyContinue) {
        Write-Output "game running ($gp), skip"
        return
    }
}

# === 标签池(按喜好增删)==
$Tags = @('原神', '碧蓝航线', '東方Project')
$PickTag = $Tags | Get-Random

$ApiUrl   = "https://api.lolicon.app/setu/v2?num=1&r18=0&size=regular&excludeAI=true&tag=" + [uri]::EscapeDataString($PickTag)
$SaveDir  = Join-Path $env:USERPROFILE "Pictures\ACG_Wallpaper"
$SavePath = Join-Path $SaveDir "current.jpg"

if (-not (Test-Path $SaveDir)) { New-Item -ItemType Directory -Path $SaveDir -Force | Out-Null }

# 1. 请求 API
try {
    $json = Invoke-RestMethod -Uri $ApiUrl -TimeoutSec 30
    $imgUrl = $json.data[0].urls.regular
    $title  = $json.data[0].title
    $author = $json.data[0].author
    $artId  = $json.data[0].pid
} catch { Write-Output "API failed: $($_.Exception.Message)"; return }
if (-not $imgUrl) { return }

# 2. 下载到临时文件(失败不破坏当前壁纸)
$TempPath = Join-Path $SaveDir "current.tmp.jpg"
try { Invoke-WebRequest -Uri $imgUrl -OutFile $TempPath -UseBasicParsing -TimeoutSec 40 } catch { return }
if ((Get-Item $TempPath).Length -lt 10KB) { Remove-Item $TempPath -Force; return }

# 3. 归档旧图 + 替换
if (Test-Path $SavePath) {
    Move-Item $SavePath (Join-Path $SaveDir ("hist_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".jpg")) -Force
}
Move-Item $TempPath $SavePath -Force

# 4. 设壁纸
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Wallpaper {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
"@
[Wallpaper]::SystemParametersInfo(0x0014, 0, $SavePath, 0x01 -bor 0x02) | Out-Null

# 5. 动作回执(软件联动关键)
$meta = [ordered]@{
    time   = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    source = "script"
    tag    = $PickTag
    title  = $title
    author = $author
    pid    = $artId
    file   = "current.jpg"
    bytes  = (Get-Item $SavePath).Length
}
$meta | ConvertTo-Json | Set-Content -Path (Join-Path $SaveDir "wallpaper_meta.json") -Encoding UTF8
Write-Output "wallpaper updated: $title / $author"
