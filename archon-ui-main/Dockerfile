FROM node:18-alpine as builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
RUN apk add --no-cache gettext
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/conf.d/default.conf.template
COPY entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENV BACKEND_URL=http://localhost:8181
EXPOSE 5173
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]