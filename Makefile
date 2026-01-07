# TODO: mount orig,build,mod,etc. from some other device/btrfs-subvol/etc.

ACTV = ./scripts/activate.sh
DOCK = docker compose run --rm kbuild

.PHONY: activate-orig activate-mod activate-build activate-build-mod extract build

activate-orig:
	$(ACTV) orig

activate-mod:
	$(ACTV) mod

activate-build:
	$(ACTV) build

activate-build-mod:
	$(ACTV) build-mod

extract:
	$(DOCK) makepkg --nobuild

build:
	$(DOCK) makepkg --noextract --force
