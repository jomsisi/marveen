#!/usr/bin/env python3
"""Memoria-index or: UGYANARRA a lapra mutato, KULONBOZO cimu index-sorok.

MIERT KELL: a halott-cel or (`memoria-halott-cel-iraskor.py`) csak azt latja, ha a cel NEM
LETEZIK. Egy LETEZO, de MAS lapra vivo link lathatatlan neki -- a fajl megnyilik, a link mukodik,
csak nem arra visz, amit a horog iger. Kimerve 2026-09-30: a MEMORY.md 106. es 108. sora ugyanarra
a lapra mutatott ket kulonbozo tanulsaggal; a 108. valodi helye egy MAS lap volt.

KET OSZTALY, KET KEZELES (michel, agent_messages 8336):
  MECHANIKUS -- a ket "cim" ugyanaz, csak mas alakban (slug-mint-cim, rovid belso hivatkozas).
                SZABALY zarja ki, nem lista: normalizalva egyezik egymassal vagy a cel slugjaval.
                Lista itt csendben elavulna, mert ez az osztaly NONI fog.
  TARTALMI   -- ket valodi, kulonbozo cim ugyanarra a lapra. NEVESITETT kivetel, INDOKKAL,
                a `store/memoria-index-or.json`-ban.

Kilepesi kod: 0 = tiszta, 1 = lelet. A kimenet ELSO sora `fajl:` -- a kilepesi kodot csak akkor
hidd el, ha az megjelent (a Python a meg nem nyithato szkriptre is nem-nulla kodot ad).
"""
import io, json, os, re, sys, unicodedata, collections

MEM = sys.argv[1] if len(sys.argv) > 1 else \
    '.channels-config/projects/-root-marveen-marveen-marveen-marveen/memory'
# A LAPOK konyvtara KULON parameter, es ez NEM kenyelmi opcio: a pozitiv kontroll egy MASOLT
# indexen fut (ket fajl egy temp konyvtarban), a lapok viszont az ELES tarban vannak. Egy kozos
# ut mellett a horog-szo proba `os.path.exists` agan CSENDBEN kiesett minden sor, es a kontroll
# "0 lelet"-et adott -- vagyis a kontroll nem a probat mérte, hanem a sajat utjat.
LAPDIR = sys.argv[2] if len(sys.argv) > 2 else MEM
CFG = 'store/memoria-index-or.json'
FAJLOK = ['MEMORY.md', 'index-teljes-lapjegyzek.md']

def norm(s):
    s = s.replace('-', ' ').replace('_', ' ').casefold()
    s = ''.join(c for c in unicodedata.normalize('NFKD', s) if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9 ]', '', s).strip()

kiv = {}
if os.path.exists(CFG):
    kiv = json.load(open(CFG, encoding='utf-8')).get('ket_cim_egy_cel_kivetel', {})

print(f"  fajl: {len([f for f in FAJLOK if os.path.exists(os.path.join(MEM,f))])}"
      f"   nevesitett kivetel: {sorted(kiv) if kiv else '-'}")

