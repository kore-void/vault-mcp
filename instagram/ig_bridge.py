"""Instagram bridge — volaný z vault-mcp jako subprocess.
Příjem příkazu přes argv[1] (JSON), výstup na stdout (JSON).
Session se ukládá do ig_session.json vedle tohoto souboru.
"""
from __future__ import annotations
import json
import sys
import os
from pathlib import Path
from datetime import datetime

SESSION_FILE  = Path(__file__).parent / "ig_session.json"
SETTINGS_FILE = Path(__file__).parent / "ig_settings.json"
WATCHLIST_FILE = Path(__file__).parent / "ig_watchlist.json"
SNAPSHOTS_DIR  = Path(__file__).parent / "ig_snapshots"


# ── Session / client ──────────────────────────────────────────────────────────

def get_client():
    from instagrapi import Client

    cl = Client()
    cl.delay_range = [1, 3]

    if SESSION_FILE.exists():
        s = json.loads(SESSION_FILE.read_text())
        cookies = s.get("cookies", {})
        if cookies.get("sessionid"):
            cl.set_settings({
                "cookies": {
                    "sessionid":  cookies.get("sessionid", ""),
                    "ds_user_id": cookies.get("ds_user_id", ""),
                    "csrftoken":  cookies.get("csrftoken", ""),
                    "mid":        cookies.get("mid", ""),
                }
            })
            try:
                user = os.environ.get("IG_USER", "")
                password = os.environ.get("IG_PASSWORD", "")
                cl.login(user, password, relogin=False)
                return cl
            except Exception:
                pass  # session expirovala, fresh login níže

    user = os.environ.get("IG_USER", "")
    password = os.environ.get("IG_PASSWORD", "")
    if not user or not password:
        raise ValueError("IG_USER a IG_PASSWORD env vars nejsou nastaveny")

    cl.login(user, password)
    cl.dump_settings(SESSION_FILE)
    return cl


# ── Watchlist helpers ─────────────────────────────────────────────────────────

def load_watchlist() -> dict:
    if WATCHLIST_FILE.exists():
        return json.loads(WATCHLIST_FILE.read_text(encoding="utf-8"))
    return {"accounts": []}


