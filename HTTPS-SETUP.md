# HTTPS Setup with Caddy and Let's Encrypt

This guide explains how to enable automatic HTTPS for Archon using Caddy as a reverse proxy with Let's Encrypt certificates.

## Overview

The setup includes:
- **Caddy** as a reverse proxy with automatic HTTPS
- **Let's Encrypt** for free SSL certificates
- **Automatic certificate renewal**
- **Security headers** and best practices
- **HTTP to HTTPS redirection**

## Prerequisites

1. **Domain name** pointing to your server's IP address
2. **Ports 80 and 443** open on your server/firewall
3. **Docker and Docker Compose** installed

## Configuration

### 1. Environment Variables

Set your domain in `.env`:

```bash
# Your domain name (replace with your actual domain)
DOMAIN=your-domain.com

# Keep existing settings - update HOST to match your domain
HOST=your-domain.com
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052
```

### 2. DNS Configuration

Ensure your domain points to your server:

```bash
# Check DNS resolution
nslookup your-domain.com

# Should return your server's IP address
```

### 3. Firewall Configuration

Open required ports:

```bash
# Allow HTTP (for Let's Encrypt verification)
sudo ufw allow 80/tcp

# Allow HTTPS
sudo ufw allow 443/tcp

# Check status
sudo ufw status
```

## Deployment

### Development (HTTP only)

```bash
# Start services for local development (HTTP only)
docker compose up -d

# Access at: http://localhost:3737
```

### Production (HTTPS with Caddy)

```bash
# Stop any existing services
docker compose down

# Start all services with HTTPS support
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Check Caddy logs for certificate acquisition
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy -f
```

### Certificate Acquisition Process

1. Caddy automatically requests certificates from Let's Encrypt
2. Let's Encrypt validates domain ownership via HTTP-01 challenge
3. Certificates are stored in Docker volumes for persistence
4. Auto-renewal happens before expiration

## Accessing Your Application

- **HTTPS**: https://your-domain.com
- **HTTP**: http://your-domain.com (redirects to HTTPS)

## Service Architecture

```
Internet → Caddy (Port 80/443) → Internal Services
                  ↓
        ┌─────────────────┐
        │     Caddy       │ ← HTTPS termination
        │   (Port 443)    │ ← Let's Encrypt certs
        └─────────────────┘
                  ↓
        ┌─────────────────┐
        │   Frontend      │ ← React UI
        │  (Port 5173)    │ ← Internal only
        └─────────────────┘
                  ↓
        ┌─────────────────┐
        │ Archon Server   │ ← FastAPI + Socket.IO
        │  (Port 8181)    │ ← Internal only
        └─────────────────┘
```

## Security Features

### Automatic Security Headers

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security` (HSTS)
- `Referrer-Policy: strict-origin-when-cross-origin`

### Certificate Management

- **Automatic acquisition** from Let's Encrypt
- **Automatic renewal** (30 days before expiration)
- **OCSP stapling** for performance
- **Perfect Forward Secrecy**

## Troubleshooting

### Common Issues

1. **Certificate acquisition fails**:
   ```bash
   # Check Caddy logs
   docker compose logs caddy
   
   # Verify DNS resolution
   nslookup your-domain.com
   
   # Check port accessibility
   nc -zv your-domain.com 80
   nc -zv your-domain.com 443
   ```

2. **Domain not accessible**:
   ```bash
   # Check if Caddy is running
   docker compose -f docker-compose.yml -f docker-compose.prod.yml ps caddy
   
   # Verify Caddy configuration
   docker compose -f docker-compose.yml -f docker-compose.prod.yml exec caddy caddy validate --config /etc/caddy/Caddyfile
   ```

3. **Mixed content warnings**:
   - Ensure all API calls use HTTPS URLs
   - Check browser console for HTTP requests

### Logs and Monitoring

```bash
# View all service logs (production)
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f

# Caddy-specific logs
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy -f

# Access logs location
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec caddy tail -f /var/log/caddy/access.log

# Check certificate status
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec caddy caddy list-certificates
```

### Manual Certificate Management

```bash
# Force certificate renewal (if needed)
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile

# Check certificate expiry
echo | openssl s_client -servername your-domain.com -connect your-domain.com:443 2>/dev/null | openssl x509 -noout -dates
```

## Configuration Files

### Caddyfile

Located at `./Caddyfile`, contains:
- Domain configuration
- Reverse proxy rules
- Security headers
- Logging configuration

### Docker Compose Structure

The HTTPS setup uses Docker Compose override files:

- **docker-compose.yml**: Base configuration for development (HTTP only)
- **docker-compose.prod.yml**: Production overrides with HTTPS support

Key production changes:
- Added Caddy service with ports 80/443
- Removed external port mapping from frontend
- Added persistent volumes for certificates  
- Updated environment variables for HTTPS URLs

## Development vs Production

### Development (HTTP)
```bash
# Local development with direct port access
docker compose up -d

# Access at: http://localhost:3737
```

### Production (HTTPS)
```bash
# Full stack with HTTPS via Caddy reverse proxy
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Access at: https://your-domain.com
```

## Backup and Recovery

### Certificate Backup

```bash
# Backup certificate data
docker run --rm -v archon_caddy_data:/data -v $(pwd):/backup alpine tar czf /backup/caddy-certs.tar.gz /data

# Restore certificates (if needed)
docker run --rm -v archon_caddy_data:/data -v $(pwd):/backup alpine tar xzf /backup/caddy-certs.tar.gz -C /
```

## Advanced Configuration

### Custom SSL Settings

Modify `Caddyfile` for custom TLS settings:

```caddyfile
{$DOMAIN} {
    tls {
        protocols tls1.2 tls1.3
        ciphers TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384 TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
    }
    
    # Rest of configuration...
}
```

### Multiple Domains

Add additional domains to `Caddyfile`:

```caddyfile
your-domain.com, www.your-domain.com {
    # Configuration here
}
```

## Performance Optimization

### Enable Compression

Already enabled in Caddy by default for common file types.

### Cache Static Assets

Add to `Caddyfile`:

```caddyfile
handle /static/* {
    header Cache-Control "public, max-age=31536000"
    reverse_proxy frontend:5173
}
```

## Monitoring

### Health Checks

All services include health checks:
- Caddy validates configuration
- Frontend checks HTTP endpoint
- Backend services check API endpoints

### Metrics

Consider adding monitoring:
- Caddy access logs
- Certificate expiry monitoring
- SSL Labs testing

## Support

For issues:
1. Check logs: `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy -f`
2. Verify DNS: `nslookup your-domain.com`
3. Test ports: `nc -zv your-domain.com 80 443`
4. Validate config: `docker compose -f docker-compose.yml -f docker-compose.prod.yml exec caddy caddy validate --config /etc/caddy/Caddyfile`

---

*Note: Let's Encrypt has rate limits (5 certificates per domain per week). Avoid frequent restarts during testing.*