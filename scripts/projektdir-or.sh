#!/bin/bash
# projektdir-or.sh -- MARADANDO proxy arra, hogy futott-e peldany VARATLAN konfiggal.
#
# MIERT LETEZIK: a `/proc/<pid>/environ`-alapu konfig-ellenorzes PILLANATFELVETEL. Egy peldany,
# ami ket ellenorzes KOZOTT indul es all le, nyomtalan marad (merve 2026-09-29: a channels-folyamat
# 03:32 -> 09:28 kozott ujraindult, ~18 ora vak ablak). Minden claude-peldany viszont a MUNKA-
# KONYVTARABOL kepzett `projects/<slug>/` konyvtarba ir, es az a konyvtar TULELI a folyamatot.
# Tehat: varatlan konfig -> varatlan slug -> MARADANDO nyom.
#
# EZ NEM HELYETTESITI a konfig-ut ellenorzest, mert a ket ag MAST mer (lasd a FORDITOTT agat).
#
# A gep-specifikus lista a store/projektdir-or.json-ban van, NEM itt: a marveen repo PUBLIKUS,
# es a store/ gitignore-olt. Ez a fajl csak a MECHANIZMUST tartalmazza.
#
# Kilepesi kod: 0 = tiszta | 1 = a mero nem lat (pozitiv kontroll bukott) | 2 = varatlan talalat
set -u
GYOKER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# FUTAS-BELYEG -- MERT A NEM FUTO PROBA UGYANUGY NEZ KI, MINT A TISZTA (2026-09-30, a boss
# `ledger-live-drain` esete nyoman: ott ket hetig egyetlen sor sem keletkezett, es ez nem dontesbol
# kovetkezett, hanem abbol, hogy senki nem merte meg). A hajnali jarat eddigi EGYETLEN nyoma a napi
# naplo volt -- azt viszont AZ AGENS irja, ugyanaz, akinek a kimaradasat ki akarjuk szurni: ha a
# jarat nem tuzel, a nyom a jelenseggel EGYUTT tunik el. A belyeg azt irja, amit a MUVELET tud.
# A `kod` a "legutolso allapot FAJTAJA" jel: 0=tiszta, 1=a mero nem lat, 2=varatlan talalat.
# A trap MAR ITT all, nem a fajl vegen: kulonben a ket korai `exit 1` (nincs config / nulla
# konyvtar) nem hagyna belyeget -- vagyis a belyegnek MAGANAK lenne soha-nem-futo aga, es epp a
# vak agon. Minden mezo MERT ertekbol jon; ahol nincs meres, `?` all, nem 0.
belyeg_ir() {
  local k="$1" b f=1
  # A TESZT-FELISMERES KET TAGU (2026-10-02, a boss msg 8517 es a sajat ket napos hibam nyoman):
  # a kapcsolo VEDELEMKENT ket nap alatt ketszer nem futott le, es a masodik eset megmutatta, hogy
  # a kar nem a futas-szam, hanem a TARTALOM: egy masolat-registryvel futo kontroll az ELO belyegbe
  # irt szintetikus erteket, friss idoponttal es `kod=0`-val, tehat hitelesen.
  # A kriterium az ATADOTT REGISTRY AZONOSSAGA (nem az argumentum LETE: az elo registryt explicit
  # atado futas, es a scheduler argumentumos hivasa is teszt-belyeget kapna), VAGY a SZKRIPT
  # azonossaga (a mutacio-teszteket a szkript masolatan, ELO registryvel futtatom).
  # NEM FOGJA MEG: elo szkript + elo registry + ALTALAM perturbalt bemenet (pl. egy szandekosan
  # inditott folyamat a /proc-ban). Az ilyen belyeg nem hamis, csak nem reprezentativ -- arra a
  # kapcsolo marad, FELULIRASKENT.
  local elo_reg="/root/marveen/marveen/marveen/marveen/store/projektdir-or.json"
  local elo_szk="/root/marveen/marveen/marveen/marveen/scripts/projektdir-or.sh"
  local mas_reg=0 mas_szk=0 ok=""
  [ "$(readlink -f "$CFG")" != "$(readlink -f "$elo_reg")" ] && { mas_reg=1; ok="reg"; }
  [ "$(readlink -f "${BASH_SOURCE[0]}")" != "$(readlink -f "$elo_szk")" ] && { mas_szk=1; ok="${ok}szkript"; }
  b="/root/marveen/marveen/marveen/marveen/store/michel-orjarat-belyeg-projektdir"
  if [ "$mas_reg" = 1 ] || [ "$mas_szk" = 1 ]; then b="$b.teszt"
  elif [ "${MICHEL_BELYEG_TESZT:-}" = "1" ]; then b="$b.teszt"; ok="env"
  fi
  b="$b.txt"
  if [ -r "$b" ]; then
    f=$(sed -n 's/.*futas=\([0-9]*\).*/\1/p' "$b"); f=$(( ${f:-0} + 1 ))
  fi
  printf 'proba=projektdir-or  ido=%s  futas=%s  kod=%s  jel=dir=%s:varatlan=%s:fordit_talalat=%s%s\n' \
    "$(date -Iseconds)" "$f" "$k" "${osszes:-?}" "${varatlan:-?}" "${talalt:-?}" \
    "${ok:+  teszt_ok=$ok}" > "$b" 2>/dev/null || true
}
trap 'belyeg_ir "${rc:-1}"' EXIT
CFG="${1:-$GYOKER/store/projektdir-or.json}"
[ -r "$CFG" ] || { echo "FAIL: nincs config: $CFG"; exit 1; }

