#!/usr/bin/env python3
"""Laura Gmail KULDO. A torzs KOTELEZOEN STDIN-en jon.

    cat <<'TXT' | python3 scripts/laura-mail/send.py --to cim@pelda.hu --subject "Targy"
    A level szovege, barmilyen karakterrel.
    TXT

    # szaraz proba: ossze rakja es KIIRJA, de NEM hiv API-t
    cat torzs.txt | python3 scripts/laura-mail/send.py --szaraz --subject "T" --cim-proba cim@pelda.hu

HAROM KORLAT, EGYMASTOL FUGGETLENUL (es egyik sem helyettesiti a masikat):

1. AZ UGYNOKI EMAIL-KAPU. Ez a fajl SZANDEKOSAN `send.py` nevű, es szandekosan
   `--to` kapcsolot hasznal: a scripts/email-send-gate.mjs pontosan erre az alakra
   TUZEL, tehat egy sub-agens (sanyiba, michel, ...) Bash-hivasa DENY-t kap, a
   fo-agens hivasa nem. Merve 2026-11-04: `python3 scripts/laura-mail/send.py
   --to a@b.hu` -> DENY; `--szaraz` (--to nelkul) -> ALLOW.
   >>> A NEV ES A KAPCSOLO NEV TEHAT VISELKEDES, NEM STILUS. Ha valaki atirja
   (pl. `kuld.py` vagy `--cimzett`), a kapu NEMAN elnemul, es a fajl ugyanugy
   mukodik tovabb -- ez a rosszabb fajta valtozas, mert semmi nem jelez. <<<

2. CIMZETT-ENGEDELYEZES, FAIL-CLOSED. A cimzettnek szerepelnie KELL a
   store/laura-mail-engedelyezett-cimek.txt fajlban. Hianyzo vagy ures fajl ->
   a kuldes ELMARAD. A "csak verifikalt cimre" igy nem emlekezet kerdese.

3. A FIOK ES A CIMZETT MINDEN KULDES ELOTT KIIRODIK, kuldes utan pedig a
   message-id ES a SENT cimke visszaolvasasa a bizonyitek -- nem a kilepesi kod.
"""
import argparse
import base64
import os
import sys
from email.message import EmailMessage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _kozos import ROOT, api, access_token, fiok  # noqa: E402

ENGEDELY_UT = os.path.join(ROOT, "store", "laura-mail-engedelyezett-cimek.txt")


def engedelyezett() -> set:
    """A jovahagyott cimzettek. HIANYZO FAJL -> URES HALMAZ -> minden kuldes elmarad.
    (Fail-closed: a vedelem beallitas HIANYABAN zar, nem nyit.)"""
    if not os.path.exists(ENGEDELY_UT):
        return set()
    with open(ENGEDELY_UT, encoding="utf-8") as f:
        return {s.strip().lower() for s in f
                if s.strip() and not s.lstrip().startswith("#")}


def epit(felado: str, cimzett: str, targy: str, torzs: str) -> EmailMessage:
    m = EmailMessage()
    m["From"] = felado
    m["To"] = cimzett
    m["Subject"] = targy          # az EmailMessage maga RFC 2047-eli az ekezetet
    m.set_content(torzs)
    return m


def main() -> None:
    p = argparse.ArgumentParser(description="Laura Gmail kuldo")
    p.add_argument("--to", help="cimzett (a kapu EZT a kapcsolot ismeri fel)")
    p.add_argument("--cim-proba", help="cimzett CSAK szaraz probahoz (nem kuld)")
    p.add_argument("--subject", required=True)
    p.add_argument("--szaraz", action="store_true", help="ossze rakja, de nem kuld")
    a = p.parse_args()

    cimzett = a.to or a.cim_proba
    if not cimzett:
        p.error("cimzett kell: eles kuldeshez --to, szaraz probahoz --cim-proba")
    if a.to and a.szaraz:
        p.error("--szaraz mellett --cim-proba hasznalj, hogy a szaraz proba se tunjon kuldesnek")

    if sys.stdin.isatty():
        sys.exit("A TORZS STDIN-EN JON. Terminalrol inditva nincs mit kuldeni -- "
                 "igy egy felsorolas-hiba nem valik URES levelle.")
    torzs = sys.stdin.read()
    if not torzs.strip():
        sys.exit("A torzs URES. Nem kuldok ures levelet.")

    t = access_token()
    felado = fiok(t)
    print("--- AMIT KULDENI AKAROK ---")
    print(f"  FELADO  : {felado}")
    print(f"  CIMZETT : {cimzett}")
    print(f"  TARGY   : {a.subject}")
    print(f"  TORZS   : {len(torzs)} karakter, {len(torzs.splitlines())} sor")

    eng = engedelyezett()
    if cimzett.lower() not in eng:
        sys.exit(f"\nELMARAD: a cimzett nincs a jovahagyott listan ({ENGEDELY_UT}).\n"
                 f"A listan most {len(eng)} cim all. A felvetel Zsolt dontese -- "
                 f"ezt a fajlt az ugynok NE irja at magatol.")

    m = epit(felado, cimzett, a.subject, torzs)
    if a.szaraz:
        print("\n--- SZARAZ PROBA: API-HIVAS NEM TORTENT ---")
        print(f"  MIME-meret: {len(m.as_bytes())} bajt")
        print(f"  Targy kodolva: {m['Subject']}")
        return

    nyers = base64.urlsafe_b64encode(m.as_bytes()).decode()
    v = api("/messages/send", t, adat={"raw": nyers})
    mid = v.get("id", "?")
    print(f"\nELKULDVE. message-id: {mid}  cimkek: {','.join(v.get('labelIds', []))}")

    # BIZONYITEK: a valasz nem bizonyitek -- olvassuk vissza a tarolobol.
    vissza = api(f"/messages/{mid}?format=metadata&metadataHeaders=To&metadataHeaders=Subject", t)
    cimkek = vissza.get("labelIds", [])
    print(f"VISSZAOLVASVA: cimkek={','.join(cimkek)}  "
          f"{'SENT megvan' if 'SENT' in cimkek else '!! SENT NINCS a cimkek kozott'}")


if __name__ == "__main__":
    main()
