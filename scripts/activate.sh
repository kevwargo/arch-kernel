#!/bin/bash

mount_bind() {
    local src="$1" mnt="$2"
    mkdir_mountpoint "$mnt" && mount -v --bind "$src" "$mnt"
}

mount_overlay() {
    [ $# -le 2 ] && return 1

    local lower upper mnt

    while [ $# -gt 2 ]; do
        lower="$1:$lower"
        shift
    done
    lower=${lower%:}

    upper="$1"
    mnt="$2"

    mkdir_mountpoint "$mnt" && \
        mount -v -t overlay overlay -o "lowerdir=$lower,upperdir=$upper,workdir=.ovfs-work" "$mnt"
}

mkdir_mountpoint() {
    local dir="$1"
    if [ ! -e "$dir" ]; then
        mkdir "$dir" && chown `stat -c %u:%d .` "$dir"
    elif [ -d "$dir" ]; then
        if [ `findmnt -n -o ID --target .` -ne `findmnt -n -o ID --target "$dir"` ]; then
            umount -R "$dir" || return 1
        fi
        return 0
    fi

    echo "$dir is not a directory" >/dev/stderr
    return 1
}

case "$1" in
    orig)
        mount_bind orig src
        ;;
    mod)
        mount_overlay orig mod src
        ;;
    build)
        mount_overlay orig build src
        ;;
    build-mod)
        mount_overlay orig mod build src
        ;;
    *)
        echo "Unrecognized command: '$1'"
        exit 1
        ;;
esac

exit $?
