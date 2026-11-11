#!/usr/bin/env python3
"""Update MC_PORT in .env. Usage:
    python3 setport.py 61441
or just `python3 setport.py` and type the port when asked."""
import re
import sys
from pathlib import Path

env_path = Path(__file__).parent / ".env"

if len(sys.argv) > 1:
    port = sys.argv[1]
else:
    port = input("New LAN port: ").strip()

if not port.isdigit() or not (1 <= int(port) <= 65535):
    sys.exit(f"'{port}' doesn't look like a valid port number.")

text = env_path.read_text()
new_text, count = re.subn(r"^MC_PORT=.*$", f"MC_PORT={port}", text, flags=re.M)
if count == 0:
    new_text = text.rstrip("\n") + f"\nMC_PORT={port}\n"

env_path.write_text(new_text)
print(f"MC_PORT set to {port}. Now run: npm start")
