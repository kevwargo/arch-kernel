# Cloud-build toolkit

A way to build the kernel quickly on large but short-lived AWS EC2 instance

## Prepare AMI and basic volume

### 1. Create volume

- Type: GP3
- Size: 20G

### 2. Run instance

#### Image ID

From SSM param
`/aws/service/ami-amazon-linux-latest/al2023-ami-minimal-kernel-default-x86_64`

#### Block Device Mappings

With the created volume attached

#### User data

```
dnf install -y spal-release
dnf install -y docker-{cli,compose} btrfs-progs screen git make
systemctl enable docker
systemctl stop docker
usermod -a -G docker ec2-user
df -h /

# locate the disk blockdev (e.g. /dev/sdb but might be different)
# automate fdisk partitioning somehow
sudo mkfs -t btrfs -L kbuild /dev/sdb1
sudo mount /dev/disk/by-label/kbuild /mnt
btrfs subvolume create /mnt/code
sudo btrfs subvolume create /mnt/docker
echo 'LABEL=kbuild /var/lib/docker btrfs rw,relatime,space_cache=v2,subvol=docker' >> /etc/fstab
echo 'LABEL=kbuild /home/ec2-user/kbuild btrfs rw,relatime,space_cache=v2,subvol=code' >> /etc/fstab

sudo umount /mnt
sudo mount --all
sudo systemctl start docker

cd ~/kbuild
git clone https://github.com/kevwargo/arch-kernel .
docker compose build
```

### 3. Detach volume

- Shutdown
- Detach volume

### 4. Create image from instance
### 5. OUTPUTS

- `ami-xyz`
- `vol-xyz`

## Run build

1. ec2 run with block-device-mapping containing `vol-xyz`
2. `ssh ec2-user@new-ip make -C "~/kbuild" build-ci`
3. debug and/or terminate instance
