#!/usr/bin/env python3
"""Homoglif-ellenorzes FAJLOKRA -- a helper-kapuval AZONOS logikaval.

MIERT LETEZIK (2026-09-12, Zsolt jovahagyasa; a Dream Engine 09-12-i javaslata):
a kimeno uton 2026-09-02 ota all a kapu (`outgoing-copy-gate.py`), de az a
KULDEST vedi. A SKILL.md es a memoria-lap FAJLBA irodik, oda egyik helper sem
er el -- ezert az ellenorzes lepese eddig UTASITASKENT allt ot utemezett feladat
szovegeben, es abbol NEGYBEN egyaltalan nem szerepelt. Egy leirt szabaly, amit
koronkent kezzel kell ujragepelni, elobb-utobb kimarad; egy hivhato szkript nem.

MIERT NEM SAJAT REGEX (es ez a lenyegi valtozas):
a korokben kezzel gepelt minta `[Ѐ-ӿ]` volt, ami CSAK cirill. A kapu ezzel
szemben VEGYES IRASRENDSZERU SZOT keres (egy szon belul latin ES nem-latin),
tehat a gorog homoglifakat (pl. omikron, U+03BF) is elkapja, es nem bukik el egy
szandekosan idegen nyelvu, TISZTA nem-latin idezeten. Ez a szkript a kapu sajat
`mixed_script_words()` fuggvenyet importalja -- egy implementacio, ket fogyaszto.

SZANDEKOS PELDAK: ha egy fajl MAGA a homoglifakrol szol, a talalatok ott
dokumentalt peldak. Ilyenkor a fajl tartalmazzon egy sort:
    HOMOGLIF-PELDAK: SZANDEKOS
Ekkor a talalatok KIIRODNAK, de a kilepesi kod 0. A felmentes igy a FAJLLAL
utazik, nem egy parancssori flaggel -- kulonben a kovetkezo hivo nem tudja rola.

A MARKERNEK EGYEDUL KELL ALLNIA A SORAN (`ln.strip() == MARKER`), ES EZ NEM
SZIGORITASI OTLET, HANEM EGY MERT HIBA JAVITASA (2026-09-13 02:2x). Az elso
valtozat `MARKER in ln`-t hasznalt, tehat a marker AKKOR IS felmentette a fajlt,
ha a szoveg csak EMLITETTE -- pl. egy skill, ami a szabalyt dokumentalja. Merve:
16 fajl hordozta a markert, es kozuluk OT olyan utemezett-feladat SKILL.md volt,
amelyik egyetlen prozai sorban, backtickek kozt idezi. Mind az ot NULLA talalatos,
tehat a felmentes ma semmit nem takart -- de minden JOVOBELI sorukat atengedte
volna, es epp ezt az ot fajlt patcheljuk a leggyakrabban. Negativ kontroll aznap:
egy szandekosan beszurt U+0435 a `dream-engine/SKILL.md` masolataban EXIT=0-t
adott. A hasznalat es az EMLITES kozott a szkript nem tudott kulonbseget tenni;
a sor-szintu egyenloseg tud, es a negy VALODI felmentes (memoria-lapok) mind
magaban allo sorban hordozza, tehat a javitas egyiket sem erinti.

HASZNALAT
    python3 scripts/homoglif-ellenorzes.py <fajl> [<fajl> ...]
    exit 0 = tiszta (vagy szandekos peldak)
    exit 1 = talalat, amit javitani kell
    exit 2 = hasznalati/olvasasi hiba (NEM tiszta -- fail-closed)
"""
import importlib.util
import os
import sys

MARKER = "HOMOGLIF-PELDAK: SZANDEKOS"
_HERE = os.path.dirname(os.path.abspath(__file__))
_GATE = os.path.join(_HERE, "hooks", "outgoing-copy-gate.py")


def _load_gate():
    """Import the live gate module by path (the filename has a dash)."""
    spec = importlib.util.spec_from_file_location("outgoing_copy_gate", _GATE)
    if spec is None or spec.loader is None:
        raise ImportError(_GATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def check(path, mixed_script_words):
    """Return (talalat_count, szandekos: bool). Prints per-line findings."""
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    szandekos = any(ln.strip() == MARKER for ln in lines)
    n = 0
    for i, ln in enumerate(lines, 1):
        for word, _bad, bad_desc in mixed_script_words(ln):
            n += 1
            print("  %s:%d  %s  <- %s" % (path, i, word, bad_desc))
    return n, szandekos


def main(argv):
    if not argv:
        print(__doc__.strip().splitlines()[0])
        print("hasznalat: python3 scripts/homoglif-ellenorzes.py <fajl> [<fajl> ...]")
        return 2
    try:
        gate = _load_gate()
        mixed_script_words = gate.mixed_script_words
    except Exception as exc:  # fail-closed: a nema atengedes a rosszabb ag
        print("HIBA: a kapu-modul nem importalhato (%s): %s" % (_GATE, exc))
        return 2

    osszes = 0
    rossz = 0
    for path in argv:
        try:
            n, szandekos = check(path, mixed_script_words)
        except OSError as exc:
            print("HIBA: %s nem olvashato: %s" % (path, exc))
            return 2
        osszes += n
        if n and szandekos:
            print("  %s: %d talalat, de a fajl SZANDEKOS PELDAKAT jelol -- nem hiba" % (path, n))
        elif n:
            rossz += n
        else:
            print("  %s: tiszta" % path)

    print("OSSZEGZES: %d talalat, ebbol javitando: %d" % (osszes, rossz))
    return 1 if rossz else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
