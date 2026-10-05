#!/usr/bin/env python3
"""AZ UTEMEZETT FELADATOK SKILL.md MERETENEK ORE -- 1200 sor / 60 000 BAJT.

(A MERTEKEGYSEG KIIRVA, nem `60 kB`. A rovidített alak SI-kent 60 000, KiB-kent 61 440, es a koto
konstans egy MASIK sorban all -- a ketertelmuseg EGY szamban all, a feloldasa mashol.
HELYESBITES 2026-10-05, safar 8990 merese: elozoleg az allt itt, hogy erre az alakra "egy gepi
detektor vak". EZ HAMIS, es az en allitasom volt egy MAS AGENS eszkozerol, meres nelkul: safar
detektora FAJL-szinten keresi a ket oldalt, es ezt a fajlt MEGJELOLTE. A hiba nem a detektorban
allt, hanem a TRIAZS-ban: a talalatot "mar javitva"-kent zartuk le a 30. sor kommentje es a 39. sor
`60 * 1000`-e alapjan, es a DOCSTRINGET nem neztuk meg.
ES EZ A FAJL FAJL-SZINTEN TOVABBRA IS ILLESZKEDIK (`60 kB` a 4. es 31. soron, `60*1024` a 30.-on),
mert a javitas KOMMENTJE idezi a regi alakot. Ez VART es helyes: a javitas dokumentacioja nem
torolheto azert, hogy egy detektor elhallgasson. A triazs-szabaly kezeli: ha egy talalatot "mar
javitva"-kent zarsz le, a bizonyitek NEM a koto konstans erteke, hanem hogy a talalatot KIVALTO
SZOVEG-OLDALI elofordulas is javitva van-e.)

MIERT VAN: a `memoria-heartbeat` 2026-09-07-en mar kapott references/ bontast (10 kB-ra), es
HET NAP alatt 62 kB-ra nott, harom het alatt 198-ra. Az ok nem hanyagsag volt: a fajl megmondja,
MIKOR OLVASD a references-t, de sehol nem mondta meg, mikor IRJ oda. A szetszedes utan a korlat
egyetlen vedelme egy BEKEZDES volt a fajlban -- tehat egyetlen ellenorzes allt mogotte: hogy
valaki elolvassa. Ez az a gepi or, ami ezt kivaltja.

MIERT NEM BUKIK EL AZONNAL A MAI KET TULLEPESEN: a `kanban-audit` (3835 sor) es a
`cimke-atallas-figyeles` (1613 sor) MA is a korlat folott all, es a szetszedesukrol Zsolt
2026-09-28-an ugy dontott, hogy csak a kanban-audit eri meg. Egy or, ami minden nap ugyanazt a
ket sort jelenti, egy het alatt hasznalhatatlan lesz -- ezert a mar ISMERT tullepes ALLAPOT
(kiirja, nem bukik), es csak az UJ tullepes ESEMENY (exit 1). Ugyanaz a szerkezet, mint a
`memoria-tukor` `tema-hatokor` false positive-janal.

AZ ALAPVONAL A `store/utemezett-meret-alapvonal.json`-ban all. Egy ismert tullepes akkor is
esemenye lesz, ha TOVABB NO: az alapvonal a MERT erteket rogziti, es a novekedes uj riasztas.
Ez szandekos -- a "mar tudunk rola" nem jelenti azt, hogy hadd nojon tovabb.

EXIT: 0 tiszta vagy csak ismert tullepes | 1 UJ vagy NOVEKVO tullepes | 2 a mero bukott
"""
import json, os, sys

