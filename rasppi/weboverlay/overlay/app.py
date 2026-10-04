import atexit
from pathlib import Path

from flask import Flask, jsonify

from .mqtt import Config, Subscriber
from .state import StateStore


def create_app(config=None, store=None, start_mqtt=True):
    config = config or Config.from_environment()
    store = store or StateStore(config.stale_seconds)
    static = Path(__file__).resolve().parent.parent / "static"
    app = Flask(__name__, static_folder=str(static), static_url_path="/static")
    app.config.update(MAX_CONTENT_LENGTH=1024)
    app.extensions["state"] = store
    if start_mqtt:
        subscriber = Subscriber(config, store)
        app.extensions["mqtt"] = subscriber
        subscriber.start()
        atexit.register(subscriber.stop)

    @app.get("/")
    def index():
        return app.send_static_file("index.html")

    @app.get("/diagramme")
    def diagrams():
        return app.send_static_file("diagrams.html")

    @app.get("/api/state")
    def state():
        return jsonify(store.snapshot())

    @app.get("/healthz")
    def health():
        # Liveness, not MQTT readiness: don't restart a healthy webserver on broker outage.
        return jsonify(status="ok", read_only=True)

    @app.after_request
    def headers(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; "
            "img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
        )
        return response

    return app
