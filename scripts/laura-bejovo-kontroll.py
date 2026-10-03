#!/usr/bin/env python3
"""Laura bejovo uzeneteinek pozitiv kontrollja -- A KINYERES ALAKJAT IS KIIRVA.

MIERT LETEZIK (2026-09-30): a kreativ kor minden nap kiirja a kontroll-ERTEKET (darabszam +
tartomany ket vege), es az elozo kor soraval veti ossze. Ma a szam +1-gyel elmozdult (144 -> 145)
ugy, hogy AZNAP NULLA bejovo volt -- tehat az elteres a MEROBEN allt. Attribualni viszont nem
lehetett: az elozo kor az ERTEKET tarolta el, a KINYERES ALAKJAT nem, es a kinyerest addig minden
kor ad-hoc irta ujra.

KET HIPOTEZIST MERTEM ES MINDKETTO MEGDOLT:
  (1) a reggeli minta szigorubb volt a tag belso mezoire -> NEM: a `user_id`-t kovetelo es a nem
      kovetelo alak UGYANAZT a 145-ot adja.
  (2) ma kerult be egy id a korpuszba (idezetkent, a sajat vizsgalatombol) -> NEM: egyetlen id sincs,
      aminek minden elofordulasa mai esemenyben allna.
A +1 tehat egy MAR ELVESZETT kinyeresre vonatkozik, es az visszamenoleg nem hozhato vissza. Ez a
szkript a KOVETKEZO elterest teszi attribualhatova.

A boss lelete nyoman (agent_messages 8402): a kontroll-ertek melle nem annak a kodnak a verzioja
kell, ami a SZAMOT kepzi, hanem ami az ADATOT termeli, amibol a szam lesz. Nalam ketto van, es
MINDKETTO valtozhat:
  mero_verzio  -- EZ a fajl (a minta maga; md5)
  korpusz      -- a beolvasott fajlok NEVE es SORSZAMA (md5), mert a glob halmaza is elmozdulhat
Igy a kovetkezo elteres harom agra bomlik: mas minta / mas korpusz / valodi uj uzenet.

BUKTATO, AMI NELKUL EZ A SZKRIPT NULLAT AD: a `<channel ...>` tag a JSONL-ben JSON-stringben ul,
tehat az idezojelei ESCAPE-ELVE allnak (\\"). A nyers bajtra irt, nem escape-elt minta 0 id-t ad --
es egy olyan napon, amikor tenyleg nincs bejovo, ez MEGKULONBOZTETHETETLEN a valodi nullatol.
Ezert van benne az `assert`: a nulla ITT a mero hibaja, nem allitas.
A `content` text-blokkbol kiolvasott valtozat pedig a CSAK-MELLEKLETES uzeneteket dobja el
(ma: 96 kontra 145) -- ezert illesztunk a NYERS soron, nem a dekodolt szovegen.
"""
import re, glob, io, json, sys, os, hashlib, collections, datetime

GYOKER = '/root/.claude/projects/-root-marveen-marveen-marveen-marveen-agents-michel'
CHAT   = json.load(io.open('/root/marveen/marveen/marveen/marveen/store/laura-chat.json'))['chat_id']  # NEM a kodban: a repo publikus
MINTA  = (r'<channel source=\\"plugin:telegram:telegram\\" chat_id=\\"' + CHAT +
          r'\\"[^>]*?message_id=\\"(\d+)\\"[^>]*?ts=\\"([^\\]+)\\"')

def helyi(ts):
    return (datetime.datetime.strptime(ts[:19], '%Y-%m-%dT%H:%M:%S')
            + datetime.timedelta(hours=2)).strftime('%Y-%m-%d %H:%M')

gyoker = sys.argv[1] if len(sys.argv) > 1 else GYOKER
pat    = re.compile(MINTA)
tal    = {}
fajlok = []
for f in sorted(glob.glob(os.path.join(gyoker, '*.jsonl'))):
    sorok = 0
    for line in io.open(f, encoding='utf-8', errors='replace'):
        sorok += 1
        for m in pat.finditer(line):
            tal[int(m.group(1))] = m.group(2)
    fajlok.append(f"{os.path.basename(f)[:8]}:{sorok}")

ids = sorted(tal)
# POZITIV KONTROLL: a nulla itt a MERO hibaja. Laura tobb szaz uzenetet kuldott; ha egyet sem latunk,
# a minta vagy a gyoker rossz -- es epp egy ures napon ez a valodi nullaval osszekeverhető.
assert ids, f"A MERO VAK: 0 id ({gyoker}) -- a nulla NEM allitas"

