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
        ms = pat.findall(line)
        if not ms:
            continue
        # A SAJAT TESZT-SZOVEGEM BEKERULT A KORPUSZBA (kimerve 2026-10-05). A 2026-10-04-i
        # channel-reply-guard pozitiv kontrollomhoz egy SZINTETIKUS `<channel ...>` taget gyartottam
        # (`message_id=9001`), es az a sajat transzkriptembe is bekerult -- a mero innen olvas.
        # A kar NEM a darabszam volt, hanem a tartalma: a tartomany felso vege 829 -> 9001, a
        # NULLA-NAP 2 -> 1, es az "utolso bejovo" egy SOSEM LETEZETT uzenet lett. Vagyis a mero
        # BEJOVO AKTIVITAST HAZUDOTT egy olyan napra, amikor Laura nem irt -- a KAPU 1 nyitottnak
        # latszott volna.
        # A KIZARAS A SOR SZEREPERE MEGY, NEM A MINTARA: ha a sor JSON-je `role: assistant`, akkor
        # azt a szoveget EN irtam, nem erkezett.
        # ES AMIERT NEM `role == 'user'` A FELTETEL (merve, 134 id-n): 89 id all sima `user` soron,
        # 44 OLYAN soron, aminek a szerepet ez a kod NEM tudja kiolvasni (mas alak), es 1 (a 9001)
        # `assistant`-on. A `user`-re SZUKITES tehat 44 VALODI id-t dobna el. A tagadas iranya a
        # konzervativ: csak azt zarjuk ki, amirol BIZONYITHATO, hogy sajat iras.
        # AMIT EZ NEM FOG MEG: ha egy teszt-szoveg olyan sorba kerul, aminek a szerepe `?`.
        try:
            _role = (json.loads(line).get('message', {}) or {}).get('role')
        except Exception:
            _role = None
        if _role == 'assistant':
            continue
        for m in ms:
            tal[int(m[0])] = m[1]
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
#
# ES HA A KET MEZO EGYSZERRE MOZDUL (a boss kerese, agent_messages 8655): a sorban NEVEZD MEG,
# melyik valtozas MELYIK hatast magyarazza. Ket egyidejű IGAZ valtozas egymas alibije lesz --
# "a minta is mas, a korpusz is mas, tehat a darabszam-elteres meg van magyarazva" --, es egy
# HARMADIK, valodi ok (uj uzenet, eltunt uzenet) elfer kozottuk anelkul, hogy barmelyik mezo
# jelezne. A helyes alak tagonkent rendeli hozza a hatast:
#     mero_verzio mas  -> ennyi es ennyi id-t erint, mert a minta/szures valtozott
#     korpusz mas      -> ennyi es ennyi id-t erint, mert ez a fajl kiesett/bejott
#     a maradek         -> EZ a valodi esemeny, es csak ez
# Elso eles elofordulas: 2026-10-04, amikor ket commit (minta) es a gordulo also hatar (korpusz)
# egyszerre valt igazza.
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