SOR_KORLAT = int(os.environ.get("MERET_SOR_KORLAT") or 1200)
# A DEFAULT 60*1000, NEM 60*1024 (javitva 2026-10-05). A memoria-heartbeat SKILL.md 4-es
# iras-szabalya betuhiven ezt mondja: "FELSO KORLAT: 1200 sor / 60 kB, ES A SZUK KERESZTMETSZET
# A kB -- ami ITT 1000 BAJT, NEM 1024". Az or viszont 61440-nel allt, tehat 1440 bajttal LAZABBAN
# a dokumentalt korlatnal -- es pont abban a savban volt NEMA, ahol a szabaly cselekvest ir elo.
# Kimerve ugyanaznap: a fajl 59 990 bajt volt (10 bajt a dokumentalt korlat alatt), es az or
# "rendben"-t adott. A tevedes iranya a MEGNYUGTATO.
# A SZUKITES KOLTSEGE MERT ES NULLA: a 75 utemezett SKILL.md kozul EGY SEM esett a 60000-61440
# savba (a ket ismert tullepes 135 kB es 303 kB, azok allapotkent mar bent voltak).
# Aki MAS korlatot akar (pl. a memoria-lapokra 61440), az tovabbra is env-bol adja at.
BAJT_KORLAT = int(os.environ.get("MERET_BAJT_KORLAT") or 60 * 1000)
# A MINTA: 'nested' = <gyoker>/<dir>/SKILL.md (utemezett feladatok), 'flat' = <gyoker>/*.md
# (memoria-lapok). EGY implementacio, ket hatokor -- igy a bizonyitott "ismert tullepes =
# ALLAPOT, uj/novekvo = ESEMENY" logika nem masolodik, tehat nem is csuszhat szet.
MINTA = os.environ.get("MERET_MINTA") or "nested"
CIMKE = os.environ.get("MERET_CIMKE") or "utemezett SKILL.md-k"
# A GYOKER ES AZ ALAPVONAL KORNYEZETBOL IS ALLITHATO -- NEM kenyelmi kapcsolo:
# a POZITIV KONTROLL csak igy futtathato anelkul, hogy az ELES fat rontanank el.
GYOKER = os.environ.get("UTEMEZETT_GYOKER") or os.path.expanduser("~/.claude/scheduled-tasks")
ALAPVONAL = os.environ.get("UTEMEZETT_ALAPVONAL") or "store/utemezett-meret-alapvonal.json"
# a novekedesi turesse: ennyi bajtig nem uj esemeny egy mar ismert tullepes
TURES_BAJT = 2048


def mer():
    ki = {}
    for nev in sorted(os.listdir(GYOKER)):
        if MINTA == "flat":
            # a sajat mentes-masolataink es az INDEX nem lap: az indexnek SAJAT orszeme van
            # (napi, mert vagassal) -- ez az ag a LAPOKAT meri, es a hatokort kimondja.
            if not nev.endswith(".md") or ".ELOTTE" in nev or ".bak" in nev:
                continue
            if nev in ("MEMORY.md", "index-teljes-lapjegyzek.md"):
                continue
            p = os.path.join(GYOKER, nev)
        else:
            p = os.path.join(GYOKER, nev, "SKILL.md")
        if not os.path.isfile(p):
            continue
        with open(p, "rb") as fh:
            b = fh.read()
        ki[nev] = {"sor": b.count(b"\n"), "bajt": len(b)}
    return ki


def main():
    try:
        most = mer()
    except OSError as e:
        print(f"MERO BUKOTT: {e}")
        return 2
    if not most:
        # NULLA FAJL: nem "tiszta", hanem a mero nem latott semmit. A hatokor-nulla
        # megkulonbozhetetlen a tiszta nullatol, ezert ez BUKAS, nem zold.
        print(f"MERO BUKOTT: egyetlen mert fajl sem talalhato ({GYOKER}, minta={MINTA})")
        return 2

    alap = {}
    if os.path.exists(ALAPVONAL):
        try:
            alap = json.load(open(ALAPVONAL, encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(f"MERO BUKOTT: az alapvonal olvashatatlan ({e})")
            return 2

    ismert, uj, novekvo = [], [], []
    for nev, m in sorted(most.items()):
        tul = m["sor"] > SOR_KORLAT or m["bajt"] > BAJT_KORLAT
        if not tul:
            continue
        a = alap.get(nev)
        if a is None:
            uj.append((nev, m, None))
        elif m["bajt"] > a["bajt"] + TURES_BAJT or m["sor"] > a["sor"] + 50:
            novekvo.append((nev, m, a))
        else:
            ismert.append((nev, m, a))

    print(f"{CIMKE}: {len(most)} | korlat: {SOR_KORLAT} sor / {BAJT_KORLAT} bajt")
    for cim, lista in (("ISMERT TULLEPES (allapot)", ismert),
                       ("NOVEKVO TULLEPES (esemeny)", novekvo),
                       ("UJ TULLEPES (esemeny)", uj)):
        if not lista:
            continue
        print(f"  {cim}:")
        for nev, m, a in lista:
            reg = f"  (alapvonal {a['sor']} sor / {a['bajt']} bajt)" if a else ""
            print(f"    {nev}: {m['sor']} sor / {m['bajt']} bajt{reg}")
    if not (ismert or novekvo or uj):
        print("  minden fajl a korlat alatt")
    return 1 if (uj or novekvo) else 0


if __name__ == "__main__":
    sys.exit(main())
