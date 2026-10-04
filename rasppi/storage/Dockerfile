FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM base AS test
COPY storage ./storage
COPY migrations ./migrations
COPY tests ./tests
RUN python -m unittest discover -s tests -p test_unit.py -v && touch /tmp/unit-tested
CMD ["python", "-m", "unittest", "discover", "-s", "tests", "-v"]

FROM base AS runtime
COPY --from=test /tmp/unit-tested /unit-tested
COPY storage ./storage
COPY migrations ./migrations
USER 10001:10001
ENTRYPOINT ["python", "-m", "storage"]
