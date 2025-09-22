# Traefik 3 Setup Guide with Wildcard Certificates

## Prerequisites

- Linux machine with SSH access (Ubuntu recommended)
- Docker installed
- Domain name registered to you
- Cloudflare account with domain using Cloudflare DNS
- Internal DNS system (PiHole, router, or firewall)

## Step 1: Server Setup

```bash
# Create directory structure
mkdir -p ~/docker-volumes/traefik/data
cd ~/docker-volumes/traefik

# Create required files
touch data/acme.json
chmod 600 data/acme.json
touch data/traefik.yml
touch docker-compose.yml
touch .env
touch cf_api_token.txt
```

## Step 2: Create Cloudflare API Token

1. Go to Cloudflare Dashboard → Profile → API Tokens
2. Create Custom Token with:
   - **Name**: Docker Traefik
   - **Permissions**: 
     - Zone:Zone:Read
     - Zone:DNS:Edit
   - **Zone Resources**: Include your specific domain
   - **IP Address Filtering**: Add your static IP (if available)
   - **TTL**: No expiry (needed for certificate renewal)
3. Copy the token and save it to `cf_api_token.txt`

## Step 3: Configure Traefik YAML

Create `data/traefik.yml`:

```yaml
api:
  dashboard: true
  debug: true

entryPoints:
  http:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: https
          scheme: https
  https:
    address: ":443"

serversTransport:
  insecureSkipVerify: true

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
  # file:
  #   filename: /config.yml

certificatesResolvers:
  cloudflare:
    acme:
      email: your-email@example.com
      storage: acme.json
      # caServer: https://acme-v02.api.letsencrypt.org/directory # Production
      caServer: https://acme-staging-v02.api.letsencrypt.org/directory # Staging (test first!)
      dnsChallenge:
        provider: cloudflare
        # delayBeforeCheck: 60s
        # propagationTimeout: 120s
        resolvers:
          - "1.1.1.1:53"
          - "1.0.0.1:53"
```

## Step 4: Create Docker Compose File

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  traefik:
    image: traefik:v3.0
    container_name: traefik
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    networks:
      - proxy
    ports:
      - "80:80"
      - "443:443"
    environment:
      CF_DNS_API_TOKEN_FILE: /run/secrets/cf_api_token
      TRAEFIK_DASHBOARD_CREDENTIALS: ${TRAEFIK_DASHBOARD_CREDENTIALS}
    env_file: .env
    volumes:
      - /etc/localtime:/etc/localtime:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./data/traefik.yml:/traefik.yml:ro
      - ./data/acme.json:/acme.json
      # - ./data/config.yml:/config.yml:ro
    secrets:
      - cf_api_token
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.traefik.entrypoints=http"
      - "traefik.http.routers.traefik.rule=Host(`traefik-dashboard.local.yourdomain.com`)"
      - "traefik.http.middlewares.traefik-auth.basicauth.users=${TRAEFIK_DASHBOARD_CREDENTIALS}"
      - "traefik.http.middlewares.traefik-https-redirect.redirectscheme.scheme=https"
      - "traefik.http.middlewares.sslheader.headers.customrequestheaders.X-Forwarded-Proto=https"
      - "traefik.http.routers.traefik.middlewares=traefik-https-redirect"
      - "traefik.http.routers.traefik-secure.entrypoints=https"
      - "traefik.http.routers.traefik-secure.rule=Host(`traefik-dashboard.local.yourdomain.com`)"
      - "traefik.http.routers.traefik-secure.middlewares=traefik-auth"
      - "traefik.http.routers.traefik-secure.tls=true"
      - "traefik.http.routers.traefik-secure.tls.certresolver=cloudflare"
      - "traefik.http.routers.traefik-secure.tls.domains[0].main=local.yourdomain.com"
      - "traefik.http.routers.traefik-secure.tls.domains[0].sans=*.local.yourdomain.com"
      - "traefik.http.routers.traefik-secure.service=api@internal"

secrets:
  cf_api_token:
    file: ./cf_api_token.txt

networks:
  proxy:
    external: true
```

## Step 5: Generate Basic Auth Credentials

```bash
# Install htpasswd (Ubuntu)
sudo apt update && sudo apt install apache2-utils

# Generate credentials (replace 'admin' with your username)
htpasswd -nb admin password

