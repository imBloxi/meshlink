"""Run with: python -m meshlink [--profile NAME] [--sim]"""
import argparse
import os
from pathlib import Path

from .gui import App


def main():
    ap = argparse.ArgumentParser(description="MeshLink private mesh messenger")
    ap.add_argument("--profile", default="default",
                    help="separate identity/contacts, e.g. to run two copies on one PC")
    ap.add_argument("--sim", action="store_true", help="use localhost simulator instead of a node")
    args = ap.parse_args()
    base = Path(os.environ.get("APPDATA", Path.home())) / "MeshLink" / args.profile
    base.mkdir(parents=True, exist_ok=True)
    App(base, args.sim).mainloop()


if __name__ == "__main__":
    main()
