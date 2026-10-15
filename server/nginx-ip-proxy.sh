#!/usr/bin/env bash
set -euo pipefail

address="${1:-}"
if [[ "$EUID" != 0 || ! "$address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    echo 'Usage as root: bash server/nginx-ip-proxy.sh <public-IPv4>' >&2
    exit 1
fi
python3 -c 'import ipaddress,sys; ipaddress.IPv4Address(sys.argv[1])' "$address"
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
config=/etc/nginx/conf.d/discodicxp.conf
webroot=/var/www/discodicxp-acme
certbot=/opt/discodicxp-certbot/bin/certbot
cert_config=/etc/discodicxp/acme
cert_work=/var/lib/discodicxp-certbot
cert_logs=/var/log/discodicxp-certbot
backup_dir="$(mktemp -d /var/backups/discodicxp-nginx-ip.XXXXXXXX)"
had_config=false
if [[ -f "$config" ]]; then
    if ! grep -Fxq '# Managed by DiscodicXP' "$config"; then
        echo 'Refusing to replace an nginx configuration not managed by DiscodicXP.' >&2
        exit 1
    fi
    cp -a "$config" "$backup_dir/discodicxp.conf"
    had_config=true
fi
apt-get install --yes python3-venv
python3 -m venv /opt/discodicxp-certbot
/opt/discodicxp-certbot/bin/pip install --disable-pip-version-check 'certbot>=5.4,<6'
install -d -m 700 "$cert_config" "$cert_work" "$cert_logs"
install -d -m 755 "$webroot"
install -d -m 755 /srv/discodicxp-downloads
install -m 644 "$source_dir/nginx-downloads.conf" /etc/nginx/discodicxp-downloads.conf
restore_config() {
    if [[ "$had_config" == true ]]; then
        cp -a "$backup_dir/discodicxp.conf" "$config"
    else
        rm -f -- "$config"
    fi
    nginx -t && systemctl reload nginx
}
trap restore_config ERR
cat > "$config.partial" <<NGINX
# Managed by DiscodicXP
server {
    listen 80;
    server_name $address;
    location ^~ /.well-known/acme-challenge/ {
        root $webroot;
        try_files \$uri =404;
    }
    location / { return 503; }
}
NGINX
mv "$config.partial" "$config"
nginx -t
systemctl reload nginx
"$certbot" certonly --non-interactive --agree-tos --register-unsafely-without-email \
    --config-dir "$cert_config" --work-dir "$cert_work" --logs-dir "$cert_logs" \
    --preferred-profile shortlived --webroot -w "$webroot" --ip-address "$address" \
    --cert-name discodicxp-ip --keep-until-expiring
cat > "$config.partial" <<NGINX
# Managed by DiscodicXP
server {
    listen 80;
    server_name $address;
    location ^~ /.well-known/acme-challenge/ {
        root $webroot;
        try_files \$uri =404;
    }
    location / { return 308 https://$address\$request_uri; }
}
server {
    listen 443 ssl;
    server_name $address;
    ssl_certificate $cert_config/live/discodicxp-ip/fullchain.pem;
    ssl_certificate_key $cert_config/live/discodicxp-ip/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 32m;
    include /etc/nginx/discodicxp-downloads.conf;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 190s;
    }
}
NGINX
mv "$config.partial" "$config"
nginx -t
systemctl reload nginx
trap - ERR
install -d -m 700 "$cert_config/renewal-hooks/deploy"
cat > "$cert_config/renewal-hooks/deploy/nginx" <<'HOOK'
#!/bin/sh
set -e
nginx -t
systemctl reload nginx
HOOK
chmod 700 "$cert_config/renewal-hooks/deploy/nginx"
cat > /etc/systemd/system/discodicxp-certbot.service <<SERVICE
[Unit]
Description=Renew DiscodicXP IP certificate
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$certbot renew --config-dir $cert_config --work-dir $cert_work --logs-dir $cert_logs --quiet --no-random-sleep-on-renew
SERVICE
cat > /etc/systemd/system/discodicxp-certbot.timer <<'TIMER'
[Unit]
Description=Check DiscodicXP IP certificate twice daily

[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
TIMER
systemctl daemon-reload
systemctl enable --now discodicxp-certbot.timer
curl --fail --silent --show-error "https://$address/health"
