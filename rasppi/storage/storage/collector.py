"""Bounded RAM intake. SQL is never executed in an MQTT callback."""
from datetime import datetime, timezone
import json
import queue
import threading
import uuid
import paho.mqtt.client as mqtt
from .protocol import decode


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def event(source, kind, **details):
    return {"id": uuid.uuid4().bytes, "source": source, "kind": kind, "received_at": now(),
            "retained": False, "details": json.dumps(details, sort_keys=True), "ack": None}


class Inbox:
    def __init__(self, prefix, size):
        self.prefix = prefix
        self.queue = queue.Queue(maxsize=size)
        self.lock = threading.Lock()
        self.pressure = threading.Event()
        self.dropped = self.invalid = 0
        self.pending_dropped = self.pending_invalid = 0

    def put(self, item):
        try:
            self.queue.put_nowait(item)
            return True
        except queue.Full:
            with self.lock:
                self.dropped += 1
                self.pending_dropped += 1
            self.pressure.set()
            return False

    def reject(self):
        with self.lock:
            self.invalid += 1
            self.pending_invalid += 1

    def gap(self):
        with self.lock:
            if not (self.pending_dropped or self.pending_invalid):
                return None
            item = event(self.prefix, "ingestion_gap", rejected_deliveries=self.pending_invalid,
                         queue_rejected_deliveries=self.pending_dropped, missed_samples="unknown")
            self.pending_invalid = self.pending_dropped = 0
            return item

    def stats(self):
        with self.lock:
            return {"queued": self.queue.qsize(), "dropped": self.dropped, "invalid": self.invalid}


class Subscriber:
    def __init__(self, config, inbox):
        self.config, self.inbox = config, inbox
        self.lock = threading.RLock()
        self.client = None
        self.generation = 0
        self.delivery = 0
        self.pending_mids = {}
        self.connected = self.subscribed = False
        self.accepting = True

    def start(self):
        c = self.config
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=c.client_id,
                             clean_session=True, protocol=mqtt.MQTTv311, manual_ack=True)
        if c.mqtt_user:
            client.username_pw_set(c.mqtt_user, c.mqtt_password or None)
        client.reconnect_delay_set(1, 30)
        client.on_connect, client.on_disconnect = self.on_connect, self.on_disconnect
        client.on_message, client.on_subscribe = self.on_message, self.on_subscribe
        with self.lock:
            self.client = client
        client.connect_async(c.mqtt_host, c.mqtt_port, keepalive=15)
        client.loop_start()

    def on_connect(self, client, userdata, flags, reason, properties):
        with self.lock:
            if client is not self.client:
                return
            self.generation += 1
            self.pending_mids.clear()
            self.connected, self.subscribed = not reason.is_failure, False
            if self.connected:
                self.inbox.put(event(self.config.prefix, "broker_connected", coverage="retained snapshot, not backfill"))
                result, _ = client.subscribe([(self.config.prefix + "/state", 1), (self.config.prefix + "/availability", 1)])
                if result != mqtt.MQTT_ERR_SUCCESS:
                    self.inbox.pressure.set()
                    client.disconnect()

    def on_subscribe(self, client, userdata, mid, reasons, properties):
        with self.lock:
            if client is not self.client:
                return
            self.subscribed = len(reasons) == 2 and all(not r.is_failure for r in reasons)
            if not self.subscribed:
                self.inbox.pressure.set()  # Main loop recreates after denied subscription.
                client.disconnect()

    def on_disconnect(self, client, userdata, flags, reason, properties):
        with self.lock:
            if client is not self.client:
                return
            was_connected = self.connected
            self.connected = self.subscribed = False
            if was_connected and self.accepting:
                self.inbox.put(event(self.config.prefix, "broker_disconnected", missed_samples="unknown"))

    def on_message(self, client, userdata, message):
        with self.lock:
            if client is not self.client or not self.accepting:
                return
            self.delivery += 1
            token = (self.generation, message.mid, message.qos, self.delivery)
            if message.qos:
                self.pending_mids[message.mid] = token
        try:
            if message.topic == self.config.prefix + "/state":
                item = {"kind": "sample", "sample": decode(message.payload), "source": self.config.prefix,
                        "received_at": now(), "retained": bool(message.retain), "ack": token}
            elif message.topic == self.config.prefix + "/availability":
                availability = {b"online": "online", b"offline": "offline"}.get(message.payload)
                if availability is None:
                    raise ValueError("Invalid availability")
                item = event(self.config.prefix, "availability", measurement_time="unknown")
                item.update(availability=availability, retained=bool(message.retain), ack=token)
            else:
                return
        except ValueError:
            self.inbox.reject()
            # Reject invalid input deliberately; don't retry poison messages.
            self.ack(token)
            return
        if not self.inbox.put(item):
            # Withhold ACK and discard this clean session's broker backlog.
            # Main loop recreates only after the local queue has drained.
            client.disconnect()

    def ack(self, token):
        if token is None:
            return
        with self.lock:
            generation, mid, qos, _ = token
            if qos and self.client is not None and self.connected and generation == self.generation and self.pending_mids.get(mid) == token:
                if self.client.ack(mid, qos) == mqtt.MQTT_ERR_SUCCESS:
                    self.pending_mids.pop(mid, None)

    def stop(self):
        with self.lock:
            client = self.client
            if client is None:
                return
            was_connected = self.connected
            self.client = None
            self.connected = self.subscribed = False
        if was_connected and self.accepting:
            self.inbox.put(event(self.config.prefix, "broker_disconnected", reason="collector paused", missed_samples="unknown"))
        client.disconnect()
        client.loop_stop()
