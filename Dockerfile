FROM nginx:stable-alpine

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html
COPY docker/40-generate-config.sh /docker-entrypoint.d/40-generate-config.sh

RUN chmod +x /docker-entrypoint.d/40-generate-config.sh

EXPOSE 80