# Copy the output to .env file
echo "TRAEFIK_DASHBOARD_CREDENTIALS=admin:\$2y\$10\$..." > .env
```

## Step 6: Create Docker Network

```bash
docker network create proxy
```

## Step 7: Start Traefik (Staging First)

```bash
# Start with staging certificates first
docker-compose up -d

# Check logs for errors
docker logs traefik

# Verify certificate was generated
cat data/acme.json
```

## Step 8: Setup Local DNS

In your DNS system (PiHole/router), create:
- **Type**: CNAME
- **Name**: `traefik-dashboard.local.yourdomain.com`
- **Target**: Your Docker host (e.g., `docker01.local`)

Test DNS resolution:
```bash
nslookup traefik-dashboard.local.yourdomain.com
```

## Step 9: Access Dashboard

1. Navigate to `https://traefik-dashboard.local.yourdomain.com`
2. Accept the staging certificate warning
3. Enter your basic auth credentials
4. Verify you can access the Traefik dashboard

## Step 10: Switch to Production Certificates

1. Edit `data/traefik.yml`:
   ```yaml
   # Comment out staging
   # caServer: https://acme-staging-v02.api.letsencrypt.org/directory
   
   # Uncomment production
   caServer: https://acme-v02.api.letsencrypt.org/directory
   ```

2. Clear the certificate cache:
   ```bash
   docker stop traefik
   echo "" > data/acme.json
   docker start traefik
   ```

3. Check for new production certificate:
   ```bash
   docker logs traefik
   cat data/acme.json
   ```

## Step 11: Deploy Additional Services

Create a new service (example with nginx):

```bash
mkdir ../nginx
cd ../nginx
```

Create `docker-compose.yml`:
```yaml
version: '3.8'

services:
  nginx:
    image: nginxdemos/hello
    container_name: nginx-demo
    restart: unless-stopped
    networks:
      - proxy
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.nginx.rule=Host(`nginx.local.yourdomain.com`)"
      - "traefik.http.routers.nginx.entrypoints=https"
      - "traefik.http.routers.nginx.tls=true"
      - "traefik.http.services.nginx.loadbalancer.server.port=8080"

networks:
  proxy:
    external: true
```

Add DNS entry and start:
```bash
docker-compose up -d
```

## Step 12: External Services (Optional)

For services outside Docker, create `data/config.yml`:

```yaml
http:
  routers:
    proxmox:
      rule: "Host(`proxmox.local.yourdomain.com`)"
      middlewares:
        - default-headers
        - https-redirectscheme
      tls: {}
      service: proxmox
  
  middlewares:
    https-redirectscheme:
      redirectScheme:
        scheme: https
        permanent: true
    
    default-headers:
      headers:
        frameDeny: true
        sslRedirect: true
        browserXssFilter: true
        contentTypeNosniff: true
        forceSTSHeader: true
        stsIncludeSubdomains: true
        stsPreload: true
        stsSeconds: 31536000
    
    secured:
      chain:
        middlewares:
          - default-headers
          - ipwhitelist
    
    ipwhitelist:
      ipWhiteList:
        sourceRange:
          - "10.0.0.0/8"
          - "192.168.0.0/16"
          - "172.16.0.0/12"

  services:
    proxmox:
      loadBalancer:
        servers:
          - url: "https://192.168.1.100:8006"
        passHostHeader: true
```

Uncomment the config file line in both `traefik.yml` and `docker-compose.yml`, then restart Traefik.

## Troubleshooting

**Container debugging:**
```bash
docker exec -it traefik /bin/sh
ls /
cat /traefik.yml
ls /run/secrets
echo $CF_DNS_API_TOKEN_FILE
echo $TRAEFIK_DASHBOARD_CREDENTIALS
```

**Certificate issues:**
- Check `docker logs traefik` for errors
- Verify DNS propagation with external DNS (not internal)
- Use staging certificates first to avoid rate limits
- Clear browser cache or try different browser

**Key Points:**
- Certificates auto-renew every 90 days
- Use staging environment first to test
- External DNS resolvers are required for Let's Encrypt verification
- All services need to be on the `proxy` network
- Update domain names throughout the configuration to match your domain

## Better Yet

**Watch the video from TechnoTim:**
https://www.youtube.com/watch?v=n1vOfdz5Nm8&t=1571s


