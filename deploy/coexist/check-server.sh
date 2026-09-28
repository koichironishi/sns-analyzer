#!/bin/sh
# 同居できるか確認するための情報を表示する（読み取りのみ・何も変更しない）
echo "== OS";            . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo "== メモリ";        free -h 2>/dev/null | sed -n 1,2p
echo "== ディスク";      df -h / | tail -1
echo "== Docker";        docker --version 2>/dev/null || echo "未インストール"
echo "== Compose";       docker compose version 2>/dev/null || echo "未インストール"
echo "== 80/443/8010番を使っているプログラム"
(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep -E ':(80|443|8010)\s' || echo "なし"
echo "== Webサーバー";   for s in nginx caddy apache2 httpd; do command -v $s >/dev/null && echo "$s あり"; done
docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null | head -20
