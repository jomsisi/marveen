#!/usr/bin/env python3
"""Laura Gmail OLVASO. Kuldeni NEM tud -- a kuldes a send.py-ban van, szandekosan.

    python3 scripts/laura-mail/olvas.py fiok
    python3 scripts/laura-mail/olvas.py lista [darab]
    python3 scripts/laura-mail/olvas.py kereses "<gmail query>" [darab]
    python3 scripts/laura-mail/olvas.py olvas <uzenet-id>
    python3 scripts/laura-mail/olvas.py melleklet <uzenet-id> <celmappa>

MIERT KULON FAJL A KULDES (2026-11-04): a `send.py` nevre az ugynoki email-kapu
(scripts/email-send-gate.mjs) TUZEL, az olvasasra nem. Ha a ketto egy fajlban
allna, vagy a kapu minden olvasast is blokkolna, vagy -- ha a nevet "olvasora"
valasztjuk -- a KULDES csusszana at a kapun. A szetvalasztas tehat nem stilus.
"""
import base64
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _kozos import api, access_token, fiok, fejlec  # noqa: E402

CIMKE_SOR = "{:<20} {:<32} {}"


def _reszek(hasznos: dict, gyujto: list) -> None:
    """A MIME-fa MINDEN szintje (a rekurzio nelkul a multipart/alternative
    torzse elveszik, es a level URESNEK latszik -- nem hibanak)."""
    if hasznos.get("body", {}).get("data"):
        gyujto.append((hasznos.get("mimeType", "?"), hasznos["body"]["data"]))
    for r in hasznos.get("parts", []) or []:
        _reszek(r, gyujto)


def _csatolmanyok(hasznos: dict, gyujto: list) -> None:
    """A mellekletek a MIME-fa BARMELY szintjen allhatnak (multipart/mixed ala
    beagyazott multipart/related is gyakori). Az elso valtozat csak a LEGFELSO
    szintet jarta be, es egy melyebben fekvo csatolmany URES listaként jott ki --
    nem hibakent (kimerve 2026-11-04, a javitas elott)."""
    if hasznos.get("filename"):
        gyujto.append(hasznos)
    for r in hasznos.get("parts", []) or []:
        _csatolmanyok(r, gyujto)


def _dekodol(adat: str) -> str:
    return base64.urlsafe_b64decode(adat + "=" * (-len(adat) % 4)).decode("utf-8", "replace")


def lista(token: str, darab: int, query: str = "") -> None:
    p = f"/messages?maxResults={darab}"
    if query:
        p += "&q=" + urllib.parse.quote(query)
    v = api(p, token)
    uzenetek = v.get("messages", []) or []
    # A `resultSizeEstimate` SZANDEKOSAN nem kerul kimenetre (merve 2026-11-04):
    # a szuretlen listara, a `from:wolt`-ra es a `older_than:1y`-re EGYARANT 201-et
    # adott, mikozben a fiokban 24 806 level van. Egy szam, ami a szures utan sem
    # valtozik, nem osszeg -- es egy olvaso osszegnek fogja olvasni.
    print(f"TALALAT (visszaadott sorok): {len(uzenetek)}")
    if not uzenetek:
        print("  -- nulla talalat. EZ NEM BIZONYITJA, hogy nincs ilyen level:")
        print("     eloszor a query-t ellenorizd (a Gmail sajat szintaxisa).")
        return
    for u in uzenetek:
        m = api(f"/messages/{u['id']}?format=metadata"
                "&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date", token)
        print(CIMKE_SOR.format(u["id"], fejlec(m, "From")[:32], fejlec(m, "Subject")[:60]))


def olvas(token: str, mid: str) -> None:
    m = api(f"/messages/{mid}?format=full", token)
    print(f"ID      : {mid}")
    for n in ("Date", "From", "To", "Cc", "Subject"):
        if fejlec(m, n):
            print(f"{n:<8}: {fejlec(m, n)}")
    gy: list = []
    _reszek(m.get("payload", {}), gy)
    sima = [(t, d) for t, d in gy if t == "text/plain"]
    valasztott = sima or gy
    # A TIPUS KIIRASA NEM KOZMETIKA: ha nincs text/plain, a HTML-re esunk vissza,
    # es a kimenet akkor markup. E nelkul az olvaso azt hiszi, ez a level szovege.
    if valasztott:
        print(f"\n--- TORZS ({valasztott[0][0]}{'' if sima else ', nincs text/plain resz'}) ---")
        print(_dekodol(valasztott[0][1]))
    else:
        print("\n--- TORZS ---\n(nincs dekodolhato torzs)")
    cs: list = []
    _csatolmanyok(m.get("payload", {}), cs)
    if cs:
        print("\n--- MELLEKLET ---")
        for r in cs:
            print(f"  {r['filename']}  ({r.get('mimeType', '?')}, {r.get('body', {}).get('size', '?')} bajt)")


def melleklet(token: str, mid: str, cel: str) -> None:
    """A mellekletet FAJLBA irja. A tartalom NEM megy a kimenetre: egy level
    melleklete ugyfel-adat, es a kimenet naploba/transzkriptbe kerul."""
    os.makedirs(cel, exist_ok=True)
    m = api(f"/messages/{mid}?format=full", token)
    db = 0
    cs: list = []
    _csatolmanyok(m.get("payload", {}), cs)
    for r in cs:
        aid = r.get("body", {}).get("attachmentId")
        if not aid:
            continue
        a = api(f"/messages/{mid}/attachments/{aid}", token)
        nyers = base64.urlsafe_b64decode(a["data"] + "=" * (-len(a["data"]) % 4))
        ut = os.path.join(cel, os.path.basename(r["filename"]))
        with open(ut, "wb") as f:
            f.write(nyers)
        os.chmod(ut, 0o600)
        print(f"MENTVE: {ut} ({len(nyers)} bajt)")
        db += 1
    if not db:
        print("Ennek a levelnek nincs mellekelt fajlja.")


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "fiok"
    t = access_token()
    if cmd == "fiok":
        print(f"A fiok: {fiok(t)}")
        return
    print(f"[fiok] {fiok(t)}", file=sys.stderr)
    if cmd == "lista":
        lista(t, int(sys.argv[2]) if len(sys.argv) > 2 else 10)
    elif cmd == "kereses":
        lista(t, int(sys.argv[3]) if len(sys.argv) > 3 else 10, sys.argv[2])
    elif cmd == "olvas":
        olvas(t, sys.argv[2])
    elif cmd == "melleklet":
        melleklet(t, sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
