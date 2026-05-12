FROM node:22-alpine

WORKDIR /app

# Install production dependencies
COPY package.json ./
RUN npm install --omit=dev --no-package-lock

# Copy application
COPY server.js ./

# Run as non-root (node user is built-in in node:* images, UID 1000)
USER node

EXPOSE 9000

CMD ["node", "server.js"]
