#!/usr/bin/env bash
set -euo pipefail

domain="${1:-}"
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$EUID" != 0 || ! "$domain" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]]; then
    echo 'Usage as root: bash server/nginx-proxy.sh updates.example.com' >&2
    exit 1
fi
config=/etc/nginx/conf.d/discodicxp.conf
webroot=/var/www/discodicxp-acme
backup_dir="$(mktemp -d /var/backups/discodicxp-nginx.XXXXXXXX)"
had_config=false
if [[ -f "$config" ]]; then
    if ! grep -Fxq '# Managed by DiscodicXP' "$config"; then
        echo 'Refusing to replace an nginx configuration not managed by DiscodicXP.' >&2
        exit 1
    fi
    cp -a "$config" "$backup_dir/discodicxp.conf"
    had_config=true
fi
restore_config() {
    if [[ "$had_config" == true ]]; then
        cp -a "$backup_dir/discodicxp.conf" "$config"
    else
        rm -f -- "$config"
    fi
    nginx -t && systemctl reload nginx
}
trap restore_config ERR
install -d -m 755 "$webroot"
install -d -m 755 /srv/discodicxp-downloads
install -m 644 "$source_dir/nginx-downloads.conf" /etc/nginx/discodicxp-downloads.conf
cat > "$config.partial" <<NGINX
# Managed by DiscodicXP
server {
    listen 80;
    server_name $domain;
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
certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
    --webroot -w "$webroot" -d "$domain" --cert-name discodicxp --keep-until-expiring
cat > "$config.partial" <<NGINX
# Managed by DiscodicXP
server {
    listen 80;
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ {
        root $webroot;
        try_files \$uri =404;
    }
    location / { return 308 https://$domain\$request_uri; }
}
server {
    listen 443 ssl;
    server_name $domain;
    ssl_certificate /etc/letsencrypt/live/discodicxp/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/discodicxp/privkey.pem;
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
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/discodicxp-nginx <<'HOOK'
#!/bin/sh
set -e
nginx -t
systemctl reload nginx
HOOK
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/discodicxp-nginx
systemctl enable --now certbot.timer
curl --fail --silent --show-error "https://$domain/health"
