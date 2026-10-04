from dataclasses import dataclass, field
import os
from pathlib import Path
import re
import stat


def number(env, key, default, low, high):
    text = env.get(key, str(default))
    if not text.isascii() or not text.isdecimal() or not low <= int(text) <= high:
        raise ValueError(f"Invalid {key}")
    return int(text)


def secret(env, key, required=False):
    value, filename = env.get(key, ""), env.get(key + "_FILE", "")
    if value and filename:
        raise ValueError(f"Use {key} or {key}_FILE, not both")
    if filename:
        try:
            path = Path(filename)
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
                raise ValueError(f"Invalid {key}_FILE")
            with path.open(encoding="utf-8") as stream:
                value = stream.read(4097)
        except (OSError, UnicodeError) as error:
            raise ValueError(f"Cannot read {key}_FILE") from error
        value = value.rstrip("\r\n")
        if not value:
            raise ValueError(f"Empty {key}_FILE")
    if (required and not value) or len(value.encode()) > 4096 or any(c in value for c in ("\r", "\n", "\x00")):
        raise ValueError(f"Invalid {key}")
    return value


@dataclass(frozen=True)
class Config:
    db_host: str
    db_name: str
    db_user: str
    db_password: str = field(repr=False)
    db_port: int = 3306
    mqtt_host: str = "mqtt-broker"
    mqtt_port: int = 1883
    prefix: str = "evse/wallbox"
    client_id: str = "evse-storage"
    mqtt_user: str = ""
    mqtt_password: str = field(default="", repr=False)
    queue_size: int = 256
    timeout: int = 3

    @classmethod
    def from_environment(cls, env=None):
        env = os.environ if env is None else env
        host, user = env.get("DB_HOST", ""), env.get("DB_USERNAME", "evse_storage")
        name = env.get("DB_NAME", "evse_control")
        prefix, cid = env.get("MQTT_TOPIC_PREFIX", "evse/wallbox"), env.get("MQTT_CLIENT_ID", "evse-storage")
        mqtt_host, mqtt_user = env.get("MQTT_HOST", "mqtt-broker"), env.get("MQTT_USERNAME", "")
        if any(not s or len(s.encode()) > 255 or any(c in s for c in ("\x00", "\r", "\n")) for s in (host, user, mqtt_host, cid)):
            raise ValueError("Invalid DB/MQTT host, user or client ID")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", name):
            raise ValueError("Invalid DB_NAME")
        if not prefix or len(prefix.encode()) > 240 or prefix.startswith("/") or prefix.endswith("/") or any(c in prefix for c in ("+", "#", "\x00", "\r", "\n")):
            raise ValueError("Invalid MQTT_TOPIC_PREFIX")
        password = secret(env, "MQTT_PASSWORD")
        if password and not mqtt_user:
            raise ValueError("MQTT password requires MQTT_USERNAME")
        return cls(host, name, user, secret(env, "DB_PASSWORD", required=True),
                   number(env, "DB_PORT", 3306, 1, 65535), mqtt_host,
                   number(env, "MQTT_PORT", 1883, 1, 65535), prefix, cid,
                   mqtt_user, password, number(env, "STORAGE_QUEUE_SIZE", 256, 8, 4096),
                   number(env, "DB_TIMEOUT_SECONDS", 3, 1, 10))
