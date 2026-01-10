#!/bin/bash

set -ex

time {
    dnf install -y spal-release
    dnf install -y docker-{cli,compose} btrfs-progs screen git make
    dnf clean all
    systemctl enable docker
    systemctl stop docker
    usermod -a -G docker ec2-user
}

# wait for vol availability and attach
# use aws-cli
