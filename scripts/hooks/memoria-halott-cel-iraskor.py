#!/usr/bin/env python3
"""Iras-idoben jelzi, ha egy memoria-lapba HALOTT [[...]] hivatkozas VAGY CIRILL HOMOGLIF kerult.

A NEV SZUKEBB, MINT AMIT A HOOK TESZ -- ezert all itt: 2026-09-25-tol a homoglif-ellenorzes is
benne van. Azert EBBEN a hookban es nem egy masodikban, mert a bekotes mar merve van (harom
valodi Write-tal), es egy masodik hook ugyanarra a Write-ra ujra futna a kritikus uton.
MIERT KELL: a cirill-halo megvan az `agent-msg.sh`-ban, az `agent-msg-close.sh`-ban ES a
`dash-api.sh`-ban -- tehat az uzenetek, nyugtak, kartya-kommentek es napi naplok vedettek.
A memoria-LAPOK voltak az egyetlen nem vedett csatorna, es epp azok toltodnek be minden sessionbe.

MIERT IRAS-IDOBEN, ES NEM A NAPI KORBEN: a `halott-celpont.py` a skill zaro-lepese, es
2026-09-25-en KET agensnel maradt ki ugyanazon a napon, kulon-kulon. Nem figyelmi kerdes:
kulon parancs, tehat kihagyhato. Az index-orhoz kotve a szam a naploba kerult volna olvaso
nelkul, es 6 orat kesne -- a hiba viszont az IRAS pillanataban keletkezik.

AMIT EZ NEM OLD MEG (kimondva, hogy ne varjunk tole tobbet): a jelzes HELYET javitja, nem azt,
hogy elolvassak. Ugyanaz a hatar, mint a `dash-api.sh` WARN-janal -- de szigoruan jobb, mert a
kimenet kulon blokkent all, nem egy hosszu parancs-kimenet vegen.

NEM BLOKKOL, DE NEM IS HALLGAT: talalatnal exit 1, egyebkent 0.
**MIERT NEM exit 0 A TALALATNAL (kimerve 2026-09-25, ugyanezen a napon, MASODSZOR):** reggel a
kuldes-lezaras kapunal megmertem, hogy egy exit 0-val zaro hook kimenete NEM jut el az agenshez --
es este pontosan ezt a hibat epitettem bele ebbe a hookba. Az elso eles proba (egy valodi Write egy
halott linkkel) NULLA kimenetet adott: a hook lefutott, a jelzes nem latszott. A `1` nem blokkol
(2026-09-25-i meres: PreToolUse-on az 1 atenged, a 2 blokkol), de a szoveg megerkezik.
Plusz egy DURABLE nyom a naploba, hogy a jelzes akkor is visszakereshoto legyen, ha epp nem olvasom.

A HAROM KILEPESI KOD MERT VISELKEDESE EZEN A HOOK-TIPUSON (PostToolUse, 2026-09-25, harom VALODI
Write-tal merve -- nem feltevesbol, mert a reggeli meresem PreToolUse-ra szolt es atvittem ide):
    exit 0            -> a kimenet NEM jut el az agenshez (a naplobol derult ki, hogy lefutott)
    exit 1            -> UGYANUGY NEM jut el
    STDERR + exit 2   -> ELJUT, es a Write KOZBEN LEFUT (a fajl frissult)
A keret a harmadikat "PostToolUse hook blocking error"-nak cimkezi. **A cimke felrevezeto: a Write
MEGTORTENT** -- PostToolUse-on a muvelet mar lezajlott, tehat nincs mit blokkolni. Aki a cimket
olvassa, azt hiheti, hogy az iras elbukott.
"""
import io, json, os, re, sys

MEMDIR = "/root/.claude/projects/-root-marveen-marveen-marveen-marveen/memory"