# ===== ROGZITETT-PELDANY-EGYEZES (2026-10-04, a boss kikotesevel: agent_messages 8852) =====
# MIERT: ma a `mero_verzio` ugy mozdult, hogy a kimenet harom szama BETURE valtozatlan maradt
# (133 db, 445 .. 829). A tegnapi ertek (942014577c6d) a fajl NEGY commitolt valtozata kozul
# egyikkel sem egyezett, a mai (3dc67457a2e7) a HEAD-en tarolt tartalom md5-je. Vagyis a tegnapi
# kor egy NEM COMMITOLT munkafa-allapoton futott, es azt egy repo-muvelet 08:31 es 08:34 kozott
# eltuntette. A SKILL harom agra bontja a kovetkezo elterest (mas minta / mas korpusz / valodi uj
# uzenet); ez egy NEGYEDIK ag, es a legcsendesebb, mert epp a SZAM nem mozdul tole.
#
# AMIT EZ A MEZO TUD, ES AMIT NEM -- a boss kikotese, es a mezo szovege is ezt mondja ki:
#   NEM attribual, hanem KIZAR egy agat.
#   EGYEZIK, es a hash megis mozdult  -> a HAROM EREDETI ag egyike, nem a negyedik
#   ELTER                             -> a mero nem rogzitett peldany, a negyedik ag NYITOTT
#
# ES A HORGONY FAJLONKENT MAS, EZERT A MEZO MEGNEVEZI, MELYIKHEZ MERT. A boss postafiok-koreben a
# mero (`scripts/browser/webmail-erkezettek.mjs`) SZANDEKOSAN gitignore-olt (valodi email-cimek,
# fail-closed dontes), tehat NINCS HEAD-valtozat, amihez merni lehetne -- nala a horgony a napi
# mentes. Ezert nem "HEAD-egyezes" a mezo neve:
#   git-horgony ....... 1 commit felbontas, de csak KOVETETT fajlra
#   mentes-horgony .... 24 ora felbontas, viszont gitignore-olt fajlra is mukodik
# A ket horgony nem helyettesiti egymast: a durvabb felbontas annyit allit, hogy a fajl a hajnali
# mentesben rogzitett allapot -- egy aznapi, mentes utani modositast NEM lat.
_REPO = '/root/marveen/marveen/marveen/marveen'

def _rogzitett_peldany(ut, sajat_md5):
    """(allapot, horgony) -- 'EGYEZIK' / 'ELTER' / 'MERETLEN', es a horgony megnevezese."""
    import subprocess, tarfile
    val = os.path.realpath(ut)
    # A MERO LEHET A REPON KIVUL (teszt-masolat, /tmp): ilyenkor a `relpath` `../..`-alakot ad, es
    # MINDKET horgony-kereses felreertheto hibaval bukna. Ezt ki kell mondani, nem tunet-szinten.
    if os.path.commonpath([val, _REPO]) != _REPO:
        return 'MERETLEN', f'a mero nem a repo faban all: {val}'
    rel = os.path.relpath(val, _REPO)
    def _git(*a):
        return subprocess.run(('git', '-C', _REPO) + a, capture_output=True, timeout=20)
    # 1. git-horgony, ha a fajl kovetett
    try:
        if _git('ls-files', '--error-unmatch', '--', rel).returncode == 0:
            blob = _git('show', f'HEAD:{rel}')
            sha  = _git('rev-parse', '--short', 'HEAD').stdout.decode().strip()
            if blob.returncode == 0:
                egy = hashlib.md5(blob.stdout).hexdigest()[:12] == sajat_md5
                return ('EGYEZIK' if egy else 'ELTER'), f'HEAD {sha} (felbontas: 1 commit)'
    except Exception as e:
        return 'MERETLEN', f'git-horgony hiba: {type(e).__name__}'
    # 2. mentes-horgony a nem kovetett (pl. gitignore-olt) fajlra
    try:
        m = sorted(glob.glob(os.path.join(_REPO, 'backups', 'claudeclaw-*.tar.gz')))
        if not m:
            return 'MERETLEN', 'nincs se git-horgony, se mentes'
        with tarfile.open(m[-1]) as t:
            try:
                f = t.extractfile(f'repo/{rel}')
            except KeyError:
                return 'MERETLEN', f'a mentesben nincs benne: repo/{rel}'
            if f is None:
                return 'MERETLEN', f'a mentesben nem sima fajl: repo/{rel}'
            egy = hashlib.md5(f.read()).hexdigest()[:12] == sajat_md5
        return ('EGYEZIK' if egy else 'ELTER'), f'{os.path.basename(m[-1])} (felbontas: 24 ora)'
    except Exception as e:
        return 'MERETLEN', f'mentes-horgony hiba: {type(e).__name__}'

_allapot, _horgony = _rogzitett_peldany(__file__, mero)
print(f"ROGZITETT-PELDANY: {_allapot} -- horgony: {_horgony}")
print("          NEM attribual, hanem KIZAR egy agat. EGYEZIK + mozdult mero_verzio -> a harom")
print("          eredeti ag egyike (mas minta / mas korpusz / valodi uj uzenet). ELTER -> a mero")
print("          nem rogzitett peldany volt, tehat a negyedik ag (nem commitolt allapot) NYITOTT.")
