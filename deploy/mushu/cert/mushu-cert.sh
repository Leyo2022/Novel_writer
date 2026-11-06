#!/bin/bash
# 墨枢站点证书部署 hook：签发/续期后同步进 tmm-nginx 挂载目录并 reload。
# 装到 /etc/letsencrypt/renewal-hooks/deploy/mushu-cert.sh
set -eu
DST=/opt/tmm/deploy/nginx/certs
SRC=/etc/letsencrypt/live/mushu.sfangjie.cn
cp -L "$SRC/fullchain.pem" "$DST/mushu-fullchain.pem"
cp -L "$SRC/privkey.pem"   "$DST/mushu-privkey.pem"
chmod 644 "$DST/mushu-fullchain.pem"
chmod 600 "$DST/mushu-privkey.pem"
docker exec tmm-nginx nginx -s reload || true
