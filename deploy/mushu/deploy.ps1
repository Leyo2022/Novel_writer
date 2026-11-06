# 墨枢移动端服务 · 一键部署（在电脑上运行）
#
#   .\deploy.ps1                # 上传代码 + 重启容器（不动服务器上的 .env）
#   .\deploy.ps1 -WithEnv       # 同时上传本地 .env（首次部署或改了密码时用）
#
# 前置：本机已存在 deploy/mushu/.env（可从 env.example 复制并填写）。
param(
  [string]$Key = "d:\trae_projects\VerPD\_firstdemo.pem",
  [string]$Target = "deploy@121.43.105.54",
  [switch]$WithEnv
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
if (-not (Test-Path $Key)) { throw "找不到私钥：$Key" }

# Windows OpenSSH 要求私钥权限收紧，先复制一份到临时目录并改 ACL
$tmpKey = Join-Path $env:TEMP 'mushu_deploy_key.pem'
Copy-Item $Key $tmpKey -Force
icacls $tmpKey /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null

$sshOpts = @('-i', $tmpKey, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15')

Write-Host '1) 建目录…'
& ssh @sshOpts $Target "sudo mkdir -p /opt/mushu/data /opt/mushu/server /opt/mushu/web /opt/mushu/nginx /opt/mushu/cert && sudo chown -R deploy:deploy /opt/mushu"

Write-Host '2) 上传代码…'
& scp @sshOpts -r "$here\server" "$here\web" "$here\nginx" "$here\cert" "$here\docker-compose.yml" "$here\apply-tmm-mushu.sh" "${Target}:/opt/mushu/"

if ($WithEnv) {
  if (-not (Test-Path "$here\.env")) { throw "本地缺少 .env，无法上传（可复制 env.example 后填写）" }
  Write-Host '3) 上传 .env…'
  & scp @sshOpts "$here\.env" "${Target}:/opt/mushu/.env"
  & ssh @sshOpts $Target "chmod 600 /opt/mushu/.env"
}

Write-Host '4) 启动容器…'
& ssh @sshOpts $Target "cd /opt/mushu && sudo docker compose up -d && sleep 2 && sudo docker ps --filter name=mushu-app --format 'table {{.Names}}\t{{.Status}}'"

Write-Host '5) 容器内自检…'
& ssh @sshOpts $Target "sudo docker exec mushu-app wget -qO- http://127.0.0.1:8787/api/me; echo"

Write-Host '完成。若域名已解析，继续执行证书与反代（见 apply-tmm-mushu.sh 说明）。'
