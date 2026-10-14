#!/usr/bin/env python3
"""PreToolUse (Bash): refuse a call that contains BOTH agent-msg.sh and agent-msg-close.sh.

Why this is a gate and not a rule: the rule ("the send and the closing receipt that cites its
id are two separate commands") has been written four times in four shapes since 2026-09-22, the
last one deliberately unconditional -- and it was broken within 24 hours, by its own authors.
Every one of those four acted on KNOWLEDGE; the enforcement stayed a judgement call at the moment
of writing. Measured pressure: 155 outgoing messages in one day makes batching the default motion.
Full case: memory page `bejelentett-nem-elvegzett`, closing section (2026-09-23).

Heredoc bodies are stripped before matching. A message that DOCUMENTS this rule necessarily names
both helpers, and blocking it would be the same use-vs-mention blindness the homoglyph marker hit
on 2026-09-13.
"""
import json
import os
import re
import sys
import time

# PARANCS-POZICIOBAN allo helper-hivas, nem puszta elofordulas (marci merese, 2026-09-23:
# a puszta elofordulas 6/9 esetet tevedett; parancs-pozicioval 1/9; a heredoc-javitassal egyutt 0/9).
# Amit ez CSERBEN HAGY, es ki van mondva: valtozobol indirekt hivas (`$SEND boss x -`) es
# `xargs`/`eval` mogotti hivas. Ezek ma nem fordulnak elo nalunk, de a kapu NEM latja oket.
_ELOTAG = (r"(?:^|[|;&]|\bthen\b|\bdo\b|\(|`|\$\()\s*"
           # ENV-ERTEKADAS ELOTAGKENT (michel merte ki elesben, 2026-09-23): enelkul a negyedik
           # oszlop DOKUMENTALT hasznalata (`KULDES_LEZARAS_KAPU_PROBA=1 bash ...`) kikapcsolta a
           # kaput -- aki szabalyosan jelolte a probajat, az nem `kontroll` sort kapott, hanem
           # semmilyet. Es tagabban: barmely `VAR=ertek` kezdetu sor csendben atment.
           # A hamis-pozitiv irany zarva marad: `FOO=bar echo agent-msg.sh` NEM tuzel, mert az
           # `\S*` ut-elotag, nem kulon szo -- szokoz nem fer bele.
           r"(?:\w+=\S*\s+)*"
           r"(?:(?:bash|sh|exec|env|time|sudo)\s+)*"
           r"['\"]?\S*")            # az idezojel a shell-ben AJANLOTT, tehat napi alak (marci)
KULDES = re.compile(_ELOTAG + r"agent-msg\.sh[\"\']?(?=\s|$|[;&|])", re.M)
LEZARAS = re.compile(_ELOTAG + r"agent-msg-close\.sh[\"\']?(?=\s|$|[;&|])", re.M)

UZENET = """KULDES-LEZARAS KAPU: TILTVA, ez a hivas nem futhat igy.

  Egy bash-hivasban all egy KULDES (agent-msg.sh) es egy LEZARAS (agent-msg-close.sh).
  A lezaras szovege ilyenkor MAR KESZ, mielott a kuldes visszaadna az `OK id=<n>`-t -- tehat
  minden ra hivatkozo szam vagy talalgatas, vagy veletlenul helyes.

  BONTSD KET HIVASRA: eloszor a kuldes, olvasd ki a LATOTT id-t, es csak azutan a lezaras.

  AMI MARAD SZABAD: tobb LEZARAS egy hivasban, kuldes nelkul. Ott nincs friss id, amire
  hivatkozni lehetne, tehat a kotegeles nem veszelyes -- ne szedd szet feleslegesen.

  AMIT EZ A KAPU NEM FED LE: csak a ket agent-msg helper egyuttallasat fogja meg. A SZABALY
  tagabb: minden szovegre all, ami ugyanabban a hivasban keletkezo ertekre hivatkozik -- pl.
  kuldes + dash-api.sh kartya-komment, vagy kuldes + naplo-sor. Azokra a kapu HALLGAT, es a
  hallgatasa NEM jovahagyas."""


