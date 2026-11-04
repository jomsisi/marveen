"""Laura Google-hozzaferesenek kozos retege (token + Gmail API).

A PROFIL FIX: ez a csomag KIZAROLAG a `laura` profilt szolgalja. Nem parameter,
mert egy profil-kapcsolo itt azt jelentene, hogy ugyanez a kuldo barmelyik
fiokbol kuldhet -- a tevedes ara pedig egy MAS ember neveben kimeno level.

A TITOK SOSEM KERUL KIMENETRE. Sem az ertek, sem a HOSSZA (2026-11-04: a flottan
negy helyen irtunk ki jelszo-hosszat, es a hossz is informacio).
"""
import json
import os
import urllib.parse
import urllib.request

PROFIL = "laura"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEC = os.path.join(ROOT, "store", "secrets")
API = "https://gmail.googleapis.com/gmail/v1/users/me"


def _titok(nev: str) -> str:
    with open(os.path.join(SEC, nev)) as f:
        return f.read().strip()


def access_token() -> str:
    """Friss access token a refresh tokenbol. A titok nem kerul kimenetre."""
    data = urllib.parse.urlencode({
        "client_id": _titok("google-ads-client-id"),
        "client_secret": _titok("google-ads-client-secret"),
        "refresh_token": _titok(f"{PROFIL}-google-refresh-token"),
        "grant_type": "refresh_token",
    }).encode()
    t = json.load(urllib.request.urlopen(
        urllib.request.Request("https://oauth2.googleapis.com/token", data=data)))
    return t["access_token"]


def api(ut: str, token: str, adat: dict | None = None, modszer: str | None = None) -> dict:
    """Gmail API hivas. `ut` a /users/me UTANI resz, vagy teljes URL."""
    url = ut if ut.startswith("http") else API + ut
    kerelem = urllib.request.Request(url)
    kerelem.add_header("Authorization", f"Bearer {token}")
    if adat is not None:
        kerelem.data = json.dumps(adat).encode()
        kerelem.add_header("Content-Type", "application/json")
    if modszer:
        kerelem.get_method = lambda: modszer
    return json.load(urllib.request.urlopen(kerelem))


def fiok(token: str) -> str:
    """A fiok cime -- MINDEN muvelet elott kiirjuk, hogy kideruljon, kie."""
    return api("/profile", token).get("emailAddress", "?")


def fejlec(uzenet: dict, nev: str) -> str:
    for h in uzenet.get("payload", {}).get("headers", []):
        if h.get("name", "").lower() == nev.lower():
            return h.get("value", "")
    return ""