def save_watchlist(wl: dict) -> None:
    WATCHLIST_FILE.write_text(
        json.dumps(wl, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ── Základní příkazy ──────────────────────────────────────────────────────────

def cmd_profile(args: dict) -> dict:
    """Načti profil a základní statistiky."""
    cl = get_client()
    username = args["username"]
    user = cl.user_info_by_username(username)
    return {
        "username": user.username,
        "full_name": user.full_name,
        "bio": user.biography,
        "followers": user.follower_count,
        "following": user.following_count,
        "posts": user.media_count,
        "is_private": user.is_private,
        "is_verified": user.is_verified,
        "profile_url": f"https://instagram.com/{user.username}",
        "external_url": str(user.external_url or ""),
        "user_id": str(user.pk),
    }


def cmd_posts(args: dict) -> dict:
    """Načti posledních N postů profilu."""
    cl = get_client()
    username = args["username"]
    limit = int(args.get("limit", 12))

    user = cl.user_info_by_username(username)
    if user.is_private:
        return {"error": f"@{username} má soukromý profil"}

    medias = cl.user_medias(user.pk, amount=limit)
    posts = []
    for m in medias:
        posts.append({
            "id": str(m.pk),
            "type": m.media_type.name if hasattr(m.media_type, 'name') else str(m.media_type),
            "caption": (m.caption_text or "")[:300],
            "likes": m.like_count,
            "comments": m.comment_count,
            "taken_at": m.taken_at.isoformat() if m.taken_at else "",
            "url": f"https://instagram.com/p/{m.code}/",
            "hashtags": [t.name for t in (m.usertags or [])],
        })
    return {"username": username, "posts": posts}


def cmd_compare(args: dict) -> dict:
    """Porovnej více konkurentů vedle sebe."""
    cl = get_client()
    usernames = args["usernames"]
    results = []
    for uname in usernames:
        try:
            u = cl.user_info_by_username(uname)
            results.append({
                "username": u.username,
                "followers": u.follower_count,
                "following": u.following_count,
                "posts": u.media_count,
                "verified": u.is_verified,
                "engagement_est": round(u.follower_count * 0.03, 0),
            })
        except Exception as e:
            results.append({"username": uname, "error": str(e)})
    return {"comparison": results}


def cmd_top_posts(args: dict) -> dict:
    """Načti posty seřazené podle liků/komentářů."""
    cl = get_client()
    username = args["username"]
    limit = int(args.get("limit", 20))
    sort_by = args.get("sort_by", "likes")

    user = cl.user_info_by_username(username)
    if user.is_private:
        return {"error": f"@{username} má soukromý profil"}

    medias = cl.user_medias(user.pk, amount=limit)
    posts = []
    for m in medias:
        posts.append({
            "caption": (m.caption_text or "")[:200],
            "likes": m.like_count,
            "comments": m.comment_count,
            "score": m.like_count + m.comment_count * 5,
            "taken_at": m.taken_at.isoformat() if m.taken_at else "",
            "url": f"https://instagram.com/p/{m.code}/",
        })

    key = "likes" if sort_by == "likes" else "score"
    posts.sort(key=lambda x: x.get(key, 0), reverse=True)
    return {"username": username, "top_posts": posts[:10]}


def cmd_hashtag(args: dict) -> dict:
    """Posty pod hashtagy relevantní pro niku."""
    cl = get_client()
    tag = args["tag"].lstrip("#")
    limit = int(args.get("limit", 10))

    medias = cl.hashtag_medias_top(tag, amount=limit)
    posts = []
    for m in medias:
        posts.append({
            "author": m.user.username if m.user else "?",
            "caption": (m.caption_text or "")[:200],
            "likes": m.like_count,
            "comments": m.comment_count,
            "url": f"https://instagram.com/p/{m.code}/",
            "taken_at": m.taken_at.isoformat() if m.taken_at else "",
        })
    return {"hashtag": tag, "posts": posts}


# ── Monitoring příkazy ────────────────────────────────────────────────────────

def cmd_watchlist_add(args: dict) -> dict:
    """Přidej účet(y) do watchlistu."""
    usernames = args.get("usernames") or [args["username"]]
    niche = args.get("niche", "general")

    wl = load_watchlist()
    existing = {a["username"] for a in wl["accounts"]}
    added = []
    skipped = []

    for uname in usernames:
        uname = uname.lstrip("@").strip()
        if uname in existing:
            skipped.append(uname)
        else:
            wl["accounts"].append({
                "username": uname,
                "niche": niche,
                "added_at": datetime.utcnow().isoformat(),
            })
            added.append(uname)

    save_watchlist(wl)
    return {
        "added": added,
        "skipped": skipped,
        "total": len(wl["accounts"]),
    }


def cmd_watchlist_remove(args: dict) -> dict:
    """Odeber účet z watchlistu."""
    username = args["username"].lstrip("@").strip()
    wl = load_watchlist()
    before = len(wl["accounts"])
    wl["accounts"] = [a for a in wl["accounts"] if a["username"] != username]
    save_watchlist(wl)
    removed = before - len(wl["accounts"])
    return {"removed": removed, "username": username, "total": len(wl["accounts"])}


def cmd_watchlist_list(args: dict) -> dict:
    """Zobraz aktuální watchlist."""
    wl = load_watchlist()
    return {"accounts": wl["accounts"], "total": len(wl["accounts"])}


def cmd_snapshot(args: dict) -> dict:
    """Snapshottuj všechny watchlist účty — profil + posledních 12 postů."""
    cl = get_client()
    wl = load_watchlist()

    if not wl["accounts"]:
        return {"error": "Watchlist je prázdný. Přidej účty přes watchlist_add."}

    filter_niche = args.get("niche")
    accounts = wl["accounts"]
    if filter_niche:
        accounts = [a for a in accounts if a.get("niche") == filter_niche]

    ts = datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%S")
    results = []

    for entry in accounts:
        uname = entry["username"]
        try:
            u = cl.user_info_by_username(uname)
            posts_raw = []
            if not u.is_private:
                medias = cl.user_medias(u.pk, amount=12)
                for m in medias:
                    posts_raw.append({
                        "id": str(m.pk),
                        "caption": (m.caption_text or "")[:200],
                        "likes": m.like_count,
                        "comments": m.comment_count,
                        "score": m.like_count + m.comment_count * 5,
                        "taken_at": m.taken_at.isoformat() if m.taken_at else "",
                        "url": f"https://instagram.com/p/{m.code}/",
                    })
            results.append({
                "username": u.username,
                "niche": entry.get("niche", "general"),
                "followers": u.follower_count,
                "following": u.following_count,
                "posts_count": u.media_count,
                "is_verified": u.is_verified,
                "is_private": u.is_private,
                "posts": posts_raw,
            })
        except Exception as e:
            results.append({"username": uname, "error": str(e)})

    snapshot = {
        "timestamp": ts,
        "account_count": len(results),
        "accounts": results,
    }

    SNAPSHOTS_DIR.mkdir(exist_ok=True)
    out_file = SNAPSHOTS_DIR / f"{ts}.json"
    out_file.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "snapshot_file": str(out_file),
        "timestamp": ts,
        "scraped": len([r for r in results if "error" not in r]),
        "errors": len([r for r in results if "error" in r]),
    }


def cmd_report(args: dict) -> dict:
    """Porovnej poslední 2 snapshoty — followers delta, nové posty, engagement."""
    SNAPSHOTS_DIR.mkdir(exist_ok=True)
    files = sorted(SNAPSHOTS_DIR.glob("*.json"))

    if len(files) < 2:
        return {"error": f"Potřebuji alespoň 2 snapshoty, mám {len(files)}. Spusť snapshot příkaz."}

    old_snap = json.loads(files[-2].read_text(encoding="utf-8"))
    new_snap = json.loads(files[-1].read_text(encoding="utf-8"))

    old_by_user = {a["username"]: a for a in old_snap["accounts"] if "error" not in a}
    new_by_user = {a["username"]: a for a in new_snap["accounts"] if "error" not in a}

    changes = []
    for uname, new in new_by_user.items():
        old = old_by_user.get(uname)
        if not old:
            changes.append({"username": uname, "status": "new_in_watchlist"})
            continue

        follower_delta = new["followers"] - old["followers"]
        old_post_ids = {p["id"] for p in old.get("posts", [])}
        new_posts = [p for p in new.get("posts", []) if p["id"] not in old_post_ids]

        avg_engagement_old = (
            sum(p["score"] for p in old["posts"]) / len(old["posts"])
            if old["posts"] else 0
        )
        avg_engagement_new = (
            sum(p["score"] for p in new["posts"]) / len(new["posts"])
            if new["posts"] else 0
        )

        changes.append({
            "username": uname,
            "followers": new["followers"],
            "follower_delta": follower_delta,
            "follower_delta_pct": round(follower_delta / max(old["followers"], 1) * 100, 2),
            "new_posts": len(new_posts),
            "new_posts_detail": new_posts[:3],
            "avg_engagement_old": round(avg_engagement_old, 0),
            "avg_engagement_new": round(avg_engagement_new, 0),
            "engagement_delta": round(avg_engagement_new - avg_engagement_old, 0),
        })

    # Seřadit dle follower delty
    changes.sort(key=lambda x: x.get("follower_delta", 0), reverse=True)

    return {
        "period": f"{old_snap['timestamp']} → {new_snap['timestamp']}",
        "accounts_tracked": len(changes),
        "top_growers": [c for c in changes if c.get("follower_delta", 0) > 0][:5],
        "most_active": sorted(changes, key=lambda x: x.get("new_posts", 0), reverse=True)[:5],
        "all_changes": changes,
    }


def cmd_trending_hashtags(args: dict) -> dict:
    """Zmapuj hashtags v daném segmentu — kdo dominuje, jaký content funguje."""
    cl = get_client()
    tags = args.get("tags") or [args["tag"]]
    limit = int(args.get("limit", 8))

    all_posts = []
    author_freq: dict[str, int] = {}
    tag_results = {}

    for tag in tags:
        tag = tag.lstrip("#").strip()
        try:
            medias = cl.hashtag_medias_top(tag, amount=limit)
            tag_posts = []
            for m in medias:
                author = m.user.username if m.user else "?"
                score = m.like_count + m.comment_count * 5
                post = {
                    "author": author,
                    "caption": (m.caption_text or "")[:150],
                    "likes": m.like_count,
                    "comments": m.comment_count,
                    "score": score,
                    "url": f"https://instagram.com/p/{m.code}/",
                    "hashtag": tag,
                }
                tag_posts.append(post)
                all_posts.append(post)
                author_freq[author] = author_freq.get(author, 0) + 1
            tag_results[tag] = {"posts": tag_posts, "count": len(tag_posts)}
        except Exception as e:
            tag_results[tag] = {"error": str(e)}

    # Top autoři napříč všemi tagy
    top_authors = sorted(author_freq.items(), key=lambda x: x[1], reverse=True)[:10]

    # Top posty dle engagementu
    top_posts = sorted(all_posts, key=lambda x: x["score"], reverse=True)[:10]

    return {
        "tags_analyzed": list(tag_results.keys()),
        "total_posts": len(all_posts),
        "top_authors": [{"username": a, "appearances": n} for a, n in top_authors],
        "top_posts": top_posts,
        "by_tag": tag_results,
    }


# ── Router ────────────────────────────────────────────────────────────────────

COMMANDS = {
    "profile":            cmd_profile,
    "posts":              cmd_posts,
    "compare":            cmd_compare,
    "top_posts":          cmd_top_posts,
    "hashtag":            cmd_hashtag,
    "watchlist_add":      cmd_watchlist_add,
    "watchlist_remove":   cmd_watchlist_remove,
    "watchlist_list":     cmd_watchlist_list,
    "snapshot":           cmd_snapshot,
    "report":             cmd_report,
    "trending_hashtags":  cmd_trending_hashtags,
}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Zadej JSON argument: {\"cmd\": \"...\", ...}"}))
        sys.exit(1)

    try:
        args = json.loads(sys.argv[1])
        cmd = args.pop("cmd")
        if cmd not in COMMANDS:
            print(json.dumps({"error": f"Neznámý příkaz: {cmd}. Dostupné: {list(COMMANDS)}"}))
            sys.exit(1)
        result = COMMANDS[cmd](args)
        print(json.dumps(result, ensure_ascii=False, default=str))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    main()