lelet, mech, kizart = [], 0, 0
# NEVEZO. Nem kenyelmi adat (sanyiba, agent_messages 8379): a `LELET 0` KET, egymastol
# megkulonbozhetetlen dolgot jelent -- hogy nincs hiba, es hogy NINCS BEMENET. Ma a masodik allt
# elo: a horgonyzas bevezetese kivette a jegyzek 298 bejegyzeset a proba hatokorebol, es az
# EGYETLEN jel egy szomszed szamlalo volt. A ket hiba FUGGETLEN: a horgony a hamis pozitiv ellen
# ved, a nevezo a hamis nulla ellen -- es az elso javitas eppen hogy ELOALLITOTTA a masodikat.
vizsgalt = {}
horog_vizsgalt = [0]
szam_vizsgalt = {}
for f in FAJLOK:
    p = os.path.join(MEM, f)
    if not os.path.exists(p):
        continue
    cimek = collections.defaultdict(set)
    vizsgalt[f] = 0
    # SOR-ELEJI illeszkedes, es ez NEM kenyelmi szures (mutacios teszt, 2026-09-30, sanyiba
    # elorejelzese nyoman): a `findall` a TELJES fajl-szovegre futott, tehat egy KOD-BLOKKBAN
    # allo, szandekosan hibas PELDA-sor is bejott -- pont az a dokumentalo eset, amitol ovott.
    # Merve: behuzott pelda-sor -> a horog-proba (ami horgonyzott) 0-t adott, EZ a proba 1-et.
    # A HASZNALAT jegye a sor eleji `- [`; a pelda behuzva vagy idezojelben all.
    for s in io.open(p, encoding='utf-8'):
        # Az OPCIONALIS `**<szam>**` elotag NEM elhagyhato: a jegyzek bejegyzesei igy allnak,
        # es nelkule a horgonyzas CSENDBEN kivette az egesz jegyzeket a proba hatokorebol.
        # Az egyetlen jel a SZOMSZED szamlalo volt (mechanikus 5 -> 0), nem egy hiba.
        m = re.match(r'- (?:\*\*\d+\*\*\s*)?\[([^\]]+)\]\(([^)]+\.md)\)', s)
        if m:
            vizsgalt[f] += 1
            cimek[m.group(2)].add(m.group(1).strip())
    for cel, cs in cimek.items():
        if len(cs) < 2:
            continue
        slug = norm(cel[:-3])
        alak = {norm(c) for c in cs}
        # MECHANIKUS: a cimek EGYMAS ROVID ALAKJAI. A proba nem affix-lista (az avulna), hanem
        # RESZSZO-tartalmazas a leghosszabb alakhoz, illetve a cel slugjahoz -- igy a
        # `[lapjegyzek](...)` rovid belso hivatkozas is ide esik, es nem kell nevesiteni.
        # (A korabbi `all(...)` alak ezt LELETNEK vette: michel 8336 mechanikusnak sorolta, es
        #  a POZITIV KONTROLL is azt mondja, hogy csak a 106/108-as parnak kell kijonnie.)
        leghosszabb = max(alak, key=len)
        if len(alak) == 1 or all(a in leghosszabb or a in slug for a in alak):
            mech += 1
            continue
        if cel[:-3] in kiv:
            kizart += 1
            continue
        lelet.append((f, cel, sorted(cs)))

# ---------------------------------------------------------------------------
# MASODIK PROBA (sanyiba, agent_messages 8329/8345): A HOROG KULCSSZAVA A CELLAPBAN.
# MIERT KELL A DUPLIKALT-CEL PROBA MELLE: az elso proba csak akkor lat, ha KETTO sor
# mutat ugyanoda. A 2026-09-30-i bug DUPLIKATUM NELKUL is megfoghato lett volna, mert a
# horog egyetlen disztinktiv szava sem allt a cellapon. A KUSZOB SZANDEKOSAN NULLA, nem
# arany: merve a 106/108-as kontrollon 0/5 (lelet) kontra 2/6 (TEMA-hub, jogos) -- egy
# aranyos kuszob a hubokat is behozna, es akkor az alapvonal nem 0.
STOP = set('a az es de is nem egy ha hogy mert csak mar meg ami amit aki ahol ez ezt azt '
           'nincs van nem lesz volt'.split())
def fold(s):
    s = ''.join(c for c in unicodedata.normalize('NFKD', s.casefold()) if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9 ]', ' ', s)

# ---------------------------------------------------------------------------
# HARMADIK PROBA (michel, agent_messages 8350): UGYANAZ A CEL TOBBSZOR, ELTERO LINK-SZAMMAL.
# MIERT NEM FEDI LE AZ ELSO KETTO: az elso proba KULONBOZO CIMET keres, es a 13 duplikatum
# kozul 9-nel a cim AZONOS volt -- szerkezetileg kivul estek. A lelet nem a duplikalas
# (a rangsor ES a tema-szekcio szandekosan hozza ugyanazt a lapot), hanem hogy a ket
# bejegyzes ELLENTMOND egymasnak: aki keres, az ELSOT talalja meg, es az mindig az elavult.
szam_lelet = []
for f in FAJLOK:
    p2 = os.path.join(MEM, f)
    if not os.path.exists(p2):
        continue
    szamok = {}
    for s in io.open(p2, encoding='utf-8'):
        m = re.match(r'- \*\*(\d+)\*\*\s*\[([^\]]+)\]\(([^)]+\.md)\)', s)
        if m:
            szamok.setdefault(m.group(3), set()).add(m.group(1))
    szam_vizsgalt[f] = sum(len(v) for v in szamok.values())
    for cel, sz in szamok.items():
        if len(sz) > 1:
            szam_lelet.append((f, cel, sorted(sz, key=int)))

