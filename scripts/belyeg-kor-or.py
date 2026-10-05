#!/usr/bin/env python3
"""Futas-belyegek KORAT ellenorzi -- azt a kerdest, amit a belyeg LETEZESE nem valaszol meg.

MIERT: a `store/ledger-drain-wrapper.allapot`-ot 2026-09-30-ig EGYETLEN folyamat olvasta, az,
amelyik IRJA (`scripts/hooks/ledger-drain-wrapper.py`; `grep -rl` az utemezett fan es a
scripts/src alatt: egy talalat). A CLAUDE.md kimondja, hogy "a configbol csak az latszik, mit
ALLITOTTUNK be; hogy mi FUT, azt a belyeg mondja meg" -- ez viszont csak akkor all, ha valaki
RANEZ. Egy belyeg, ami napokig ugyanazt az idot mutatja, magatol nem lelet.
(michel elsokezu meresebol, 8397 nyugtaja: ugyanez az alak a hajnali jaraton, ahol a jarat
egyetlen kulso nyoma egy olyan bejegyzes volt, amit AZ AGENS ir.)

KILEPESI KOD, szandekosan harom allapot (nem ket):
  0 = tiszta        minden belyeg fiatalabb a sajat hataranal
  1 = A MERO VAK    a belyeg olvashato, de nem ertelmezheto -- errol NEM allitunk semmit
  2 = ELO TALALAT   hianyzo vagy elavult belyeg
Ami nem mert, oda `?` kerul a kimenetben, NEM 0.
"""
import json, os, sys, time, atexit

GYOKER = '/root/marveen/marveen/marveen/marveen'

# (belyeg-fajl, max_kor_masodperc, MERVADO_MEZO, indok)
#
# A MERVADO_MEZO NEM elhagyhato, es ez a masodik nekifutas eredmenye. Az elso valtozatban a kor
# ket forrasbol jott (`utolso_futas` mezo VAGY a fajl mtime-ja), es a frissebb dontott -- ezzel a
# `VAK` ag egy LETEZO fajlra SOHA nem tuzelhetett, mert az `os.stat` mindig ad mtime-ot. Vagyis a
# meroben volt egy ag, ami szerkezetileg nem futhat le: pontosan az az osztaly, amit ez az or
# keresni hivatott. (michel 8397-es nyugtaja, 1. pont: a belyegnek maganak nem lehet
# soha-nem-futo aga.)
#
# A SZETVALASZTAS: az mtime azt bizonyitja, hogy a fajlhoz HOZZAERTEK; a MERVADO_MEZO azt, hogy az
# IRO LEFUTOTT. A ketto nem ugyanaz, es az or az utobbira kerdez. Az mtime igy CORROBORACIO lett,
# nem forras: ha a ketto tobb mint egy kadenciara elter, azt kiirjuk, de a verdikt a mezo alapjan all.
# MERVADO_MEZO=None olyan belyegre valo, aminek NINCS ilyen mezoje -- akkor az mtime a forras,
# es ezt a sor KIMONDJA, nem hallgatolagosan teszi.
BELYEGEK = [
    (
        'store/ledger-drain-wrapper.allapot',
        3600,
        'utolso_futas',
        'a drain `*/2` cronnal fut, tehat 2 percenkent ir; 1 ora = 30x kadencia, '
        'ezert egy elavulas itt nem ingadozas, hanem leallas',
    ),
]

_kod = {'ertek': 1, 'ok': 'a szkript a verdikt ELOTT allt le'}


@atexit.register
def _zaro():
    # A BELYEGNEK MAGANAK NEM LEHET SOHA-NEM-FUTO AGA: ez `atexit`, tehat korai
    # sys.exit() es nem kezelt kivetel utan is kiirja a verdiktet.
    print(f"VERDIKT kod={_kod['ertek']} ({_kod['ok']})")


