#!/bin/bash
# channel-reply-guard — Stop hook
#
# When the last user message came from a channel (Telegram/Slack/Discord) but the
# turn ended WITHOUT a channel send-tool call, this hook blocks the stop and asks
# the model to actually send the reply — instead of only generating it as text
# into the CLI transcript, where the user never sees it.
#
# Reads the Stop event's stdin JSON for transcript_path, inspects the last user
# message and the assistant tool calls produced after it.

INPUT=$(cat)

python3 - "$INPUT" << 'PYEOF'
import json, sys, os, datetime

# NAPLO -- MERT A NEMA OR NEM MERHETO (2026-08-21).
# A guard eddig se sikeres, se blokkolo futasrol nem hagyott nyomot, ezert kivulrol nem lehetett
# megmondani, hogy EL-e egyaltalan -- csak azt, hogy be van-e kotve a settings.json-ba. A ketto
# nem ugyanaz: a hook REGISZTRACIOJAT (settings.json) a Claude Code session-indulaskor olvassa be.
# ES A KORABBI MONDAT ITT TUL TAGAN ALLT ("a frissen beirt hook nem feltetlenul hat") -- MERVE
# CAFOLVA 2026-09-30-an: a SZKRIPT TORZSE minden hivasnal frissen olvasodik. Bizonyitek a naplo
# sajat soraibol: az agens-oszlopot 09:21-22 korul kotottem be, es michel korenek 09:23:24-es
# sora MAR TARTALMAZTA (`michel`) -- az o sessionje kozben nem indult ujra. A REGISZTRACIO es a
# TARTALOM tehat ket kulon kerdes, es csak az elso kotott a session indulasahoz.
# Ez a sor teszi a kerdest merhetove.
NAPLO = "/root/marveen/marveen/marveen/marveen/store/channel-reply-guard.log"
# AGENS-OSZLOP. A naplo 2267 sorabol OT BLOKKOL all, es egyikhez sem lehetett agenst kotni
# (michel merese, 8386) -- egy FLOTTA-szintu ornel ez onmagaban hiany: a blokkjai nem
# visszakeresztezhetok. A forras a config-dir, nem a cwd: a cwd a munkakonyvtar, ami tobb agensnel
# ugyanaz lehet.
_AGENS = "?"
try:
    import os as _os
    # TESZT-JELOLO. A mutacios teszt a KOZOS naploba ir, es 2026-09-30-an epp michel BLOKKOL-
    # darabszamat tolta el (5 -> 8), vagyis egy MASIK agens bizonyitekat rontotta el. A naplo
    # `data_delete` ala tartozik (level 1, LOCKED), tehat torolni nem lehet -- a jelolo az
    # EGYETLEN ut, hogy a teszt-sorok utolag szetvalaszthatok legyenek.
    if _os.environ.get("CHANNEL_GUARD_TESZT"):
        _AGENS = "TESZT"
        raise StopIteration
    _cd = _os.environ.get("CLAUDE_CONFIG_DIR", "")
    if "/agents/" in _cd:
        _AGENS = _cd.split("/agents/", 1)[1].split("/", 1)[0]
    elif _cd:
        _AGENS = "boss"
except StopIteration:
    pass
except Exception:
    pass
def naploz(dontes, ok=""):
    try:
        with open(NAPLO, "a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')}\t{_AGENS}\t{dontes}\t{ok}\n")
    except Exception:
        pass  # a naplozas SOHA ne akadalyozza meg a hook mukodeset

try:
    data = json.loads(sys.argv[1])
except Exception:
    naploz("ATENGED", "ertelmezhetetlen bemenet"); sys.exit(0)

transcript = data.get("transcript_path", "")
if not transcript or not os.path.exists(transcript):
    naploz("ATENGED", "nincs transcript"); sys.exit(0)

# Tool-name fragments that mean an actual channel send
SEND_TOOLS = ("telegram", "reply", "slack", "discord")

