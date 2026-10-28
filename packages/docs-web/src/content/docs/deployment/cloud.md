---
title: Cloud Deployment
description: Prepare a cloud VPS for Archon, then run it with Docker Compose and automatic HTTPS.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 3
---

This page prepares a VPS: a user, SSH, a firewall and DNS. The [Docker guide](/deployment/docker/) then installs and runs Archon on it with Docker Compose and Caddy for HTTPS. Using your own proxy instead of Caddy? See [Running Archon behind your own reverse proxy](/deployment/reverse-proxy/).

For the fastest route, use the [cloud-init script](/deployment/docker/#cloud-init-fastest-setup) instead. It creates a user, opens the firewall and installs Docker when the VPS first boots. You still create the [DNS record](#point-your-domain-at-the-server).

## What you need

- A VPS from any provider (DigitalOcean, Linode, AWS EC2, Vultr and so on): 1 to 2 vCPUs, 2 GB RAM minimum (4 GB recommended), 20 GB SSD, Ubuntu 22.04 LTS.
- A domain or subdomain, such as `archon.yourdomain.com`.
- An SSH key. Create one before the VPS, and add the public key when you create it:

  ```bash
  ssh-keygen -t ed25519 -C "archon"
  cat ~/.ssh/id_ed25519.pub
  ```

When you create the VPS, choose the Ubuntu 22.04 image and your SSH key, and allow inbound SSH (22), HTTP (80) and HTTPS (443) if the provider has its own firewall or security group. Note the public IP.

## Secure the server

Connect with the image's default account: `root` on most VPS providers, `ubuntu` on AWS EC2, which disables root login. Create a deploy user with your key, and switch to it:

```bash
ssh root@your-server-ip            # or: ssh ubuntu@your-server-ip on EC2

sudo adduser deploy
sudo usermod -aG sudo deploy
sudo mkdir -p /home/deploy/.ssh
sudo cp ~/.ssh/authorized_keys /home/deploy/.ssh/
sudo chown -R deploy:deploy /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

Test `ssh deploy@your-server-ip` in a second terminal before you go on. Then turn off password logins by setting `PasswordAuthentication no` in `/etc/ssh/sshd_config`, and restart SSH:

```bash
sudo systemctl restart ssh
sudo su - deploy
```

Open the firewall:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443
sudo ufw --force enable
```

## Point your domain at the server

At your DNS provider, create an A record: name `archon` (or `@` for the root domain), value the server's public IP. With Cloudflare, set the record to DNS only, not proxied, so Caddy can obtain its certificate. Check it with `dig archon.yourdomain.com`.

## Install and run Archon

Follow the Docker guide's [manual server setup](/deployment/docker/#manual-server-setup). It installs Docker, clones the repository, sets up `.env` and the `Caddyfile`, and starts the stack. Before you expose the Web UI, choose a login in [Protect the Web UI](/deployment/docker/#protect-the-web-ui).

Check the deployment from your machine:

```bash
curl https://archon.yourdomain.com/api/health
```
