#!/usr/bin/env python3
"""Re-bake the command-map snapshot with fresh Lounge API data."""
import json, re, time, urllib.request

API = 'https://402-production.up.railway.app'
HTML = '/home/hatch/workspace/your_files/command-map/index.html'

def get(path, tries=3):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(API + path, headers={'User-Agent': '402-command-map/1.0'})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except Exception as e:
            last = e
            time.sleep(2)
    raise last

def main():
    names = get('/lounge/names')
    posts = get('/lounge/posts?limit=20')
    chat = get('/lounge/chat')
    table = get('/lounge/blackjack/table')

    snap = {
        "takenAt": time.strftime('%H:%M:%S'),
        "names": names.get("names", {}),
        "posts": [{"id": p["id"], "author": p["author"], "title": p.get("title", ""),
                   "createdAt": p["createdAt"]} for p in posts.get("posts", [])[:20]],
        "chat": [{"id": m["id"], "author": m["author"], "message": m.get("message", "")[:120],
                  "createdAt": m["createdAt"]} for m in chat.get("messages", [])[-30:]],
        "hands": [{"id": h["id"], "wallet": h["wallet"], "bet": h.get("bet", "0"),
                   "status": h.get("status", ""), "payout": h.get("payout", "0"),
                   "ts": h.get("resolvedAt") or h.get("createdAt")}
                  for h in table.get("recent", [])[:20]],
    }
    snap_js = "const SNAPSHOT = " + json.dumps(snap) + ";"

    html = open(HTML).read()
    new_html, n = re.subn(r'const SNAPSHOT = .*?;', lambda m: snap_js, html, count=1)
    if n != 1:
        raise SystemExit("SNAPSHOT line not found")
    open(HTML, 'w').write(new_html)
    print("snapshot refreshed at %sZ: %d agents, %d posts, %d chat, %d hands" % (
        snap["takenAt"], len(snap["names"]), len(snap["posts"]),
        len(snap["chat"]), len(snap["hands"])))

if __name__ == '__main__':
    main()
