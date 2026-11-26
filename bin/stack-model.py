"""Private Compose JSON on stdin. Output only strictly validated plan metadata."""

import json
import posixpath
import re
import sys


def checked(condition):
    if not condition:
        raise ValueError()


def name(value):
    checked(isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", value))
    return value


def main():
    role, history, workdir = sys.argv[1:]
    model = json.load(sys.stdin)
    project = name(model["name"])
    services = model["services"]
    allowed = dict(web={"weboverlay", "https"}, storage={"storage", "history-rollup", "migrate"},
                   reader={"wallbox-reader"}, uart={"uart-bridge"})
    checked(set(services) <= allowed[role])
    primary = dict(web="weboverlay", reader="wallbox-reader", storage="storage", uart="uart-bridge")[role]
    service = services[primary]
    env = service["environment"]
    database = "-"
    wall = house = "0"
    device = "-"
    selected = [primary]

    def network(key):
        checked(key in service["networks"])
        n = model["networks"][key]
        checked(n.get("external") is True)
        return name(n["name"])

    if role == "web":
        selected += [s for s in ["https"] if s in services]
        checked(network("mqtt") == "evse-mqtt")
        checked("weboverlay" in (service["networks"]["mqtt"] or {}).get("aliases", []))
        checked(model["networks"]["web"].get("internal") is True and model["networks"]["web"]["name"] == project + "_web")
        checked(set(service["networks"]) == ({"mqtt", "web", "database"} if history == "on" else {"mqtt", "web"}))
        checked(service.get("read_only") is True and not service.get("privileged"))
        mounts = service.get("volumes", [])
        for v in mounts:
            checked(v["type"] == "bind")
            if v["target"] == "/run/evse-settings":
                checked(v["source"] == posixpath.normpath(workdir + "/../../.evse-settings"))
            else:
                checked(v["target"] in ("/run/secrets/mqtt-password", "/run/secrets/history-password")
                        and v.get("read_only") is True and not v["source"].endswith(".sock"))
        wall, house = (env[k] for k in ("WEB_HISTORY_ENABLED", "WEB_HOUSE_HISTORY_ENABLED"))
        checked(wall in ("0", "1") and house in ("0", "1"))
        if history == "on" or "1" in (wall, house):
            database = network("database")
            checked(history == "on" and wall == "1" and database != network("mqtt"))
            checked(database != model["networks"]["web"]["name"] and not service["networks"]["database"])
            checked(any(v.get("target") == "/run/secrets/history-password" and v.get("read_only") is True
                        for v in service.get("volumes", [])))
    elif role == "storage":
        database = network("database")
        checked(network("mqtt") == "evse-mqtt" and database != "evse-mqtt")
        if "history-rollup" in services:
            checked("database" in services["history-rollup"]["networks"])
            selected.append("history-rollup")
    elif role == "uart":
        checked(env.get("UART_MODE") == "gateway" and service.get("network_mode") == "evse-mqtt"
                and service.get("restart") == "unless-stopped")
    elif role == "reader":
        checked(network("mqtt") == "evse-mqtt")
    if role in ("uart", "reader"):
        devices = service["devices"]
        checked(len(devices) == 1)
        dev = devices[0]
        # Modern Compose emits mapping form; older V2 serializes short form.
        device = dev["source"] if isinstance(dev, dict) else dev.split(":", 1)[0]
        checked(isinstance(device, str) and re.fullmatch(r"/dev/[A-Za-z0-9/_.:-]+", device))
    # Do not output private environment/hosts/bind mounts or arbitrary commands.
    for s in selected:
        checked(set(services[s].get("depends_on", {})) <= set(selected))
    print(project, database, wall, house, device, *selected)


try:
    main()
except (KeyError, TypeError, ValueError, RecursionError):
    sys.exit("Ungültiges wirksames Stack-Modell (Dienst, Opt-in, DB-Netz, Alias oder Mount).")
