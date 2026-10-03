FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

FROM base AS test
RUN apt-get update && apt-get install -y --no-install-recommends mosquitto mosquitto-clients nodejs \
    && rm -rf /var/lib/apt/lists/*
COPY overlay ./overlay
COPY static ./static
COPY tests ./tests
RUN python -m unittest discover -s tests -v && node --test tests/frontend.test.cjs \
    && touch /tests-passed

FROM base AS runtime
COPY --from=test /tests-passed /tests-passed
COPY overlay ./overlay
COPY static ./static
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).close()"
# Exactly one worker owns the in-memory snapshot and MQTT connection. No preload.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "30", "--graceful-timeout", "5", "--worker-tmp-dir", "/tmp", "overlay.app:create_app()"]
