#!/usr/bin/env bash
# frissites-eloproba.sh -- WILL the Wednesday 04:00 auto-update succeed?
#
# WHY THIS EXISTS (Zsolt kerese, 2026-10-04, Telegram 4446): az auto-update eddig UTOLAG
# derult ki, hogy elbukott -- a `store/update.last-result` csak a futas UTAN beszel, es a
# korai kilepesi agon ertesitest sem kuld. Ez a proba ELORE nez: szerda 18:00-kor a KOVETKEZO
# szerdai futasra, 6 nap 10 ora felkeszulesi idovel.
#
# AMIT MER: ugyanaz, amit az `update.sh` mer (a 333. sora `@{u}..HEAD`, a 343. `--ff-only`),
# PLUSZ a kornyezete (engedelyezve van-e, elerheto-e a tavoli). A fetch READ-ONLY; se pull,
# se checkout, se iras a fahoz.
#
# A BELYEG MINDEN FUTASBAN IRODIK, egy fajlba (nem novekvo naplo). Indok: `type: command`
# agon egy ures kor nulla nyomot hagy, es onnantol egy mukodo or megkulonbozhetetlen egy
# halottol. A configbol csak az latszik, mit ALLITOTTUNK be; hogy mi FUT, azt a belyeg mondja.
#
# TESZTELHETOSEG: az `ELOPROBA_AHEAD_OVERRIDE` env-valtozo felulirja a mert ahead-szamot.
# Kizarolag a NEGATIV KONTROLLHOZ van: enelkul a zold allitas semmit nem bizonyit.
set -uo pipefail
GYOKER='/root/marveen/marveen/marveen/marveen'
BELYEG="$GYOKER/store/frissites-eloproba.allapot"
cd "$GYOKER" || exit 1

HIBA=(); MOST="$(date '+%Y-%m-%d %H:%M:%S')"

AUE="$(grep '^AUTO_UPDATE_ENABLED=' "$GYOKER/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r"')"
[ "$AUE" = "1" ] || HIBA+=("AUTO_UPDATE_ENABLED nem 1 (erteke: '${AUE:-<nincs>}')")

AG="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ -n "$AG" ] || HIBA+=("nem sikerult kiolvasni az aktualis agat")

if ! timeout 60 git ls-remote --exit-code origin "refs/heads/$AG" >/dev/null 2>&1; then
  HIBA+=("az origin/$AG nem elerheto vagy nem letezik (az update.sh pull-ja ezen bukik)")
else
  timeout 90 git fetch --quiet origin "$AG" 2>/dev/null || HIBA+=("a git fetch origin $AG nem futott le")
fi

ELORE="$(git rev-list --count "@{u}..HEAD" 2>/dev/null || echo '?')"
[ -n "${ELOPROBA_AHEAD_OVERRIDE:-}" ] && ELORE="$ELOPROBA_AHEAD_OVERRIDE"
if [ "$ELORE" = '?' ]; then
  HIBA+=("az @{u}..HEAD nem merheto (nincs upstream?)")
elif [ "$ELORE" != "0" ]; then
  HIBA+=("a helyi checkout $ELORE committal ELORE jar -- a --ff-only pull EL FOG BUKNI. Nezd: git log @{u}..HEAD")
fi

ALLAPOT=ok; [ ${#HIBA[@]} -gt 0 ] && ALLAPOT=HIBA
SZAM=0; [ -f "$BELYEG" ] && SZAM="$(sed -n 's/.*"futasok": *\([0-9]*\).*/\1/p' "$BELYEG" | head -1)"
SZAM=$(( ${SZAM:-0} + 1 ))
printf '{\n "utolso_futas": "%s",\n "futasok": %s,\n "utolso_allapot": "%s",\n "elore_commit": "%s",\n "hibak": %s\n}\n' \
  "$MOST" "$SZAM" "$ALLAPOT" "$ELORE" "${#HIBA[@]}" > "$BELYEG"

if [ ${#HIBA[@]} -gt 0 ]; then
  { echo "[FRISSITES-ELOPROBA] A KOVETKEZO SZERDAI AUTO-UPDATE ELBUKIK, HA IGY MARAD."
    echo
    echo "A proba $MOST-kor futott, es ${#HIBA[@]} akadalyt talalt:"
    for h in "${HIBA[@]}"; do echo "  - $h"; done
    echo
    echo "A felkeszulesi ido a kovetkezo szerda 04:00-ig tart, tehat most meg javithato."
    echo "A belyeg: $BELYEG"
  } | bash "$GYOKER/scripts/agent-msg.sh" boss boss - >/dev/null 2>&1
  echo "HIBA: ${#HIBA[@]} akadaly -- reszletek a belyegben es az uzenetben"
  exit 1
fi
echo "ok: a kovetkezo szerdai auto-update elofeltetelei allnak (elore: $ELORE commit)"
exit 0
