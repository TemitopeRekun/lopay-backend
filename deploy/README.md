# Deploying the LoPay backend to an Oracle Cloud "Always Free" VM

This runs the **entire backend** — NestJS API + Postgres + Redis — on one free
Oracle Cloud Ampere A1 (arm64) VM, behind Caddy for automatic HTTPS.

```
Internet ──▶ Caddy (:80/:443, TLS)
                └─▶ app (:3001)  ──▶ postgres (:5432)   ← all on a PRIVATE
                                 └─▶ redis    (:6379)      docker network,
                                                            no public ports
```

**What this costs:** $0 within the Always Free limits. Upgrading the account to
Pay-As-You-Go is recommended (better A1 availability, no idle reclamation) and
still bills $0 as long as you stay on the free shape.

**Prerequisites you must have:**
- A **domain or subdomain** you control (needed for HTTPS — Paystack webhooks and
  secure auth cookies require it). e.g. `api.yourdomain.com`.
- Your **Firebase Admin** service-account JSON and a **Paystack live** secret key.
- The backend git repo reachable from the VM (see step B4).

---

## Part A — Oracle Cloud console (one-time)

### A1. Create the account
Sign up at <https://www.oracle.com/cloud/free/>. You'll need a phone number and a
credit card **for identity verification only — it is not charged** on the free
tier. **Choose your home region carefully** (near your users; can't be changed
later — Always Free A1 only exists in the home region).

### A2. (Recommended) Upgrade to Pay-As-You-Go
Billing → **Upgrade to Pay As You Go**. This dramatically improves your odds of
getting A1 capacity and exempts the VM from idle reclamation. You stay at **$0**
as long as you keep to the Always Free shape below.

### A3. Create the VM
Compute → **Instances → Create instance**:
- **Image:** Canonical **Ubuntu 22.04** (friendliest for a first VM).
- **Shape:** change to **Ampere** → `VM.Standard.A1.Flex`, **2 OCPUs, 12 GB RAM**
  (the full free allowance).
- **SSH keys:** choose *Generate a key pair* and **download the private key** (or
  upload your own public key). You cannot get the private key later.
- Leave the default VCN/public subnet; ensure **Assign a public IPv4 address** is on.
- Create. Note the **public IP** once it's running.

> If you hit **"Out of host capacity"**, try again later, pick a different
> Availability Domain, or a less-busy region. Being on Pay-As-You-Go (A2) helps most.

### A4. Open the ports (Oracle Security List)
Networking → your VCN → the public subnet → its **Security List** → add
**Ingress** rules (Egress is open by default):

| Source CIDR | Protocol | Dest port | Purpose |
|---|---|---|---|
| `<your-ip>/32` | TCP | 22 | SSH (lock to your IP if you can) |
| `0.0.0.0/0` | TCP | 80 | HTTP (Let's Encrypt challenge + redirect) |
| `0.0.0.0/0` | TCP | 443 | HTTPS (the API) |

### A5. Point DNS at the VM
At your DNS provider, add an **A record**: `api.yourdomain.com → <public IP>`.
Wait for it to resolve (`ping api.yourdomain.com` shows the IP) before booting Caddy.

---

## Part B — On the VM (SSH)

### B1. Connect
```bash
chmod 600 your-key.pem
ssh -i your-key.pem ubuntu@<public-ip>      # default Ubuntu user is `ubuntu`
```

### B2. Open the OS firewall (Oracle's big gotcha)
Oracle's Ubuntu images ship with an iptables rule that **blocks everything except
SSH**, regardless of the Security List. Allow 80/443 and persist it:
```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo apt-get update && sudo apt-get install -y netfilter-persistent
sudo netfilter-persistent save
```

### B3. Install Docker
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker          # apply the group now, or log out/in
docker --version && docker compose version
```

### B4. Get the code
The deploy files live in the backend repo under `deploy/`. Clone the branch that
contains them (currently `milestone-5-contract-docs`):
```bash
git clone -b milestone-5-contract-docs <your-backend-repo-url> lopay-backend
cd lopay-backend/deploy
```
> Private repo? Use an HTTPS URL with a personal access token, or add a read-only
> deploy key. (No git access from the VM? `scp -i key.pem -r` the folder up instead.)

### B5. Fill in secrets
```bash
cp .env.example .env
nano .env            # fill EVERY placeholder — see the comments in the file
```
Generate the two secrets it asks for:
```bash
openssl rand -hex 32                                   # BETTER_AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # ENCRYPTION_KEY
```
Set `API_DOMAIN`, `BETTER_AUTH_URL=https://<API_DOMAIN>`, `CORS_ORIGINS` (your
frontend origin), the Firebase block, and the Paystack **live** key.

### B6. Launch
```bash
docker compose up -d --build          # first arm64 build takes a few minutes
docker compose logs -f app            # watch: migrations run, then "running on ..."
```
The app applies `prisma migrate deploy` on boot, then starts. Caddy fetches a TLS
cert for your domain on first request (watch `docker compose logs -f caddy`).

---

## Part C — Verify

```bash
curl https://api.yourdomain.com/health
```
Expect `{"status":"ok", ... "db":{"ok":true}, "storage":{"ok":true} ...}`.
- `db.ok:false` → check `POSTGRES_*` / that the postgres container is healthy.
- `storage.ok:false` → Firebase creds; re-check `FIREBASE_PRIVATE_KEY` formatting
  (must keep the literal `\n`) and the bucket name.
- Cert/TLS errors → DNS not resolving yet, or ports 80/443 not open (A4 + B2).

Then:
- **Frontend:** point it at `https://api.yourdomain.com` and make sure that origin
  is in `CORS_ORIGINS`.
- **Paystack dashboard → Webhooks:** set the URL to
  `https://api.yourdomain.com/api/v1/payments/paystack/webhook`.

---

## Day-2 operations

**Deploy an update:**
```bash
cd lopay-backend && git pull && cd deploy && docker compose up -d --build
```

**Database backup (do this — a self-hosted DB has no safety net):**
```bash
# on the VM; keeps it off the app container
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > ~/lopay-$(date +%F).sql.gz
```
Add it to `crontab -e` to run daily, and copy the dumps off the VM (Oracle Object
Storage's 20 GB free tier works). Restore with `gunzip -c … | docker compose exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB"`.

**Logs / status / restart:**
```bash
docker compose ps
docker compose logs -f app
docker compose restart app
docker compose down          # stop everything (volumes/data preserved)
```

**Keep the box patched:** `sudo apt-get update && sudo apt-get upgrade -y` periodically.
