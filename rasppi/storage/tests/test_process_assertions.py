"""Deterministic tests of the Docker E2E process-count check."""
import unittest
from unittest.mock import Mock

from process_assertions import HEALTHCHECK, RUNTIME, check, commands


class ProcessAssertionsTest(unittest.TestCase):
    def test_runtime_and_concurrent_healthcheck(self):
        check([RUNTIME])
        check([RUNTIME, HEALTHCHECK, [b"/sbin/docker-init", b"--", *RUNTIME]])

    def test_missing_duplicate_legacy_and_disguised_runtime_fail(self):
        for observed in ([HEALTHCHECK], [RUNTIME, RUNTIME],
                         [RUNTIME, RUNTIME + [b"--house"]],
                         [RUNTIME, [b"php", b"/app/php/house-publisher.php"]],
                         [RUNTIME, HEALTHCHECK + [b"--house"]],
                         [RUNTIME, HEALTHCHECK + [b"unexpected"]]):
            with self.subTest(observed=observed), self.assertRaises(AssertionError):
                check(observed)

    def test_disappearing_proc_and_trailing_delimiters(self):
        root = Mock()
        paths = []
        for pid, data in (("10", b"python\0-m\0storage\0"),
                          ("11", FileNotFoundError()), ("12", ProcessLookupError()),
                          ("13", b"python\0-m\0storage\0--healthcheck\0"),
                          ("99", PermissionError()), ("14", b"")):
            path = Mock()
            path.parent.name = pid
            if isinstance(data, Exception):
                path.read_bytes.side_effect = data
            else:
                path.read_bytes.return_value = data
            paths.append(path)
        root.glob.return_value = paths
        observed = commands(root, own_pid=99)
        self.assertEqual(observed, [RUNTIME, HEALTHCHECK])
        check(observed)
        paths[1].read_bytes.side_effect = PermissionError()
        with self.assertRaises(PermissionError):
            commands(root, own_pid=99)


if __name__ == "__main__":
    unittest.main()
