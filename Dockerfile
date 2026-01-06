FROM archlinux

RUN pacman -Syyu --noconfirm && \
    pacman -S --noconfirm sudo devtools base-devel bc cpio pahole rust{,-bindgen,-src}

RUN useradd --user-group --create-home --uid 1000 arch && \
    echo 'arch ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/arch

USER arch

ADD ./keys/pgp /home/arch/kbuild-keys
RUN gpg --import /home/arch/kbuild-keys/*.asc && gpgconf --kill all
