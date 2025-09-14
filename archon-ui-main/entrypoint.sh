#!/bin/sh
set -e

if [ -n "$BACKEND_URL" ]; then
    export BACKEND_HOST=$(echo $BACKEND_URL | sed 's|https\?://||' | cut -d'/' -f1)
else
    export BACKEND_HOST="localhost"
fi

echo "Backend URL: $BACKEND_URL"
echo "Backend Host: $BACKEND_HOST"

envsubst '${BACKEND_URL} ${BACKEND_HOST}' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf
rm /etc/nginx/conf.d/default.conf.template

exec "$@"