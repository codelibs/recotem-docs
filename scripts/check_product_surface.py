#!/usr/bin/env python3
"""Compare the 2.1 preview tree against the recotem build it documents.

`docs:build` catches a dead link and `docs:check-claims` catches a claim we
already know went stale. Neither notices when a *merged product change* makes a
page wrong: the site still builds, every link still resolves, and it is
describing software that no longer exists. Three consecutive verification
rounds have found exactly that, and twice the offending product PR had merged
within the same day.

This reads four machine-readable surfaces out of an installed recotem and
checks both directions against the preview tree:

  routes       app.openapi()["paths"]              -- every path the app serves
  error codes  recotem.serving.schemas.ErrorCode   -- an exhaustive Literal
  CLI          the Typer app's registered commands
  env vars     RECOTEM_* read anywhere in the package source

NOT OpenAPI for error codes. `routes.py` declares no `responses=`, so the
generated schema carries only 200 and 422 and does not even emit
`ErrorResponse` into `components.schemas` -- it would have missed the 501
`RELATED_NOT_SUPPORTED` that recotem #213 added. The `ErrorCode` Literal is the
real contract: its own docstring says a new code fails type-check until listed
there.

Scope is the `2.1/` preview only, and that is deliberate. The unversioned tree
documents the current *stable* line, which is pinned to a PyPI release and
moves only at a release; checking it against product `main` would report every
unreleased feature as a documentation hole. Pass --tree to point this at a
different directory once a release makes that useful.

Usage:
    pip install "recotem @ git+https://github.com/codelibs/recotem@main"
    python scripts/check_product_surface.py
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys
import tempfile
from typing import get_args

REPO = pathlib.Path(__file__).resolve().parent.parent

# Surfaces the product exposes that the site deliberately does not document.
# Every entry needs a reason; an unexplained entry is how a gate rots into
# noise suppression.
UNDOCUMENTED_OK: dict[str, set[str]] = {
    "routes": set(),
    "error_codes": set(),
    "cli": set(),
    "env": set(),
}

# Things the site documents that the *schema* cannot confirm. Each entry is a
# stated blind spot, not a silenced failure.
#
#   /v1/metrics  is declared include_in_schema=False, so it never appears in
#                app.openapi(). Reading it out of app.routes does not work
#                either: recent FastAPI wraps include_router() in a lazy
#                container that does not flatten. BLIND SPOT: if the product
#                deleted this route, this script would not notice. The
#                environment-variables page is the authority for it.
EXPECTED_PHANTOM: dict[str, set[str]] = {
    "routes": {"/v1/metrics"},
    "cli": set(),
}

# Tokens on the site that look like an error code but are not one.
NOT_AN_ERROR_CODE = {
    "CMD_SHELL",
    "IALS",
    "BPRFM",
    "TOPPOP",
    "OK",
    "CRITICAL",
    "WARNING",
}


def _pages(
    tree: pathlib.Path, exclude: frozenset[str] = frozenset()
) -> list[pathlib.Path]:
    """Every markdown page under `tree`, skipping the named subdirectories."""
    return [
        p
        for p in tree.rglob("*.md")
        if not (set(p.relative_to(tree).parts[:-1]) & exclude)
    ]


def product_surface() -> dict[str, set[str]]:
    """Read the four surfaces out of the installed recotem."""
    os.environ.setdefault("RECOTEM_SIGNING_KEYS", "ci:" + "ab" * 32)
    os.environ.setdefault("RECOTEM_ENV", "test")
    os.environ.setdefault("RECOTEM_METRICS_ENABLED", "1")
    os.environ.pop("RECOTEM_API_KEYS", None)

    import recotem
    from recotem.config import ServeConfig
    from recotem.serving.app import create_app
    import recotem.serving.schemas as schemas

    cfg = ServeConfig.from_env()
    cfg.recipes_dir = pathlib.Path(tempfile.mkdtemp())
    app = create_app(cfg)
    paths = set(app.openapi()["paths"])

    import recotem.cli as cli_mod

    commands = {
        c.name or c.callback.__name__
        for c in cli_mod.app.registered_commands
    }

    pkg = pathlib.Path(recotem.__file__).parent
    env_names: set[str] = set()
    for py in pkg.rglob("*.py"):
        for m in re.finditer(r"\bRECOTEM_[A-Z0-9_]+", py.read_text(errors="replace")):
            env_names.add(m.group(0))
    # RECOTEM_RECIPE_* is a user-chosen prefix, not a fixed variable, and the
    # source carries example names (RECOTEM_RECIPE_DB_DSN, ...) that are not
    # part of the contract.
    env_names = {
        e
        for e in env_names
        if not e.startswith("RECOTEM_RECIPE_") and e != "RECOTEM_HTTP_"
    }

    return {
        "routes": paths,
        "error_codes": set(get_args(schemas.ErrorCode)),
        "cli": commands,
        "env": env_names,
    }


def site_surface(
    tree: pathlib.Path, exclude: frozenset[str] = frozenset()
) -> tuple[dict[str, set[str]], str]:
    """Read the same four surfaces out of the markdown under `tree`.

    `exclude` names immediate subdirectories to skip, so a translated subtree
    can be checked on its own instead of covering for the original.
    """
    text = "\n".join(
        p.read_text(errors="replace")
        for p in sorted(_pages(tree, exclude))
    )

    routes = set()
    for m in re.finditer(r"/v1/[A-Za-z0-9_{}:/-]*", text):
        r = m.group(0).rstrip(".,;:`)")
        # The site writes the verbs against a concrete recipe name in curl
        # examples; normalise those back to the templated form.
        r = re.sub(r"/v1/recipes/[A-Za-z0-9_-]+(?=[:$])", "/v1/recipes/{name}", r)
        r = re.sub(r"/v1/recipes/[A-Za-z0-9_-]+$", "/v1/recipes/{name}", r)
        r = r.rstrip("/") or "/v1"
        if r != "/v1":
            routes.add(r)

    codes = {
        m.group(1)
        for m in re.finditer(r"`([A-Z][A-Z0-9_]{4,})`", text)
        if not m.group(1).startswith("RECOTEM_")
    } - NOT_AN_ERROR_CODE

    # Deliberately NOT an alternation of the six known commands. Spelling the
    # product's own command list into the site-side regex made the PHANTOM
    # direction dead code -- a page could invent `recotem migrate` and the
    # token could never enter this set -- and would have raised a false
    # UNDOCUMENTED for a newly added command that the site *did* document.
    # Anchored on a backtick so prose ("recotem then loads ...") cannot match.
    cli = {m.group(1) for m in re.finditer(r"`recotem ([a-z][a-z0-9-]*)", text)}

    env = {m.group(0) for m in re.finditer(r"\bRECOTEM_[A-Z0-9_]+", text)}
    env = {e for e in env if not e.startswith("RECOTEM_RECIPE_")}

    return {"routes": routes, "error_codes": codes, "cli": cli, "env": env}, text


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", default="2.1", help="documentation tree to check")
    ap.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="DIR",
        help="subdirectory to skip (repeatable); use it to check one language "
        "at a time so a translation cannot stand in for the original",
    )
    args = ap.parse_args()

    tree = REPO / args.tree
    if not tree.is_dir():
        print(f"no such tree: {tree}", file=sys.stderr)
        return 2

    exclude = frozenset(args.exclude)
    prod = product_surface()
    site, site_text = site_surface(tree, exclude)

    failures: list[str] = []

    # --- Direction 1: the product exposes it, the site never mentions it. ----
    for kind in ("routes", "error_codes", "cli", "env"):
        missing = prod[kind] - site[kind] - UNDOCUMENTED_OK.get(kind, set())
        for item in sorted(missing):
            failures.append(
                f"UNDOCUMENTED  {kind}: {item}\n"
                f"    the product exposes this and no page under {args.tree}/ mentions it"
            )

    # --- Direction 2: the site documents it, the product has no such thing. --
    # Only routes and CLI commands are checked this way. Error codes and env
    # vars appear in prose in forms this cannot reliably tell apart from a
    # genuine reference, and a false failure here is how the job gets ignored.
    for kind in ("routes", "cli"):
        phantom = site[kind] - prod[kind] - EXPECTED_PHANTOM.get(kind, set())
        for item in sorted(phantom):
            failures.append(
                f"PHANTOM       {kind}: {item}\n"
                f"    {args.tree}/ documents this and the product does not serve it"
            )

    counts = "  ".join(f"{k}={len(prod[k])}" for k in sorted(prod))
    skipped = f"  (excluding {'/, '.join(sorted(exclude))}/)" if exclude else ""
    print(f"product surface: {counts}")
    print(f"site tree: {args.tree}/  ({len(_pages(tree, exclude))} pages){skipped}")

    if failures:
        print()
        for f in failures:
            print(f)
        print(f"\n{len(failures)} drift finding(s)")
        return 1

    print("no drift: every product surface is documented and vice versa")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
