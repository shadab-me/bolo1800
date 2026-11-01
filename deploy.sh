#!/usr/bin/env bash
# ==============================================================================
# Bolo1800 - 1-Click Ubuntu VPS Automated Deployment Script
# ==============================================================================
set -e

echo "=== [1/5] Updating System Packages ==="
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y curl ufw git ca-certificates gnupg

echo "=== [2/5] Installing Docker & Docker Compose ==="
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    rm -f get-docker.sh
fi

echo "=== [3/5] Configuring Firewall (UFW) ==="
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (Let's Encrypt challenge, redirects to HTTPS)
sudo ufw allow 443/tcp   # HTTPS
echo "y" | sudo ufw enable

echo "=== [4/5] Writing .env (secrets are generated, never the defaults) ==="
if [ ! -f .env ]; then
    read -rp "Domain pointing at this VPS (e.g. panel.yourbusiness.in): " DOMAIN
    read -rp "UPI ID shown to clients: " UPI
    ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=')
    cat > .env <<ENV
NODE_ENV=production
DOMAIN=${DOMAIN}
PUBLIC_URL=https://${DOMAIN}
JWT_SECRET=$(openssl rand -hex 32)
WEBHOOK_TOKEN=$(openssl rand -hex 24)
ADMIN_PASSWORD=${ADMIN_PASS}
PROVIDER=plivo
UPI_ID=${UPI}
COST_PER_MIN=0.76
ENV
    chmod 600 .env
    echo "Created .env. The admin password is in it (ADMIN_PASSWORD); store it somewhere safe."
else
    echo ".env already exists, keeping it."
fi
set -a; . ./.env; set +a

echo "=== [5/5] Building and Launching Bolo1800 ==="
docker compose down || true
docker compose up -d --build

echo ""
echo "=========================================================================="
echo " Bolo1800 deployed."
echo " Login:        https://${DOMAIN}/login   (user: admin, password: see .env)"
echo " Plivo Answer: https://${DOMAIN}/api/webhook/incoming?token=${WEBHOOK_TOKEN}"
echo " Plivo Hangup: https://${DOMAIN}/api/webhook/hangup?token=${WEBHOOK_TOKEN}"
echo " Daily backup: sudo crontab -e  ->  0 3 * * * $(pwd)/backup.sh"
echo "=========================================================================="
