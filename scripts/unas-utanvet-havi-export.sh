#!/usr/bin/env bash
# UNAS utanvetes rendelesek havi exportja szallitasi mod szerint, a Fama-egyeztetes bemenete.
#
# Hasznalat:  unas-utanvet-havi-export.sh [YYYY-MM]
#   argumentum nelkul az ELOZO honapot exportalja (a honap 1-jen futo utemezesnek ez a helyes).
#
# Forras: a legfrissebb helyi unas-dashboard mentes (backups/unas-dashboard/unas-*.db).
# A mentes 03:40-kor keszul, tehat a honap 1-jen mar tartalmazza a teljes elozo honapot.
#
# Ket dolog, ami nem nyilvanvalo, ezert itt all:
#  - az Order.orderDate INTEGER epoch ms; szoveggel osszehasonlitva NEMAN nullat ad.
#  - a tarolt pillanat a budapesti FALIORA, UTC-nek jelolve, tehat a honap-ablak
#    `datetime(orderDate/1000,'unixepoch')`, LOCALTIME NELKUL. (Lasd az
#    orderdate-faliora-utc-nek-jelolve memoria-lapot.)
set -euo pipefail

ROOT=/root/marveen/marveen/marveen/marveen
OUTDIR="$ROOT/agents/lucky/store/fama-2026"
HONAP="${1:-$(date -d '1 month ago' +%Y-%m)}"

DB=$(ls -1t "$ROOT"/backups/unas-dashboard/unas-*.db 2>/dev/null | head -1)
[ -n "$DB" ] || { echo "FAIL: nincs unas-dashboard mentes a backups/ alatt" >&2; exit 1; }

# A mentes FRISSESEGE: a darabszam-ellenorzes nem fogja meg azt az esetet, amikor a mentes
# regebbi, mint az exportalt honap vege -- olyankor a CSV nem ures, csak CSONKA, es a kapun
# atmegy. (Kimerve nem esetbol, hanem a kapu hatokorenek atgondolasabol, 2026-09-14.)
HONAP_VEGE=$(date -d "$HONAP-01 +1 month" +%s)
DB_KOR=$(stat -c %Y "$DB")
if [ "$DB_KOR" -lt "$HONAP_VEGE" ]; then
  echo "FAIL: a legfrissebb mentes ($(basename "$DB"), $(date -d "@$DB_KOR" '+%Y-%m-%d %H:%M')) REGEBBI, mint a(z) $HONAP vege -- az export csonka lenne. Nem irok fajlt." >&2
  exit 1
fi

mkdir -p "$OUTDIR"
OUT="$OUTDIR/unas-utanvet-$HONAP.csv"
# Ideiglenes fajlba irunk, es CSAK sikeres ellenorzes utan tesszuk a helyere.
# Kimerve 2026-09-14: bukas eseten egy 0 bajtos CSV maradt a helyen, amit a 8-ai
# fama-havi-egyeztetes "a honap exportjakent" olvasott volna -- nulla tetelnek.
TMP="$OUT.tmp.$$"
trap 'rm -f "$TMP"' EXIT

sqlite3 -header -csv "$DB" "
SELECT id AS order_id, numericId AS unas_szam,
  strftime('%Y-%m-%d %H:%M', datetime(orderDate/1000,'unixepoch')) AS rendeles_datuma,
  customerName AS vevo, shipCity AS varos, shipZip AS irsz,
  CAST(round(total) AS INTEGER) AS osszeg_brutto,
  CASE WHEN shippingName LIKE 'Trans-Sped%' THEN 'FAMA'
       WHEN shippingName LIKE 'GLS%' THEN 'GLS' ELSE 'EGYEB' END AS szallitas_csoport,
  shippingName AS szallitas_nyers, status AS statusz, statusType AS statusz_tipus,
  CASE WHEN statusType='close_ok' THEN '' ELSE 'KIVEZETENDO' END AS kivezetes
FROM 'Order'
WHERE paymentName LIKE 'Utánvét%'
  AND strftime('%Y-%m', datetime(orderDate/1000,'unixepoch'))='$HONAP'
ORDER BY orderDate" > "$TMP"

SOROK=$(( $(wc -l < "$TMP") - 1 ))
if [ "$SOROK" -lt 1 ]; then
  echo "FAIL: $HONAP -> 0 tetel, a korabbi export ERINTETLEN marad. DB=$DB" >&2
  exit 1
fi
mv "$TMP" "$OUT"
echo "OK $HONAP -> $SOROK tetel, $OUT (forras: $(basename "$DB"))"
