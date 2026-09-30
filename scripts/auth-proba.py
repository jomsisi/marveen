#!/usr/bin/env python3
"""Hajnali orjarat auth-proba -- NEGY szammal, a nevesitett kivetelek kizarasaval.

A kizaras kulcsa KIZAROLAG a registry `kivetel` objektuma. Az `ismert` listat SOHA nem olvassuk:
az az ELO agens-fakat sorolja fel, es azt kizarni pont a merest oltana ki.
"""
import json, sys, re, os, glob
from collections import Counter

AUTH = re.compile(r'401|oauth|auth|login|unauthor|token has expired', re.I)
cfg  = json.load(open(sys.argv[1] if len(sys.argv) > 1
                      else '/root/marveen/marveen/marveen/marveen/store/projektdir-or.json'))
ROOT = cfg['projects_gyoker']
ISMERT_ALAK = set(cfg.get('ismert_alakok', []))   # NEM szuro: az ismeretlen alakot JELEZZUK
KIZART = set(cfg['kivetel'].keys())          # <- kizaro kulcs KIZAROLAG a `kivetel`.
# Az `ismert` listat CSAK itt olvassuk, es NEM kizarasra, hanem a kizaras TILTASARA:
# a valodi hiba az, ha egy ELO fa kerul a `kivetel`-be -- az csendben elnyelne az elo talalatot.
# (A korabbi `assert 'ismert' not in KIZART` csak egy `ismert` NEVU projektre sult volna el.)
utkozes = KIZART & set(cfg.get('ismert', []))
assert not utkozes, f"ELO fa a kivetelben: {sorted(utkozes)}"

def projekt(path):
    rel = os.path.relpath(path, ROOT)
    return rel.split(os.sep)[0]

uj_alak = []
elo_total = kiz_total = 0
elo_auth, kiz_auth = [], []
elo_ts,  kiz_ts    = [], []
fajta = Counter()

files = glob.glob(os.path.join(ROOT, '**', '*.jsonl'), recursive=True)
# POZITIV KONTROLL: ha NULLA fajlt latunk, nem a fa tiszta, hanem a MERO vak (rossz gyoker,
# jogosultsag, elmozdult fa). Enelkul a szkript exit 0-val "tisztat" jelentene -- merve
# 2026-09-30: nem letezo `projects_gyoker` -> exit 0, ures kimenet, megkulonboztethetetlen a
# valodi tiszta esestol. A banner-sor kikotese ezt NEM fedi: az azt mondja meg, hogy a szkript
# LEFUTOTT-e, nem azt, hogy LATOTT-e valamit.
elo_files = [x for x in files if projekt(x) not in KIZART]
if not files:
    print(f"  fajl: 0   *** A MERO NEM LAT ({ROOT}) -- a nulla NEM allitas ***")
    sys.exit(1)
# ES a feltetel a KIZARAS UTAN maradora is all (a boss msg 8270). Ha a fajl-szam pozitiv, de ELO
# fa egy sem marad, az (a)/(b)/(c) ugyanugy nulla -- csak most a KIZARAS oltja ki a merest, nem a
# rossz gyoker. Az assert erre vak, ha a kizart projekt nincs az `ismert`-ben. Ma az elerhetoseg
# nulla (mind a 8 projekt az `ismert` vagy a `kivetel` halmazban van), de a CLASS igy zar be.
if not elo_files:
    print(f"  fajl: {len(files)}, de ELO fa egy sem   *** MINDEN FA KIZARVA -- a nulla NEM allitas ***")
    print(f"      kizart: {sorted(KIZART)}")
    sys.exit(1)
for f in files:
    kiz = projekt(f) in KIZART
    for l in open(f, encoding='utf-8', errors='replace'):
        # GYORSITO elo-szuro: a KULCS NEVERE szur, az ERTEKRE NEM. A szerializalt alakra
        # fogadni (`"isApiErrorMessage":true`) csendes nullat ad egyetlen szokozre is
        # (a boss mutansa, 2026-09-30). A szigoru ellenorzes lentebb dont.
        if 'isApiErrorMessage' not in l:
            continue
        try: d = json.loads(l)
        except Exception: continue
        if d.get('isApiErrorMessage') is not True:
            continue
        c = d.get('message', {}).get('content')
        t = ' '.join(x.get('text','') for x in c if isinstance(x, dict)) if isinstance(c, list) else str(c)
        ts = d.get('timestamp')
        if kiz:
            kiz_total += 1
            if ts: kiz_ts.append(ts)
            if AUTH.search(t): kiz_auth.append((ts, projekt(f), t[:70]))
        else:
            elo_total += 1
            if ts: elo_ts.append(ts)
            fajta[t.strip()[:52]] += 1
            if AUTH.search(t): elo_auth.append((ts, projekt(f), t[:70]))
            if ISMERT_ALAK and t.strip() not in ISMERT_ALAK:
                uj_alak.append((ts, projekt(f), t.strip()))

elo_ts.sort(); kiz_ts.sort()
print(f"  fajl: {len(files)}   kizart projekt: {sorted(KIZART) if KIZART else '-'}")
print(f"  (a) auth-reszhalmaz, kivetel nelkul .......... {len(elo_auth)}")
print(f"  (b) osszes mezo-jelolt, kivetel nelkul ....... {elo_total}"
      + (f"   | a kizarttal egyutt: {elo_total + kiz_total}" if kiz_total else ""))
print(f"  (c) legutobbi barmilyen, KIVETEL NELKUL ...... {elo_ts[-1] if elo_ts else 'nincs'}")
print(f"  (d) kizarva: {kiz_total}" + (f"  ({', '.join(kiz_ts)})" if kiz_ts else ""))
for ts, p, t in kiz_auth:
    print(f"      ebbol auth: {ts}  [{p}]  {t}")
if elo_auth:
    print("  *** ELO FABAN AUTH-TALALAT ***")
    for ts, p, t in elo_auth:
        print(f"      {ts}  [{p}]  {t}")
# UJ ALAK: nem az auth-SZOT keressuk, hanem az ISMERETLEN alakot jelezzuk (boss msg 8277).
# Indok: egy szo-lista pont azon a szoveg-valtozaton bukik, amire keszult -- a `session HAS
# expired` meg a bovitett listat is elkerulte. Az alak-lista viszont nem zajos: 558 soron
# HAT kulonbozo teljes szoveg all, hetek alatt. Az auth-minta igy KENYELEM, nem kapu.
# NEM valtoztat kilepesi kodot: kiirja, es ranezunk. (Harmadik exit-kod ket forrast csinalna.)
if uj_alak:
    print(f"  *** ISMERETLEN ALAK: {len(uj_alak)} -- nezz ra, es ha rendben, vedd fel az `ismert_alakok` koze ***")
    for ts, p, t in uj_alak[:5]:
        print(f"      {ts}  [{p}]  {t[:110]}")
print("  fajtak (elo fa):")
for s, n in fajta.most_common(6):
    print(f"      {n:5d}  {s}")
# A (d) NEM bukik el: csak all. Kilepesi kod kizarolag az ELO fa auth-talalatara.
sys.exit(2 if elo_auth else 0)
