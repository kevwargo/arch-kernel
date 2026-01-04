#!/bin/sh

[ -d src/clean ] || exit 1
[ -d src/mod ] || exit 1

cd src/mod
find -type f | {
    cd ..
    while read f; do
        diff -Nu {clean,mod}/"${f#./}"
    done > ../kvz-kernel.patch
}
