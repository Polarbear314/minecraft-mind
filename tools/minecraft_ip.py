#!/usr/bin/env python3
"""Find the IP addresses friends need to join your Minecraft server."""

import socket
import urllib.request

PORT = 25565  # default Minecraft Java Edition port


def get_local_ip():
    """Local (LAN) IP — use this for friends on the same Wi-Fi."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def get_public_ip():
    """Public IP — use this for friends outside your network."""
    try:
        return urllib.request.urlopen(
            "https://api.ipify.org", timeout=5
        ).read().decode()
    except Exception:
        return None


def main():
    local = get_local_ip()
    public = get_public_ip()

    print("=" * 40)
    print("  Minecraft Server Address Helper")
    print("=" * 40)
    print(f"\nSame Wi-Fi (LAN):   {local}:{PORT}")

    if public:
        print(f"Over the internet:  {public}:{PORT}")
    else:
        print("Over the internet:  (couldn't reach the internet)")

    print("\nNotes:")
    print(" - If the port isn't 25565, change PORT at the top.")
    print(" - For internet play you must forward the port on your router,")
    print("   otherwise only the LAN address will work.")


if __name__ == "__main__":
    main()
