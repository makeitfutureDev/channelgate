# Hosting and server sizing

Use this when someone asks what server to buy or rent for a ChannelGate deployment, how big it must
be, or which provider to use. Prices are estimates checked on 2026-09-22 for EU regions, monthly,
excluding VAT unless stated. Providers change prices: re-check the provider page before quoting a
number as current, and say the figures are estimates.

## What the gateway needs

ChannelGate is one always-on Linux daemon with local SQLite state, real work folders on disk, a
long-lived chat connection (Slack Socket Mode), and one persistent rootless Podman container per
conversation. It therefore needs a plain Linux virtual or physical server with systemd and a
persistent disk. Serverless and container platforms (Cloud Run, App Service, Kubernetes, Cloudflare
Workers/Containers) cannot host it: they have no durable local disk, stop idle processes, and cannot
run the per-channel Podman containers the confinement model depends on. Inference runs at the
engine provider, so no GPU is needed.

## Recommended configuration

| Item | Recommendation |
|---|---|
| CPU | 4 **dedicated** vCPU (avoid heavily oversold shared cores) |
| RAM | 16 GB |
| Disk | 150 GB NVMe/SSD (persistent, not a temporary/local scratch disk) |
| OS | Ubuntu 24.04 LTS (the tested distribution) |
| Network | Static public IPv4 |
| Swap | 4–8 GB |
| Concurrency | `MAX_CONCURRENT_RUNS=4` (the default is 8; raise only after watching memory) |
| Backups | Provider snapshots plus encrypted off-host ChannelGate backups (`scripts/backup-config.sh`) |

This comfortably carries about four concurrent engine runs with browser automation, background
jobs and several active channel containers. Browser automation and many live channel containers
are what make 8 GB too small for production; local Whisper transcription adds about 2 GB of disk
and favours 16 GB+ RAM.

Other tiers:

- **Pilot:** 2 vCPU, 8 GB RAM, 50 GB NVMe; `MAX_CONCURRENT_RUNS=2`.
- **Busy:** 8 vCPU, 32 GB RAM, 200+ GB NVMe; 6–8 concurrent runs.

## Recommended providers (estimated monthly totals)

| Provider and plan | Region | What you get | Estimated total/month |
|---|---|---|---|
| **Hetzner Cloud CCX23** — first choice | Germany (fsn1, nbg1), Finland (hel1) | 4 dedicated vCPU, 16 GB, 160 GB NVMe, 20 TB traffic | **≈ €25** (€24.49 + €0.50 IPv4); ≈ €30 with Hetzner backups (+20%) |
| **netcup VPS 2000 G12** — budget/pilot | Nuremberg, Vienna, Amsterdam | 8 shared vCore, 16 GB ECC DDR5, 512 GB NVMe, IPv4 included | **≈ €16** (€19.25 incl. 19% German VAT) |
| **RoLeaf Enterprise** — Romanian hosting | Romania | 8 vCPU, 16 GB, 240 GB SSD, 8 TB traffic | **≈ €32** |
| **Google Cloud `n4-standard-4`** — when a hyperscaler is required | `europe-west4` (Netherlands) | 4 vCPU, 16 GB, 150 GB `pd-balanced`, static IPv4 | **≈ $159 (≈ €139)** on demand; **≈ $108 (≈ €94)** with a 1-year commitment; internet egress extra (≈ $0.12/GB) |

How to choose:

- **Hetzner CCX23** is the default recommendation: the only option near €25 with dedicated cores,
  the disk already covers 150 GB, and 20 TB of traffic is included. It has an official CLI
  (`hcloud server create --type ccx23 --image ubuntu-24.04 --location fsn1 ...`), a REST API and a
  Terraform provider; cloud-init user data can install ChannelGate unattended on first boot.
- **netcup** is the cheapest serious box, but its cores are shared: CPU steal shows up exactly when
  several channels run turns at once. Treat it as a pilot or low-traffic server.
- **RoLeaf** fits when the customer wants the server and data physically in Romania. Larger
  Romanian providers with 4 vCPU/16 GB plans (ClausWeb CloudVPS3 ≈ €75, Hostico vps:go3 ≈ €64)
  cost two to three times more for comparable hardware. Romanian VAT is 21%.
- **Google Cloud** only makes sense when procurement, compliance or an existing agreement requires
  a hyperscaler. It is roughly 5–6× Hetzner because compute, disk, IP and egress are billed
  separately and egress is expensive; a single always-on daemon uses none of the elasticity that
  premium pays for. AWS (`m7i.xlarge`, ≈ €150–170) and Azure (`Standard_D4s_v5`, ≈ €170) cost
  more still; Frankfurt is the most expensive EU region on each.

EU-owned providers (Hetzner, netcup, RoLeaf) are outside the US CLOUD Act; Google, AWS and Azure
are not. Mention this when a customer asks about data sovereignty.

For installation on the chosen server, defer to `INSTALL.md` and `docs/OPERATIONS.md` in the
ChannelGate checkout.