mero    = hashlib.md5(io.open(__file__, 'rb').read()).hexdigest()[:12]
korpusz = hashlib.md5(' '.join(fajlok).encode()).hexdigest()[:12]
ma      = [i for i in ids if helyi(tal[i]).startswith(datetime.date.today().isoformat())]
nap     = collections.Counter(helyi(t)[:10] for t in tal.values())
nullas  = 0
d = datetime.date.today()
while d.isoformat() not in nap:
    nullas += 1
    d -= datetime.timedelta(days=1)

# A KORPUSZNAK GORDULO ALSO HATARA VAN, TEHAT A CSOKKENES AZ ALAPESET (2026-10-03).
# A `korpusz` hash megmondja, hogy a halmaz MAS -- azt nem, hogy a kulonbseg a RETENTION miatt all
# elo. A Claude Code beepitett `cleanupPeriodDays` defaultja 30 nap (egyetlen settings-fajlban sem
# allitjuk at), es a top-level session-transzkriptek legregebbije pontosan ma-30 napnal all. Tehat
# minden reggel kieshet a legregebbi nap, es a darabszam LEFELE mozdul anelkul, hogy barmi elromlott
# volna. 2026-10-03: 145 -> 133, az also hatar 402 -> 445, mert egy 09-02-i transzkript kiesett.
# DE A KET TENGELY MASKEPP MOZOG, es a sajat elso megfogalmazasom ("a korpusz also hatara GORDUL")
# a FAJL-tengelyt irta le, nem azt, amit ez a szam mer (a boss javitasa, agent_messages 8652):
#   FAJL-hatar ......... sima RAMPA, naponta egy nap, elore szamolhato
#   TARTALOM-horizont .. LEPCSO. Amig egy hosszu eletu session EL, O tartja a horizontot, es az
#                        relativ ertelemben minden nap REGEBB lesz (31, 32, 33 napja). Amikor az a
#                        session kiesik, a horizont EGYSZERRE ugrik elore, akar hetekkel -- es az
#                        ugras MERETE a legregebbi elo session eletkoratol fugg, nem a retentiontol.
# Tehat a napi noveked NORMALIS, az ESEMENY majd az ugras lesz. A boss a teljes fan megmerte: a
# tartalom-horizont ott 44 nap volt (egy 93 MB-os, MA IS irodo session tartja), a fajl-hatar 29 --
# majdnem felszer szelesebb. **A 44-es szamot SZANDEKOSAN NEM irom be a kodba:** egy masik fabol,
# egy idopontban mert ertek, es egy dokumentumba beirt alapertek ugyanolyan meroeszkoz, mint egy
# szkript, csak nincs kilepesi kodja -- amikor elavul, nem hibazik, hanem hiteles alaku elterest
# termel. A MECHANIZMUS a durable resz, a szam nem.
# EZERT A SZAM MELLE A HORIZONT IS KIKERUL: igy a `KONTROLL: N db` onmagaban megmondja, MELYIK
# ABLAKRA ervenyes. Ugyanaz a lecke, mint a hajnali orjarat (c) szamanal: egy szam, ami nem arulja
# el, melyik halmazon mertek, a megnyugtato iranyba teved. (A boss kerese, agent_messages 8650.)
# ES EGY NUANSZ, AMI NELKUL A SZAM ELLENTMONDASNAK LATSZIK: a horizont a TARTALOM also hatara, a
# retention viszont a FAJL mtime-jara megy. Egy tobb napon at elo session fajlja minden irassal
# frissul, tehat a benne allo LEGREGEBBI uzenet lehet a 30 napos ablakon TUL is. Merve 2026-10-03:
# a horizont 09-02 (31 napja), mert az `ad3ec66d` fajl utolso irasa 09-13 -- a fajl friss, a
# tartalma nem. Vagyis a "31 napja" nem cafolja a 30 napos retentiont, ket kulonbozo datumrol van szo.
horizont = min(tal.values())          # a LEGREGEBBI meg LATHATO uzenet idobelyege
print(f"KONTROLL: {len(ids)} db, {ids[0]} .. {ids[-1]}")
_hnap = (datetime.date.today() - datetime.date(*map(int, helyi(horizont)[:10].split('-')))).days
print(f"HORIZONT: a legregebbi lathato uzenet {helyi(horizont)[:10]} ({_hnap} napja)")
print("          A hatart a leghosszabb eletu TULELO session tartja, nem a retention datuma: ALL,")
print("          majd UGRIK, amikor az a session kiesik. A retention a FAJL mtime-jara ervenyes, ez")
print("          a szam a TARTALOMRA -- ket kulonbozo idotengely, nem ellentmondas.")
print(f"MA ({datetime.date.today()}): {len(ma)} bejovo" + (f"  {ma}" if ma else ""))
print(f"NULLA-NAP egymas utan: {nullas}")
print(f"utolso bejovo: {ids[-1]}  {helyi(tal[ids[-1]])}")
print(f"mero_verzio={mero}  korpusz={korpusz}  fajl={len(fajlok)} ({' '.join(fajlok)})")