def main() -> int:
    try:
        d = json.load(sys.stdin)
    except Exception:
        return 0
    p = ((d.get("tool_input") or {}).get("file_path") or "").strip()
    if not p:
        return 0
    # KET TENGELYU UT-SZURES (a boss 2. pontja): a ".md a memoria-konyvtaron KIVUL" es a
    # "nem .md a konyvtaron BELUL" KET kulonbozo ag, es a szuro mindkettot kulon rontja el.
    try:
        val = os.path.realpath(p)
    except Exception:
        return 0
    if os.path.dirname(val) != MEMDIR:      # 1. tengely: hely
        return 0
    if not val.endswith(".md"):             # 2. tengely: kiterjesztes
        return 0
    try:
        t = io.open(val, encoding="utf-8").read()
        lapok = {f[:-3] for f in os.listdir(MEMDIR) if f.endswith(".md")}
    except OSError:
        return 0

    # A BACKTICK-SZURO A `halott-celpont.py`-BOL MASOLVA, NEM UJRAGEPELVE. Ez az, ami a
    # SZINTAXIS-idezetet (`[[...]]`) elvalasztja a valodi hivatkozastol -- 2026-09-25-en epp
    # ennek a hianya miatt jelentettem egy nem letezo hibat a sajat ad-hoc szamlalommal.
    # HOMOGLIF-ELLENORZES. A kod-blokkban vagy backtickben allo cirill karakter IDEZET: a tarban
    # ma HET lap tartalmaz cirillt, es MIND a hetben SZANDEKOS -- epp azok a lapok, amik a
    # homoglif-problemat dokumentaljak. A kod/backtick szuro hatot elvag; a hetedikre (prozaban
    # idezett karakter) a lap `homoglif-peldak: szandekos` sort tehet a frontmatterbe.
    # A JELOLO CSAK A FRONTMATTERBEN ERVENYES (kimerve 2026-09-25, a sajat elso valtozatomon):
    # ha barhol a szovegben keresem, akkor a jelolo EMLITESE is mentesit -- es pont az a lap emliti,
    # amelyik a homoglif-problemat dokumentalja. A rossz hatokor igy a legrosszabb helyen nyit.
    fm = ""
    if t.startswith("---"):
        v = t.find("\n---", 3)
        if v > 0:
            fm = t[3:v].lower()
    homoglif = []
    if "homoglif-peldak: szandekos" not in fm:
        tiszta = re.sub(r"```.*?```", "", t, flags=re.S)
        tiszta = re.sub(r"`[^`\n]*`", "", tiszta)
        for ch in tiszta:
            if 0x400 <= ord(ch) <= 0x4FF:
                homoglif.append(ch)

    halott = []
    for m in re.finditer(r"\[\[([^\]]+)\]\]", t):
        n = m.group(1).strip()
        elotte = t[m.start() - 1] if m.start() > 0 else ""
        utana = t[m.end()] if m.end() < len(t) else ""
        if elotte == "`" and utana == "`":
            continue
        if n and n not in lapok:
            halott.append(n)

    if halott or homoglif:
        ki = sys.stderr                      # STDERR: PostToolUse-on ez jut el a modellhez
        nev = os.path.basename(val)
        try:
            import time
            with io.open("/root/marveen/marveen/marveen/marveen/store/memoria-halott-cel-iraskor.log",
                         "a", encoding="utf-8") as f:
                f.write("%s | %s | halott=%s | homoglif=%d\n" % (
                    time.strftime("%Y-%m-%d %H:%M:%S"), nev,
                    ", ".join(sorted(set(halott))) or "-", len(homoglif)))
        except OSError:
            pass
        if halott:
            print(f"[MEMORIA HALOTT CEL] {nev}: {len(halott)} hivatkozasnak nincs lapja.", file=ki)
            for n in sorted(set(halott)):
                print(f"    [[{n}]]", file=ki)
            print("  Ha SKILL-re hivatkozol, a neve prozaban menjen, ne lap-hivatkozaskent.", file=ki)
            print("  Ha a SZINTAXIST idezed, tedd backtickbe -- akkor ez a jelzes hallgat.", file=ki)
            print("  Ha a lap meg nem letezik, ez nem hiba: a horgony jelzi, hogy meg megirando.", file=ki)
        if homoglif:
            egyedi = sorted(set(homoglif))
            print(f"[MEMORIA HOMOGLIF] {nev}: {len(homoglif)} cirill karakter kod-blokkon KIVUL.", file=ki)
            print("    " + " ".join(f"U+{ord(c):04X}({c})" for c in egyedi[:8]), file=ki)
            print("  Ez grep-pel nem lesz megtalalhato. Ha SZANDEKOS pelda, tedd backtickbe,", file=ki)
            print("  vagy a FRONTMATTERBE: homoglif-peldak: szandekos (a szovegben allo emlites NEM ment fel).", file=ki)
        return 2          # STDERR + 2: a Write MAR megtortent, tehat nem vonja vissza
    return 0

if __name__ == "__main__":
    sys.exit(main())
