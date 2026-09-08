"""Execute the real entry point, replacing only its gh transport in this test process."""
import runpy
import subprocess
import sys

real_run = subprocess.run


def fixture_run(args, *positional, **kwargs):
    if isinstance(args, list) and args and args[0] == "gh":
        args = [sys.executable, sys.argv[2], *args[1:]]
    return real_run(args, *positional, **kwargs)


subprocess.run = fixture_run
runpy.run_path(sys.argv[1], run_name="__main__")