def heredoc_nelkul(parancs: str) -> str:
    """Drop heredoc BODIES so that text ABOUT the helpers is not read as a call TO them.

    The marker token is all that gets removed from its own line: everything else on that line --
    notably the `| bash scripts/agent-msg.sh ...` pipeline that FOLLOWS `<<'MSG'` in the form
    CLAUDE.md prescribes -- is command, not body. The body starts on the NEXT line.

    An earlier version kept only the part BEFORE the marker, which made the gate structurally blind
    to exactly the one form it was built for (michel measured it on 2026-09-23 over 1803 Bash calls:
    three firings, all false positives, zero real hits). The six controls were green because the
    fixtures used a form we do not write.
    """
    JELOLO = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
    ki, varok = [], []
    for sor in parancs.split("\n"):
        if varok:
            if sor.strip() == varok[0]:
                varok.pop(0)
            continue
        maradek, tagek = "", []
        pozicio = 0
        for m in JELOLO.finditer(sor):
            maradek += sor[pozicio:m.start()]
            tagek.append(m.group(2))
            pozicio = m.end()
        maradek += sor[pozicio:]
        ki.append(maradek)
        varok.extend(tagek)
    return "\n".join(ki)


# Absolute, derived from THIS file's own location -- not from CLAUDE_PROJECT_DIR, which is not set
# in every session (michel measured this on 2026-09-23). A relative path resolved against the cwd
# would give every agent its OWN log, and the per-agent threshold the 09-30 evaluation uses would
# then be computed from one agent's rows while looking like the fleet's.
# A proba SOSE irjon a kozos merleg-naploba (sanyiba, 2026-09-23 -- a harmadik torles utan).
# A boss teszt-rutinja `rm -f`-fel zart, es a kozos naplo ekkorra mar elo eroforras volt: harom
# torles egy napon, es a harmadikban nyolc adatsor veszett el (michel es safar friss kontrolljai,
# sanyiba ket tuzelese). Ez ugyanaz a lepes, amit sanyiba a sajat orszemen delelott megtanult --
# ott a proba VALODI riasztast kuldott, itt a proba mossa el a valodi merleget. Egy kozos
# meroeszkozon a proba es az eles ugyanabba az allomanyba ir, ha nincs kulon kapcsolo.
JELOLO = "KAPU-KONTROLL"   # a parancs szovegebe irva jeloli, hogy a sor kontroll
NAPLO = os.environ.get("KULDES_LEZARAS_KAPU_LOG") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "store", "kuldes-lezaras-kapu.log")

# Common secret shapes, so that a blocked command cannot carry a token into a plaintext log.
TITOK = re.compile(
    r"(?:Bearer\s+\S+|\.dashboard-token|[A-Za-z0-9_-]{32,}|--kuld\b|SECRET[A-Z_]*=\S+|TOKEN[A-Z_]*=\S+)"
)


def kie() -> str:
    """Which agent fired the gate. The 2026-09-30 evaluation splits PER AGENT, so an unstable
    column would silently mis-apportion the threshold.

    CLAUDE_CONFIG_DIR is the stable field (michel measured it on 2026-09-23): it is
    `agents/<id>/.claude-config` for sub-agents and `<project>/.channels-config` for the main one,
    and it does NOT move with the cwd. CLAUDE_PROJECT_DIR is not set in every session, and the cwd
    basename gives the SAME agent three different names depending on where it stands.

    The value is NOT an agent id for the main agent (it is the project directory name) -- it is
    stable and unique, which is what a per-agent count needs. A value that did not come from
    CLAUDE_CONFIG_DIR carries its source as a prefix, so the evaluation can tell a measured row
    from a guessed one.
    """
    c = os.environ.get("CLAUDE_CONFIG_DIR")
    if c:
        reszek = c.rstrip("/").split("/")
        if len(reszek) >= 2:
            return reszek[-2]
    p = os.environ.get("CLAUDE_PROJECT_DIR")
    if p:
        return "proj:" + os.path.basename(p.rstrip("/"))
    return "cwd:" + os.path.basename(os.getcwd())


def naplo_fejlec() -> None:
    """Create the log on first import so that its EXISTENCE is itself a claim (sanyiba, 2026-09-23).
    A missing file and a violation-free week produce the same number otherwise -- the storage-side
    twin of marci's "a silent gate and a disciplined fleet give the same number". The header also
    says SINCE WHEN the evaluation counts, which a first row alone cannot."""
    try:
        if not os.path.exists(NAPLO):
            with open(NAPLO, "a", encoding="utf-8") as f:
                f.write(f"# kuldes-lezaras-kapu naplo | letrehozva {time.strftime('%Y-%m-%d %H:%M:%S')}"
                        f" | elso iro: {kie()} | oszlopok: ido | agens | mod | ok | parancs | kontroll-jeloles: a parancsba `# KAPU-KONTROLL` | a '#' sorok nem adatsorok\n")
    except Exception:
        pass