P=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['projects_gyoker'])" "$CFG")
ISMERT=$(python3 -c "import json,sys;print('\n'.join(json.load(open(sys.argv[1]))['ismert']))" "$CFG")
KIVETEL=$(python3 -c "import json,sys;print('\n'.join(json.load(open(sys.argv[1]))['kivetel']))" "$CFG")

# POZITIV KONTROLL: ha nulla konyvtarat latunk, nem a fa ures, hanem a mero nem lat.
osszes=$(ls -1d "$P"/*/ 2>/dev/null | wc -l)
echo "POZITIV KONTROLL -- projekt-konyvtar: $osszes"
[ "$osszes" -eq 0 ] && { echo "!!! A MERO NEM LAT (rossz ut vagy jogosultsag) -- a nulla NEM allitas"; exit 1; }

rc=0
varatlan=0
echo "--- VARATLAN konyvtar:"
for d in "$P"/*/; do
  s=$(basename "$d")
  # A `--` KOTELEZO: a slug `-`-szal kezdodik, e nelkul a grep KAPCSOLOKENT olvassa.
  # (Merve 2026-09-29: `grep -qx "$s"` MINDEN konyvtarat varatlannak jelentett, 8 hamis riasztas.
  #  Hangos hiba volt, tehat olcso -- de a forditott illeszkedes CSENDBEN mindig "tisztat" mondana.)
  printf '%s\n' "$ISMERT" | grep -qxF -- "$s" && continue
  if printf '%s\n' "$KIVETEL" | grep -qxF -- "$s"; then
    n=$(find -L "$d" -type f 2>/dev/null | wc -l)
    a=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['kivetel'][sys.argv[2]].get('alapvonal_fajlszam','?'))" "$CFG" "$s")
    if [ "$a" != "?" ] && [ "$n" -gt "$a" ]; then
      echo "    *** KIVETEL NOTT: $s  fajl=$n (alapvonal $a) -- ESEMENY ***"; rc=2; varatlan=$((varatlan+1))
    else
      echo "    kivetel: $s  fajl=$n (alapvonal $a)"
    fi
    continue
  fi
  echo "    *** VARATLAN: $s ***"; rc=2; varatlan=$((varatlan+1))
done

# FORDITOTT AG: elo peldany, aminek nincs projekt-konyvtara. KET OKA lehet, es csak az egyik baj:
#   (a) MASHOVA ir  -> a proxy vak ra: ESEMENY
#   (b) meg nem irt -> nincs mit latni: allapot
# A diszkriminator a CLAUDE_CONFIG_DIR alatti `projects`: ha szimlink a kozos fara, akkor (b).
echo "--- FORDITOTT AG (elo peldany projekt-konyvtar nelkul):"
talalt=0
for p in /proc/[0-9]*; do
  pid=${p#/proc/}; [ -r "$p/cmdline" ] || continue
  # AZ ILLESZTES HELYE DONT, NEM A MINTA FINOMSAGA. A TELJES cmdline-ra illesztve a tmux INDITO is
  # bejon, mert az ARGUMENTUMAI tartalmazzak a claude-hivast -- es az inditonak NINCS
  # CLAUDE_CONFIG_DIR-je (merve: /proc/7528/environ -> 0 sor), tehat az alabbi diszkriminator az
  # (a) agra viszi: HANGOS HAMIS ESEMENY, rc=2. argv[0]-ra illesztve az egesz osztaly megszunik.
  # (michel merte ki 2026-10-01 a sajat szuroján; itt KONTROLLAL visszamerve ugyanaznap: egy
  #  /usr/bin/tail folyamat, aminek a cmdline-ja a claude utjara vegzodik, "(a) ESEMENY"-t adott.)
  a0=$(tr '\0' '\n' < "$p/cmdline" 2>/dev/null | head -1)
  case "$a0" in */claude|claude) ;; *) continue;; esac
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue
  slug=$(printf '%s' "$cwd" | sed 's#[/.]#-#g')      # a PONT is kotojelre valt, nem csak a `/`
  [ -d "$P/$slug" ] && continue
  talalt=1
  ccd=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep '^CLAUDE_CONFIG_DIR=' | cut -d= -f2-)
  if [ -L "$ccd/projects" ] && [ "$(readlink -f "$ccd/projects")" = "$P" ]; then
    echo "    (b) pid $pid  cwd=$cwd  -- a projects szimlink a kozosre, meg nem irt: ALLAPOT"
  else
    echo "    *** (a) pid $pid  cwd=$cwd  ccd=$ccd -- KULON faba ir: ESEMENY ***"; rc=2; varatlan=$((varatlan+1))
  fi
done
[ "$talalt" -eq 0 ] && echo "    nincs ilyen"
exit $rc
