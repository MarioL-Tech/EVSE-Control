"""Interactive entrypoint regressions; discovered by Dockerfile.uart only."""
import contextlib
import io
import os
from pathlib import Path
import runpy
import unittest
from unittest.mock import Mock, patch


class InteractiveTests(unittest.TestCase):
    def run_bridge(self, text, reads):
        port = Mock()
        port.readline.side_effect = reads
        stdin = io.StringIO(text)
        polls = []

        def readable(*args):
            polls.append(True)
            # Bound the old EOF busy loop too: a regression must fail, not hang.
            if len(polls) > 10:
                raise AssertionError("stdin spin starved serial receive")
            return [stdin], [], []

        output = io.StringIO()
        with patch.dict(os.environ, {"UART_MODE": "interactive"}), \
                patch("serial.Serial", return_value=port), \
                patch("select.select", side_effect=readable), \
                patch("sys.stdin", stdin), contextlib.redirect_stdout(output):
            runpy.run_path(str(Path(__file__).resolve().parents[1] / "src" / "main.py"))
        port.close.assert_called_once_with()
        return port, polls, output.getvalue()

    def test_eof_disables_stdin_polling_but_keeps_serial_receive(self):
        port, polls, output = self.run_bridge("", [
            b"EVSE:STATUS:CHARGING:UNKNOWN:SRC:query\n", KeyboardInterrupt()])
        self.assertEqual(len(polls), 1)
        self.assertEqual(port.readline.call_count, 2)
        port.write.assert_not_called()
        self.assertIn("CHARGING:UNKNOWN:SRC:query", output)

    def test_blank_line_does_not_skip_serial_receive(self):
        port, polls, _ = self.run_bridge("\nstatus\n", [b"", b"", KeyboardInterrupt()])
        self.assertEqual(len(polls), 3)
        self.assertEqual(port.readline.call_count, 3)
        port.write.assert_called_once_with(b"CMD:STATUS\n")


if __name__ == "__main__":
    unittest.main()
