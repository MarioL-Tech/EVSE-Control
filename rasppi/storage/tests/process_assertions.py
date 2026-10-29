"""Disposable E2E process assertion; Docker health probes are not collectors."""
import os
from pathlib import Path


RUNTIME = [b"python", b"-m", b"storage"]
HEALTHCHECK = RUNTIME + [b"--healthcheck"]


def commands(root=Path("/proc"), own_pid=None):
    own_pid = str(os.getpid() if own_pid is None else own_pid)
    result = []
    for path in root.glob("[0-9]*/cmdline"):
        if path.parent.name == own_pid:
            continue
        try:
            raw = path.read_bytes()
        except (FileNotFoundError, ProcessLookupError):
            # A concurrent healthcheck can exit between directory and file read.
            continue
        if raw:
            result.append(raw.rstrip(b"\0").split(b"\0"))
    return result


def check(observed):
    collectors = sum(c[:3] == RUNTIME and c != HEALTHCHECK for c in observed)
    assert collectors == 1, "Expected exactly one storage runtime (excluding exact health probes)"
    assert not any(b"--house" in c or any(b"house-publisher.php" in a for a in c)
                   for c in observed), "Separate house runtime must not exist"


if __name__ == "__main__":
    check(commands())
    print("Single storage runtime verified; exact Docker health probes excluded")
