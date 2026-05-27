test -z $DEVBOX_COREPACK_ENABLED || corepack enable --install-directory "/Users/micro/p/gh/levonk/Archon/.devbox/virtenv/nodejs_20/corepack-bin/"
test -z $DEVBOX_COREPACK_ENABLED || export PATH="/Users/micro/p/gh/levonk/Archon/.devbox/virtenv/nodejs_20/corepack-bin/:$PATH"
echo 'Welcome to the Archon devbox environment!'