def naplozz(parancs: str):
    """One line per firing. Without it there is nothing to count on 2026-09-30, and the decision
    would rest on memory -- the exact shape this gate exists to prevent."""
    try:
        agens = kie()
        reszlet = TITOK.sub("<REDACTED>", parancs.replace("\n", " ")[:200])
        mod = "naplo" if os.environ.get("KULDES_LEZARAS_KAPU_MOD") == "naplo" else "blokk"
        # NEGYEDIK OSZLOP: a sor CELJA, nem a modja (marci es michel fuggetlenul, 2026-09-23).
        # A harmadik oszlop azt mondja meg, hogy a kapu BLOKKOLT-e; ez azt, hogy volt-e MIERT.
        # Enelkul egy proba-tuzeles es egy valodi szabalysertes betuhiven egyforma, es a 09-30-i
        # ertekelesnek uzenetekbol kellene kivonnia a kontrollokat -- emlekezetbol, ami pont az
        # az alak, amit ez a kapu megelozni hivatott. Ugyanaz, mint a marci-fele `mod=` a
        # minta-naplokon, egy szinttel feljebb: ha egy naplot tobb SZANDEK ir, a sor mondja meg.
        # A JELOLO A PARANCS SZOVEGEBOL JON, NEM A KORNYEZETBOL (marci merte ki elesben,
        # 2026-09-23): a hookot a Claude Code kulon folyamatkent inditja, NEM a vizsgalt
        # bash-hivas gyermekekent -- tehat egy `export PROBA=1` vagy egy `PROBA=1 ` elotag a
        # parancsban SOSEM jut el ide. A jelolt kontroll-sorok igy `valodi`-kent alltak a
        # naploban: "a mero hitelesebb lett anelkul, hogy igazabb lenne".
        # A szoveges jelolo EGYUTT UTAZIK a vizsgalt paranccsal, tehat elerheto onnan, ahol a
        # kontrollt irjak. Hamisithato -- de ez ONBEVALLO naplo, nem biztonsagi kapu: a kerdes
        # nem a szandekos hamisitas, hanem hogy a JOSZANDEKU jeloles megerkezik-e.
        # Az env-valtozo megmarad a KOZVETLEN szkript-hivasu probakhoz, ahol viszont hat.
        ok = ("kontroll" if (JELOLO in parancs or os.environ.get("KULDES_LEZARAS_KAPU_PROBA"))
              else "valodi")
        sor = f"{time.strftime('%Y-%m-%d %H:%M:%S')} | {agens} | {mod} | {ok} | {reszlet}\n"
        with open(NAPLO, "a", encoding="utf-8") as f:
            f.write(sor)
    except Exception as hiba:
        # A gate must never crash on a logging failure -- but a SILENT failure is worse than none:
        # on 2026-09-23 this very function failed with NameError and the empty log read as "no
        # firings". The trace goes into the refusal message, where it cannot be missed.
        return f"    FIGYELEM: a kapu-naplo irasa NEM sikerult ({type(hiba).__name__}) -- a 09-30-i ertekeles ezt a tuzelest NEM fogja latni."
    return None


def main() -> None:
    try:
        adat = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # unparseable payload must not wedge the session
    naplo_fejlec()
    if adat.get("tool_name") != "Bash":
        sys.exit(0)
    parancs = (adat.get("tool_input") or {}).get("command") or ""
    torzs = heredoc_nelkul(parancs)
    if KULDES.search(torzs) and LEZARAS.search(torzs):
        baj = naplozz(parancs)
        # CSAK-NAPLOZO MOD (sanyiba kerese, 2026-09-23): an agent whose work is almost entirely
        # Bash wants the gate to MEASURE before it BLOCKS, because the false-positive rate on a
        # profile unlike mine is nobody's measurement yet. The row lands either way, so the
        # 09-30 evaluation sees log-only agents too -- marked, so the two are never summed.
        if os.environ.get("KULDES_LEZARAS_KAPU_MOD") == "naplo":
            print(UZENET + "\n\n    [CSAK-NAPLOZO MOD: a hivas FUT. A sor a naploba kerult.]"
                  + (("\n\n" + baj) if baj else ""), file=sys.stderr)
            sys.exit(0)
        print(UZENET + (("\n\n" + baj) if baj else ""), file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