def kor_masodpercben(ut, mervado_mezo):
    """Visszaad (kor_mp, forras, mtime_kor_mp) harmast, vagy (None, indok, mtime) ha nem merheto.

    A MERVADO_MEZO a forras; az mtime csak corroboracio (lasd a BELYEGEK kommentjet)."""
    most = time.time()
    mtime_kor = most - os.stat(ut).st_mtime
    if mervado_mezo is None:
        return mtime_kor, 'mtime (a belyegnek nincs mezoje -- KIMONDVA)', mtime_kor
    try:
        d = json.load(open(ut, encoding='utf-8'))
    except Exception as e:
        return None, f'a JSON nem olvashato: {e!r}', mtime_kor
    s = d.get(mervado_mezo)
    if not isinstance(s, str):
        return None, f'a `{mervado_mezo}` mezo hianyzik vagy nem szoveg: {s!r}', mtime_kor
    try:
        t0 = time.mktime(time.strptime(s.strip(), '%Y-%m-%d %H:%M:%S'))
    except Exception as e:
        return None, f'a `{mervado_mezo}` nem ertelmezheto idopont ({s!r}): {e!r}', mtime_kor
    return most - t0, f'`{mervado_mezo}`', mtime_kor


def main():
    vizsgalt = 0
    talalat = 0
    vak = 0
    for rel, hatar, mervado, indok in BELYEGEK:
        ut = os.path.join(GYOKER, rel)
        vizsgalt += 1
        if not os.path.exists(ut):
            print(f"TALALAT  {rel}: A BELYEG NEM LETEZIK -- kor=? "
                  f"(egy nem letezo belyeg ugyanugy nez ki, mint a 'nem futott')")
            talalat += 1
            continue
        kor, forras, mtime_kor = kor_masodpercben(ut, mervado)
        if kor is None:
            print(f"VAK      {rel}: a belyeg letezik, de az IRO futasa nem igazolhato -- kor=? "
                  f"({forras}); mtime kora {mtime_kor/60:.1f}p, de az csak azt mondja, hogy a "
                  f"fajlhoz hozzaertek, nem azt, hogy az iro lefutott")
            vak += 1
            continue
        cimke = 'TALALAT ' if kor > hatar else 'tiszta  '
        if kor > hatar:
            talalat += 1
        print(f"{cimke} {rel}: kor={kor/60:.1f}p forras={forras} hatar={hatar/60:.0f}p")
        # Corroboracio: ha az mtime es a mezo tobb mint egy kadenciara elter, az KULON jel
        # (pl. valaki hozzaert a fajlhoz anelkul, hogy az iro lefutott volna).
        if abs(kor - mtime_kor) > 300:
            print(f"         MEGJEGYZES: az mtime kora {mtime_kor/60:.1f}p, a mezo szerinti "
                  f"{kor/60:.1f}p -- {abs(kor-mtime_kor)/60:.1f}p elteres, ez NEM a verdikt "
                  f"alapja, de erdemes ranezni")
        if kor > hatar:
            print(f"         INDOK: {indok}")

    # NEVEZO: fail-closed. Egy nulla nevezoju proba LELETE 0 -- es az itt nem eredmeny.
    if vizsgalt == 0:
        _kod.update(ertek=1, ok='NEVEZO NULLA: a proba nem latott bemenetet')
        print("VAK: nulla belyeget vizsgaltam -- a 0 talalat itt NEM eredmeny")
        sys.exit(1)

    print(f"OSSZEGZES: vizsgalt {vizsgalt} | talalat {talalat} | vak {vak}")
    if talalat:
        _kod.update(ertek=2, ok=f'{talalat} elo talalat')
        sys.exit(2)
    if vak:
        _kod.update(ertek=1, ok=f'{vak} belyeg nem volt merheto')
        sys.exit(1)
    _kod.update(ertek=0, ok='minden belyeg a hataron belul')
    sys.exit(0)


if __name__ == '__main__':
    main()