# VERSENY A TRANSCRIPT IRASAVAL -- KIMERVE 2026-08-24, michel jelzese nyoman.
#
# A hook a Stop pillanataban olvassa a transcriptet, de a fajlba iras ASZINKRON. Michel elkuldte a
# valaszt (a reply tool `sent (id: 378)`-at adott vissza, 15:57:47Z), a hook 17 masodperccel kesobb
# megis BLOKKOLT. Visszajatszottam a transcriptet harom allapotban, es a BLOKKOL kimenet PONTOSAN
# EGYBEN all elo: amikor a reply TOOL-HIVAS SORA MEG NINCS KIIRVA a fajlba.
#     a transcript a hivas sora ELOTT tart  -> last_user=csatorna, sent=False -> BLOKKOL
#     a hivas sora mar bent van             -> sent=True                      -> ATENGED
#     minden bent van                       -> last_user=tool_result          -> ATENGED
# Vagyis a `sent (id: N)` MEGBIZHATO jel (a kuldes megtortent), a hook tevedett.
#
# AMIERT EZ TOBB EGY BOSSZANTO RIASZTASNAL: a hamis blokk duplikatum-kuldeshez vezet (michel egy
# rovidebb valtozatot kuldott utana, helyesen -- a ket kimenetel koltsege nem szimmetrikus), es
# hosszabb tavon ahhoz, hogy megtanuljuk figyelmen kivul hagyni az ort. Egy or, amit rutinszeruen
# felulbiralunk, rosszabb, mint ha nem lenne.
#
# A JAVITAS: blokkolas ELOTT ujraolvasunk. A varakozas 400 ms, a hook timeoutja 10 s -- belefer.
# Az ATENGED agakat NEM erinti, tehat a hamis NEGATIV kockazata nem no.
import time

def _olvas():
    try:
        return open(transcript, encoding="utf-8").read().splitlines()
    except Exception:
        return None

lines = _olvas()
if lines is None:
    sys.exit(0)

# Walk events; remember the index of the last user message.
events = []
last_user_idx = None
for ln in lines:
    if not ln.strip():
        continue
    try:
        ev = json.loads(ln)
    except Exception:
        continue
    events.append(ev)
    role = ev.get("message", {}).get("role") or ev.get("role")
    # A TOMORITESI OSSZEFOGLALO NEM ERKEZES (kimerve 2026-09-30, michel hamis blokkja,
    # agent_messages 8386). Az `is_channel` egy RESZSZOVEG-kereses; a tomorites osszefoglaloja
    # IDEZHETI a csatorna-tag alakjat (michel epp egy korabbi hibajat dokumentalta vele), es
    # onnantol az or ugy latja, mintha csatorna-uzenet erkezett volna. Merve ugyanabban a
    # sessionben: harom tomoritesbol ketto 0, a harmadik 1 talalat -- a blokk pontosan a
    # harmadiknal jott, tehat nem "a tomorites utan", hanem "ha a tomorites IDEZI a mintat".
    # ES A KAR ASZIMMETRIKUS: a heartbeat/scheduled-task KIVETEL jelolojet a tomorites ELMOSSA,
    # a TUZELO mintat viszont atviszi -- tehat a kivetel epp akkor nem fog, amikor kellene.
    # A MEZO strukturalisan zarja be, nem egy ujabb minta (ugyanaz a lepes, mint az auth-probanal
    # a `isApiErrorMessage` mezo-alapu szures a szerializalt alak helyett).
    # ES A `continue` HELYE TEHERHORDO, NEM VELETLEN (michel nevezte meg, 8389; mutanssal merve).
    # Ez a sor a `role == "user"` vizsgalat ELOTT all, tehat ATLEPI a tomoritest, es a
    # `last_user_idx` az ELOZO VALODI user-esemenyre mutat. A kezenfekvo alternativa ("ha az utolso
    # user-esemeny tomorites, ENGEDD AT a kort") kivulrol ugyanigy nez ki, de HAMIS NEGATIVOT nyit.
    # MERVE (M5 mutans: valodi csatorna-uzenet, kuldes nelkul, UTANA tomorites):
    #     ez az alak        -> BLOKKOL   (helyes)
    #     "atenged" alak    -> atenged   (a megvalaszolatlan uzenet csendben elveszik)
    # Ha valaki ezt "egyszerusiti", az M5 az egyetlen mutans, ami megfogja.
    if ev.get("isCompactSummary"):
        continue
    if role == "user":
        last_user_idx = len(events) - 1