horog_lelet = []
# >>> A HOROG-PROBA MOSTANTOL MIND A KET INDEXET OLVASSA (2026-10-05 este). <<<
# 2026-10-04-en megmertem, hogy a kiterjesztes +20 vizsgalt sort es NULLA leletet hozna, tehat
# "nem javitas, csak nagyobb nevezo" -- es akkor ez IGAZ volt. A boss aznapi osszevonasa (99 -> 40
# sor) viszont 65 lap horgat TEMA-SORBA vitte, link nelkul, es a tartalom a lapjegyzekbe folyt at.
# UJRAMERVE a mai alakon:
#     MEMORY.md horog-probalt sor ....  84  ->  19     (-77%)
#     a lapjegyzeken probalhato sor ...  20  ->  97     (+385%)
# Vagyis a kiterjesztes mar nem marginalis: ONNAN JON a fedettseg OTSZOROSE. A tegnapi dontes nem
# volt hibas, hanem ELAVULT -- a hordozo valtozott meg alatta. (A nulla lelet mindket meresben
# ugyanaz, tehat a bevezetes nem hoz hamis pozitiv aradatot.)
for _ip_nev in FAJLOK:
  ip = os.path.join(MEM, _ip_nev)
  if os.path.exists(ip):
    for i, s in enumerate(io.open(ip, encoding='utf-8').read().split('\n')):
          m = re.match(r'- \[([^\]]+)\]\(([^)]+\.md)\)\s*[-\u2014]+\s*(.*)$', s)
          if not m:
              continue
          cim, cel, horog = m.group(1), m.group(2), m.group(3)
          if cel == 'index-teljes-lapjegyzek.md' or not os.path.exists(os.path.join(LAPDIR, cel)):
              continue
          lap = fold(io.open(os.path.join(LAPDIR, cel), encoding='utf-8').read())
          horog_vizsgalt[0] += 1
          szo = [w for w in fold(cim + ' ' + horog.split(';')[0]).split() if len(w) > 5 and w not in STOP]
          if szo and not any(w in lap for w in szo):
              horog_lelet.append((f'{_ip_nev}:{i + 1}', cel, len(szo), cim))

print("  NEVEZO (amit a proba egyaltalan latott):")
for f in FAJLOK:
    if f in vizsgalt:
        print(f"      (1) index-sor {f:34s} {vizsgalt[f]:5d}"
              + (f"   (3) szamozott bejegyzes {szam_vizsgalt.get(f,0)}" if f in szam_vizsgalt else ""))
print(f"      (2) horog-proba: MIND A KET index sora          {horog_vizsgalt[0]:5d}")
assert sum(vizsgalt.values()) > 0 and horog_vizsgalt[0] > 0, \
    "NEVEZO NULLA: a proba nem latott bemenetet -- a LELET 0 itt NEM eredmeny"
print(f"  mechanikus (szabaly zarja ki) ..... {mech}")
print(f"  nevesitett kivetel .............. {kizart}")
print(f"  LELET (ket cim, egy cel) ....... {len(lelet)}")
print(f"  LELET (horog szava nincs a lapon)  {len(horog_lelet)}")
print(f"  LELET (egy cel, ELTERO link-szam)  {len(szam_lelet)}")
for f, cel, sz in szam_lelet:
    print(f"      *** {f}: {cel} -- ket bejegyzes, ellentmondo link-szam: {', '.join(sz)}")
for ln, cel, n, cim in horog_lelet:
    print(f"      *** {ln}: {cel} -- a horog {n} disztinktiv szava kozul EGY SEM all a lapon")
    print(f"            \"{cim}\"")
for f, cel, cs in lelet:
    print(f"      *** {f}: {cel}")
    for c in cs:
        print(f"            \"{c}\"")
sys.exit(1 if (lelet or horog_lelet or szam_lelet) else 0)
