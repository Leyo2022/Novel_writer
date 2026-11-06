#!/bin/bash
# 墨枢 DNS-01 手动验证 hook。
#
# 背景：阿里云对「未备案域名」拦截 80 端口，导致 HTTP-01 校验失败。
#      改走 DNS-01：把挑战值写进 TXT 记录，绕开 80 端口。
#
# 用法（服务器上）：
#   sudo certbot certonly --manual --preferred-challenges dns \
#     --manual-auth-hook /opt/mushu/cert/dns01-auth-hook.sh \
#     --no-random-sleep-on-renew \
#     -d mushu.sfangjie.cn \
#     --agree-tos -m <邮箱> --non-interactive
#
# 本 hook 会把挑战值写到 /tmp/dns01-challenge.txt 然后阻塞等待，
# 人工在阿里云加好 TXT 记录后，执行 `touch /tmp/dns01-done` 放行。
#
# 目前两个域名共用这一份脚本：
#   mushu.sfangjie.cn —— 墨枢移动端
#   leyo.sfangjie.cn  —— 个人站（原先走 webroot，因 80 被拦续期失败，改走 DNS-01）
set -eu

OUT=/tmp/dns01-challenge.txt
DONE=/tmp/dns01-done
WAIT=${DNS01_WAIT:-900}

BASE="${CERTBOT_DOMAIN#*.}"          # mushu.sfangjie.cn -> sfangjie.cn
HOST="_acme-challenge.${CERTBOT_DOMAIN%%.*}"   # -> _acme-challenge.mushu

rm -f "$DONE"
{
  echo "DOMAIN=$CERTBOT_DOMAIN"
  echo "VALIDATION=$CERTBOT_VALIDATION"
  echo "# 域名：$BASE"
  echo "# 记录类型：TXT"
  echo "# 主机记录：$HOST"
  echo "# 记录值：$CERTBOT_VALIDATION"
} > "$OUT"

echo "[dns01] 挑战值已写入 $OUT，请在阿里云添加 TXT 记录后 touch $DONE" >&2
echo "[dns01]   域名 $BASE / 主机记录 $HOST" >&2

for _ in $(seq 1 "$WAIT"); do
  if [ -f "$DONE" ]; then
    echo "[dns01] 收到放行信号，交由 Let's Encrypt 校验" >&2
    exit 0
  fi
  sleep 1
done

echo "[dns01] 等待超时（${WAIT}s），未收到 $DONE" >&2
exit 1
