# Official release/index verified against Docker Hub and upstream release API.
FROM caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f
USER root
# curl/libcap are provided by the official image. File capabilities must be
# removed before running with cap_drop: ALL and no-new-privileges.
RUN apk add --no-cache openssl \
    && setcap -r /usr/bin/caddy \
    && mkdir -p /data/caddy /config/caddy \
    && chown -R 10001:10001 /data /config \
    && chmod 0700 /data /data/caddy /config /config/caddy
COPY docker/https/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0555 docker/https/entrypoint.sh docker/https/healthcheck.sh docker/https/validate-host.sh /usr/local/bin/
USER 10001:10001
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 CMD ["/usr/local/bin/healthcheck.sh"]
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
