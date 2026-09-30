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

print(f"KONTROLL: {len(ids)} db, {ids[0]} .. {ids[-1]}")
print(f"MA ({datetime.date.today()}): {len(ma)} bejovo" + (f"  {ma}" if ma else ""))
print(f"NULLA-NAP egymas utan: {nullas}")
print(f"utolso bejovo: {ids[-1]}  {helyi(tal[ids[-1]])}")
print(f"mero_verzio={mero}  korpusz={korpusz}  fajl={len(fajlok)} ({' '.join(fajlok)})")
