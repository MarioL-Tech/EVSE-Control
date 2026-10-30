FROM composer:2.8 AS composer

FROM php:8.4-apache-bookworm AS base
ENV EVSE_HTTP_PORT=8080
WORKDIR /app
RUN docker-php-ext-install pcntl pdo_mysql \
    && php -r 'exit(extension_loaded("curl") && extension_loaded("pdo_mysql") ? 0 : 1);'
COPY docker/apache.conf /etc/apache2/apache2.conf
COPY docker/php.ini /usr/local/etc/php/conf.d/evse.ini

FROM base AS dependencies
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
COPY composer.json composer.lock ./
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/* \
    && composer validate --no-check-publish \
    && composer install --no-dev --prefer-dist --no-interaction --no-progress --optimize-autoloader

FROM base AS test
RUN apt-get update && apt-get install -y --no-install-recommends mosquitto mosquitto-clients mariadb-client nodejs \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /app/vendor ./vendor
COPY --from=dependencies /app/composer.lock ./composer.lock
COPY php ./php
COPY public ./public
COPY docker ./docker
COPY static ./static
COPY tests ./tests
RUN chmod +x docker/entrypoint.sh \
    && mkdir -p /run/evse-settings && chown 10001:10001 /run/evse-settings && chmod 700 /run/evse-settings
USER 10001:10001
RUN find php public docker tests -name '*.php' -print0 | xargs -0 -n1 php -l \
    && apache2 -t \
    && php tests/unit.php && php tests/shared.php && php tests/transport.php && php tests/smartmeter.php && php tests/history.php && php tests/archive.php \
    && php tests/house-history.php && php tests/minute-history.php && php tests/env-settings.php && php tests/settings-provision.php && php tests/control.php && node tests/env-settings-http.cjs && node tests/control-http.cjs \
    && node tests/integration.cjs && node tests/smartmeter-integration.cjs \
    && node --test tests/frontend.test.cjs tests/charts.test.cjs tests/theme.test.cjs tests/smartmeter.test.cjs tests/history.test.cjs tests/newcalendar.test.cjs tests/pwa.test.cjs tests/house-history.test.cjs tests/env-settings.test.cjs tests/wallbox-control.test.cjs \
    && touch /tmp/tests-passed

FROM base AS runtime
COPY --from=test /tmp/tests-passed /tests-passed
COPY --from=dependencies /app/vendor ./vendor
COPY --from=dependencies /app/composer.lock ./composer.lock
COPY php ./php
COPY public ./public
COPY docker ./docker
COPY static ./static
RUN chmod +x docker/entrypoint.sh
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["php", "/app/docker/healthcheck.php"]
ENTRYPOINT ["/app/docker/entrypoint.sh"]