if last_user_idx is None:
    sys.exit(0)

def text_of(ev):
    msg = ev.get("message", ev)
    c = msg.get("content", "")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in c)
    return str(c)

user_text = text_of(events[last_user_idx])
is_channel = (
    'source="plugin:telegram' in user_text
    or '<channel source=' in user_text
    or '← telegram' in user_text  # "← telegram"
)
if not is_channel:
    naploz("ATENGED", "nem csatorna-uzenet"); sys.exit(0)

# Heartbeat / scheduled-task prompts may legitimately stay silent.
if (
    'scheduled-task:' in user_text
    or '[Heartbeat:' in user_text
    or 'untrusted source="scheduled-task' in user_text
):
    naploz("ATENGED", "heartbeat/scheduled-task"); sys.exit(0)

# Was there a channel send-tool call after the last user message?
sent = False
for ev in events[last_user_idx + 1:]:
    msg = ev.get("message", ev)
    content = msg.get("content", [])
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "tool_use":
                name = (part.get("name") or "").lower()
                if any(t in name for t in SEND_TOOLS):
                    sent = True
                    break
    if sent:
        break

if sent:
    naploz("ATENGED", "volt csatorna-kuldes"); sys.exit(0)

# BLOKKOLNANK -- de eloszor ujraolvassuk a transcriptet (lasd a verseny-magyarazatot fent).
# Ha a masodik olvasasra mar latszik a kuldes, ATENGEDUNK: a valasz kiment, csak kesett a fajl-iras.
time.sleep(0.4)
_ujra = _olvas()
if _ujra is not None and len(_ujra) > len(lines):
    _ev = []
    _last = None
    for _ln in _ujra:
        if not _ln.strip():
            continue
        try:
            _e = json.loads(_ln)
        except Exception:
            continue
        _ev.append(_e)
        _r = _e.get("message", {}).get("role") or _e.get("role")
        if _e.get("isCompactSummary"):      # ugyanaz a kizaras, mint a fo agon
            continue
        if _r == "user":
            _last = len(_ev) - 1
    if _last is not None:
        _ut = text_of(_ev[_last])
        _ch = ('source="plugin:telegram' in _ut or '<channel source=' in _ut or '\u2190 telegram' in _ut)
        _sent = False
        for _e in _ev[_last + 1:]:
            _c = _e.get("message", _e).get("content", [])
            if isinstance(_c, list):
                for _p in _c:
                    if isinstance(_p, dict) and _p.get("type") == "tool_use":
                        if any(t in (_p.get("name") or "").lower() for t in SEND_TOOLS):
                            _sent = True
                            break
            if _sent:
                break
        if (not _ch) or _sent:
            naploz("ATENGED", "masodik olvasasra megvan a kuldes (transcript-iras kesett)")
            sys.exit(0)

# No channel send -> block and remind the model.
print(json.dumps({
    "decision": "block",
    "reason": (
        "The user's last message arrived from a channel (Telegram/Slack/Discord), "
        "but this turn did NOT call the channel send-tool (e.g. the telegram reply "
        "tool). Your text answer only went into the CLI transcript and never reached "
        "the user. Send the reply NOW via the channel send-tool (use the chat_id from "
        "the inbound <channel> tag)."
    )
}))
naploz("BLOKKOL", "csatorna-uzenet kuldes nelkul")
sys.exit(0)
PYEOF
