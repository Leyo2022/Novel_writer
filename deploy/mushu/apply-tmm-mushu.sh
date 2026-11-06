#!/bin/bash
# 在服务器上执行：把 mushu.sfangjie.cn 接进主站 tmm-nginx。
#
# 做两件事（幂等，可重复跑）：
#   1) 80 段 server_name 追加 mushu.sfangjie.cn（让 HTTP 能 301 到 HTTPS）
#   2) 末尾追加 443 server 块，反代到 mushu-app:8787
#
# ⚠️ 单文件 bind mount 的 inode 陷阱：必须「原地覆盖」，不能用 sed -i / mv。
#    所以这里先把新内容写到 /tmp，再用 cp 覆盖原路径（inode 不变），最后 restart。
set -eu

CONF=/opt/tmm/deploy/nginx/default.conf
SRC=/tmp/mushu-server.conf
DOMAIN=mushu.sfangjie.cn

if [ ! -f "$SRC" ]; then
  echo "缺少 $SRC（请先 scp deploy/mushu/nginx/mushu-server.conf 到服务器 /tmp/）" >&2
  exit 1
fi

cp -a "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M%S)"

# 1) 只给「第一处」server_name（即 80 段）追加域名；已含则原样拷贝。
#    ⚠️ 不能用全局替换：default.conf 里有多个 server 块，global sed 会把域名加到每个块上导致 443 冲突。
if grep -qE "^[[:space:]]*server_name [^;]*$DOMAIN;" "$CONF"; then
  cp "$CONF" /tmp/default.conf.new
else
  awk -v d="$DOMAIN" '{ if (!done && $0 ~ /^[[:space:]]*server_name [^;]*;/) { sub(/;[[:space:]]*$/, " " d ";"); done=1 } print }' "$CONF" > /tmp/default.conf.new
fi

# 2) 追加 443 块（幂等：以「独占一行的 server_name <域名>;」是否存在判断）
if ! grep -qE "^[[:space:]]*server_name $DOMAIN;[[:space:]]*$" /tmp/default.conf.new; then
  printf '\n' >> /tmp/default.conf.new
  cat "$SRC" >> /tmp/default.conf.new
fi

# 3) 先用新配置预校验（挂临时文件），通过后才原地覆盖（保 inode）并重启
docker run --rm --network tmm_default \
  -v /tmp/default.conf.new:/etc/nginx/conf.d/default.conf:ro \
  -v /opt/tmm/deploy/nginx/certs:/etc/nginx/certs:ro \
  --entrypoint nginx nginx:1.27-alpine -t
cp /tmp/default.conf.new "$CONF"
docker restart tmm-nginx

echo '--- server_name ---'
grep -n 'server_name' "$CONF"
