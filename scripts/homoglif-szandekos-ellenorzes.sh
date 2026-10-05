#!/usr/bin/env bash
# A `HOMOGLIF-PELDAK: SZANDEKOS` markert hordozo fajlok napi sweepje.
#
# 2026-09-24 ELOTT ez a script MAGA vegezte a deklaralt/tenyleges osszevetest (sajat
# `sed`-del), mikozben a `homoglif-ellenorzes.py` a markert FAJL-SZINTU felmentesnek
# vette. Ket kovetkezmenye volt, es a masodik a rosszabb:
#   1. KET IMPLEMENTACIO egy szabalyra -- pontosan az az alak, amitol ket forras
#      szetcsuszik, mert a javitas csak az egyikbe megy be.
#   2. A jelzes NAPONTA EGYSZER jott, holott a .py az IRAS UTANI kapu: aki patchelt
#      es lefuttatta a .py-t, "javitando: 0"-t latott egy UJ, veletlen homoglifara is.
# Az osszevetes ezert ATKERULT a .py-be (ott van a felmentes logikaja is), es ez a
# script mar csak KIVALASZTJA a markeres fajlokat es RAHIVJA a mérőt.
# Hasznalat: homoglif-szandekos-ellenorzes.sh <fajl> [<fajl> ...]
set -u
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
rossz=0; nezett=0
for f in "$@"; do
  grep -qx 'HOMOGLIF-PELDAK: SZANDEKOS' "$f" 2>/dev/null || continue
  nezett=$((nezett+1))
  ki=$(python3 "$here/homoglif-ellenorzes.py" "$f" 2>&1) || rossz=$((rossz+1))
  # A KARAKTER-SOR MINDEN FUTASBAN KIIRODIK, SIKERES KORBEN IS -- es ez NEM OR,
  # hanem ALLAPOT (2026-09-24). A darabszam-osszevetes a MENNYISEGET fogja meg; ha
  # valaki egy deklaralt peldat kivesz ES behoz egy veletlen homoglifat, a szam
  # valtozatlan marad. A FAJTA valtozasa a `.py` karakter-soran latszik -- de csak
  # annak, AKI EPP SZERKESZTETT es emlekszik az elozo allapotra. A NAPI SWEEP-nek
  # nincs ilyen emlekezete (safar pontositasa, 7650).
  # safar felvetette, hogy a `memoria-tukor.log` MAR tartalmazza az elozo napi
  # kimenetet, tehat az osszevetes ingyen allapotot kapna. MEGMERVE: NEM tartalmazta
  # -- a sweep sikeres korben CSAK az osszegzo sort irta. Ez a sor teszi igazza.
  # AMIT EZ NEM AD: semmi nem veti ossze a napokat. Ez allapot, nem vedelem.
  echo "$ki" | grep -E 'TOBBLET|ELAVULT|NINCS SZANDEKOS|karakterek:'
done
echo "markeres fajl: $nezett | elteres: $rossz"
[ "$rossz" -eq 0 ]
