#!/usr/bin/env python3
"""Hajnali orjarat auth-proba -- NEGY szammal, a nevesitett kivetelek kizarasaval.

A kizaras kulcsa KIZAROLAG a registry `kivetel` objektuma. Az `ismert` listat SOHA nem olvassuk:
az az ELO agens-fakat sorolja fel, es azt kizarni pont a merest oltana ki.
"""
import json, sys, re, os, glob, atexit, datetime, io
from collections import Counter

# FUTAS-BELYEG -- MERT A NEM FUTO PROBA UGYANUGY NEZ KI, MINT A TISZTA (2026-09-30, a boss
# `ledger-live-drain` esete nyoman: ott ket hetig egyetlen sor sem keletkezett, es ez nem dontesbol
# kovetkezett, hanem abbol, hogy senki nem merte meg). Eddig a hajnali orjarat EGYETLEN nyoma a napi
# naplo volt -- azt viszont AZ AGENS irja, ugyanaz, akinek a kimaradasat ki akarjuk szurni. Ha a
# jarat nem tuzel, a nyom a jelenseggel EGYUTT tunik el. A belyeg ezert azt irja, amit a MUVELET
# tud: futott-e, hanyadszor, es MILYEN allapottal allt le.
# A `kod` a "legutolso allapot FAJTAJA" jel: 0=tiszta, 1=a mero vak, 2=elo talalat.
# atexit: a ket korai `sys.exit(1)` es egy nem kezelt kivetel utan is lefut -- kulonben a belyegnek
# maganak lenne soha-nem-futo aga, egy szinttel lejjebb ugyanaz a hiba.
# A TESZT-FELISMERES KET TAGU, ES NEM EGY OPCIONALIS KAPCSOLON ALL (2026-10-02).
# ELOZMENY: a kapcsolo (`MICHEL_BELYEG_TESZT=1`) VEDELEMKENT volt szanva, es ket nap alatt KETSZER
# elfelejtettem. A masodik eset megmutatta, hogy a kar nem a futas-szam inflacio: egy NEGATIV
# KONTROLL futasom (egy MASOLAT registryvel, amibol kivettem egy ismert alakot) a VALODI belyegbe
# irt `uj_alak=13`-at. A belyeg ettol tovabbra is hitelesen nezett ki -- friss idopont, `kod=0` --,
# csak nem a vilagrol allitott. **A futas-szam inflacioja LATHATO, a TARTALOM elszennyezese nem.**
# A KRITERIUM NEM AZ ARGUMENTUM LETE, HANEM AZ ATADOTT REGISTRY AZONOSSAGA (a boss msg 8517):
# az "argumentum van -> teszt" szabaly az ELO registryt explicit atado futasra is teszt-belyeget
# adna, es a scheduler argumentumos hivasanal az elo belyeg MEGALLNA (hangos irany, de felesleges).
# A MASODIK TAG a szkript-masolatra szol: a mutacio-teszteket a SZKRIPT mutalt masolatan, ELO
# registryvel futtatom, es arra a registry-tengely VAK.
# AMIT EZ NEM FOG MEG (kimondva, hogy ne varjunk tole tobbet): elo szkript + elo registry + ALTALAM
# PERTURBALT bemeneti fa (pl. egy szandekosan inditott folyamat a /proc-ban). Az ilyen belyeg NEM
# hamis -- igaz allitas egy olyan vilagrol, amit en mozdítottam el --, tehat a kar kisebb; arra a
# kapcsolo marad, mostantol FELULIRASKENT, nem vedelemkent.
# >>> ES A `CLAUDE_CONFIG_DIR` A LISTA UJ TAGJA, DE SULYOSABB AZ ELOZOEKNEL (2026-10-05, a boss
# sajat eseten, a futtato-mezo BEVEZETESEKOR). A felso bekezdes szerint a perturbalt bemenet "igaz
# allitas egy olyan vilagrol, amit en mozditottam el" -- a futtato-mezonel ez NEM all, mert a
# perturbalt ertek maga lesz a CIMKE. Az elso pozitiv kontrollom (env-vel atallitott futtato, elo
# szkript, elo registry) `futtato=michel` sort irt az ELES belyegbe, tehat michel jaratarol allitott
# valotlant -- epp arra a kerdesre hamis valaszt, amiert a mezo bekerult. Kivettem, es a tesztet a
# kapcsoloval ismeteltem (`teszt_ok=env`).
# A kodban NEM zarjuk be: a futtato egyetlen forrasa az env, tehat a szkript nem tudja
# megkulonboztetni a valodit az atallitottol. A LEPES ezert eljaras: a futtato-tengely perturbalasa
# MINDIG `MICHEL_BELYEG_TESZT=1`-gyel fusson.
_ELO_REGISTRY = '/root/marveen/marveen/marveen/marveen/store/projektdir-or.json'
_ELO_SZKRIPT  = '/root/marveen/marveen/marveen/marveen/scripts/auth-proba.py'
_CFG_UT  = sys.argv[1] if len(sys.argv) > 1 else _ELO_REGISTRY
_MAS_REG = os.path.realpath(_CFG_UT)  != os.path.realpath(_ELO_REGISTRY)
_MAS_SZK = os.path.realpath(__file__) != os.path.realpath(_ELO_SZKRIPT)
_TESZT   = (_MAS_REG or _MAS_SZK
            or os.environ.get('MICHEL_BELYEG_TESZT') == '1')
# A belyeg-ut ABSZOLUT literal: a hajnali jarat abszolut uttal hivja a szkriptet, tehat a
# munkakonyvtar NEM az, ahol a `store/` all -- relativ utra epiteni itt nemán elhibazott lenne.
_BELYEG  = ('/root/marveen/marveen/marveen/marveen/store/michel-orjarat-belyeg-auth'
            + ('.teszt' if _TESZT else '') + '.txt')
# A FUTTATO AZONOSITASA -- MERT AZ `ido` MEZO KULONBEN BARKI FUTASAT JELENTI (michel 8872,
# 2026-10-05). Ma reggel EN futtattam a probat hatszor, es ezzel michel 03:33-as jaratanak nyoma
# tiz perc alatt elveszett a belyegbol. Az irany a MEGNYUGTATO, ezert kell javitani: ha a jarat
# egyszer CSENDBEN LEALL, de valaki mas lefuttatja a probat, a belyeg FRISS lesz, es a leallas nem
# latszik -- pontosan az a kerdes, amiert a belyeg letezik.
# A CIMKE SOHA NE LEGYEN HIHETO, DE KITALALT AGENS-NEV (michel mert buktatoja a reply-guard
# `elif _cd: _AGENS = "boss"` else-agan): az `/agents/<nev>/` minta a MERT alak, minden mas a NYERS
# utat viszi `nem-agents:` elotaggal. Merve 2026-10-05, mind a nyolc elo folyamat environjen:
#   .../agents/michel/.claude-config   -> michel
#   .../marveen/.channels-config       -> nem-agents:.channels-config   (ez a boss, de NEM nevezzuk el)
#   /root/.boss-worker/.claude-config  -> nem-agents:.boss-worker       (a basename itt haszontalan)
def _futtato():
    cd = os.environ.get('CLAUDE_CONFIG_DIR', '')
    if not cd:
        return 'nincs-env'
    reszek = [x for x in cd.rstrip('/').split('/') if x]
    if 'agents' in reszek:
        i = reszek.index('agents')
        if i + 1 < len(reszek):
            return reszek[i + 1]
    nev = reszek[-1] if reszek else cd
    if nev == '.claude-config' and len(reszek) > 1:
        nev = reszek[-2]
    return 'nem-agents:' + nev
_FUTTATO = _futtato()
_allapot = {'kod': 'megszakadt', 'jel': 'a szkript a belyeg-iras elott allt le'}

def _belyeg_ir():
    # FUTTATONKENT EGY SOR. Egyetlen "utolso futas" sor azt meri, hogy futott-e BARKI -- es a
    # belyeg kerdese az, hogy futott-e a JARAT. A `futas` ezert szinten futtatonkenti.
    try:
        megjegyzes, masok, futas = [], [], 1
        try:
            for sor in io.open(_BELYEG, encoding='utf-8').read().splitlines():
                if not sor.strip():
                    continue
                if not sor.startswith('proba='):
                    # HORGONY, NEM KIZARAS (marci 8899, 2026-10-05). A korabbi alak a komment-
                    # JELOLOT (`#`) zarta ki, vagyis egy NYITOTT halmazrol tett fel valamit: minden
                    # nem-adat formatumot fel kell sorolnia, es azt a formatumot MASOK is irjak
                    # (ez a fajl kezzel szerkesztett olvasasi-szabaly blokkot hordoz a tetejen).
                    # A horgony az ADAT-SOR alakjat koti meg -- ZART halmaz, amit a SAJAT iro
                    # allit elo (`sajat = f"proba=auth-proba  ..."`, lentebb). Egy behuzott
                    # folytatas-sor vagy egy `//`-s jeloles a kizarast ATENGEDI, a horgonyt nem.
                    # MERVE ugyanaznap a `memoria-index-minta.log`-on: ott EGY ilyen blokk ket
                    # kulonbozo parse-ot tort el, es a ket hiba UGYANAZT a szamot adta (152),
                    # ket DISZJUNKT sor-halmazon -- tehat az egyezes megerositesnek latszott.
                    megjegyzes.append(sor); continue
                tokenek = dict(t.split('=', 1) for t in sor.split('  ') if '=' in t)
                f = tokenek.get('futtato')
                if f is None:
                    # REGI, FUTTATO NELKULI SOR: a szama MINDENKI futasat osszegezte, tehat egy
                    # futtatora nem ervenyes. Nem dobjuk el (az idopont adat), de megjegyzesse
                    # valik, hogy senki ne olvassa jelenlegi futtatonak.
                    megjegyzes.append('# REGI, OSSZEVONT SOR (2026-10-05 elott, minden futtato egyben): '
                                      + sor.strip())
                elif f == _FUTTATO:
                    try: futas = int(tokenek.get('futas', '0')) + 1
                    except Exception: futas = 1
                else:
                    masok.append(sor)
        except Exception:
            pass            # nincs meg belyeg: ez az elso futas
        sajat = (f"proba=auth-proba  futtato={_FUTTATO}"
                 f"  ido={datetime.datetime.now().isoformat(timespec='seconds')}"
                 f"  futas={futas}  kod={_allapot['kod']}  jel={_allapot['jel']}"
                 + (f"  teszt_ok={'reg' if _MAS_REG else ''}{'szkript' if _MAS_SZK else ''}"
                    f"{'env' if not (_MAS_REG or _MAS_SZK) else ''}" if _TESZT else ""))
        io.open(_BELYEG, 'w', encoding='utf-8').write(
            '\n'.join(megjegyzes + sorted(masok + [sajat])) + '\n')
    except Exception:
        pass                # a belyeg SOHA ne bukjon el a proba HELYETT
atexit.register(_belyeg_ir)

AUTH = re.compile(r'401|oauth|auth|login|unauthor|token has expired', re.I)
cfg  = json.load(open(_CFG_UT))   # ugyanaz az ut, amibol a teszt-felismeres is dontott
ROOT = cfg['projects_gyoker']
ISMERT_ALAK = set(cfg.get('ismert_alakok', []))   # NEM szuro: az ismeretlen alakot JELEZZUK
KIZART = set(cfg['kivetel'].keys())          # <- kizaro kulcs KIZAROLAG a `kivetel`.
# Az `ismert` listat CSAK itt olvassuk, es NEM kizarasra, hanem a kizaras TILTASARA:
# a valodi hiba az, ha egy ELO fa kerul a `kivetel`-be -- az csendben elnyelne az elo talalatot.
# (A korabbi `assert 'ismert' not in KIZART` csak egy `ismert` NEVU projektre sult volna el.)
utkozes = KIZART & set(cfg.get('ismert', []))
assert not utkozes, f"ELO fa a kivetelben: {sorted(utkozes)}"
# ES AZ ISMERETLEN-ALAK AG EGY URES LISTAN CSENDBEN KIKAPCSOL (michel 8872, 2026-10-05). A lenti
# feltetel `if ISMERT_ALAK and t.strip() not in ISMERT_ALAK`, tehat a rovidzar miatt ures listaval
# egyetlen sor sem lesz "uj alak", es a kimenet BETURE ugy nez ki, mint a tiszta eredmeny. Ez nem
# elmeleti: ez az ag a HORDOZOJA annak az ervelesnek, hogy egy ora-valtas (`resets 12pm`) jelzest
# kap -- ha kiurul, a jelzes eltunik, es egyedul a fajta-SZAM marad, amirol epp kimondtuk, hogy
# nem lelet. Ugyanaz a fail-closed kerdes, mint a `kivetel`-nel: a registry hianya NE csendes
# atengedes legyen. Az exit-kod SZANDEKOSAN 1, a fenti assert-tel egy osztalyban (registry-hiba),
# hogy ne szuletjen harmadik jelentes ugyanarra a kodra.
assert ISMERT_ALAK, "a registry `ismert_alakok` listaja URES -- az ismeretlen-alak ag kikapcsolna"

def projekt(path):
    rel = os.path.relpath(path, ROOT)
    return rel.split(os.sep)[0]

uj_alak = []
elo_total = kiz_total = 0
elo_auth, kiz_auth = [], []
elo_ts,  kiz_ts    = [], []
fajta = Counter()

files = glob.glob(os.path.join(ROOT, '**', '*.jsonl'), recursive=True)
# POZITIV KONTROLL: ha NULLA fajlt latunk, nem a fa tiszta, hanem a MERO vak (rossz gyoker,
# jogosultsag, elmozdult fa). Enelkul a szkript exit 0-val "tisztat" jelentene -- merve
# 2026-09-30: nem letezo `projects_gyoker` -> exit 0, ures kimenet, megkulonboztethetetlen a
# valodi tiszta esestol. A banner-sor kikotese ezt NEM fedi: az azt mondja meg, hogy a szkript
# LEFUTOTT-e, nem azt, hogy LATOTT-e valamit.
elo_files = [x for x in files if projekt(x) not in KIZART]
if not files:
    print(f"  fajl: 0   *** A MERO NEM LAT ({ROOT}) -- a nulla NEM allitas ***")
    _allapot.update(kod=1, jel=f'A_MERO_NEM_LAT:fajl=0:gyoker={ROOT}')
    sys.exit(1)
# ES a feltetel a KIZARAS UTAN maradora is all (a boss msg 8270). Ha a fajl-szam pozitiv, de ELO
# fa egy sem marad, az (a)/(b)/(c) ugyanugy nulla -- csak most a KIZARAS oltja ki a merest, nem a
# rossz gyoker. Az assert erre vak, ha a kizart projekt nincs az `ismert`-ben. Ma az elerhetoseg
# nulla (mind a 8 projekt az `ismert` vagy a `kivetel` halmazban van), de a CLASS igy zar be.
if not elo_files:
    print(f"  fajl: {len(files)}, de ELO fa egy sem   *** MINDEN FA KIZARVA -- a nulla NEM allitas ***")
    print(f"      kizart: {sorted(KIZART)}")
    _allapot.update(kod=1, jel=f'MINDEN_FA_KIZARVA:fajl={len(files)}')
    sys.exit(1)
for f in files:
    kiz = projekt(f) in KIZART
    for l in open(f, encoding='utf-8', errors='replace'):
        # GYORSITO elo-szuro: a KULCS NEVERE szur, az ERTEKRE NEM. A szerializalt alakra
        # fogadni (`"isApiErrorMessage":true`) csendes nullat ad egyetlen szokozre is
        # (a boss mutansa, 2026-09-30). A szigoru ellenorzes lentebb dont.
        if 'isApiErrorMessage' not in l:
            continue
        try: d = json.loads(l)
        except Exception: continue
        if d.get('isApiErrorMessage') is not True:
            continue
        c = d.get('message', {}).get('content')
        t = ' '.join(x.get('text','') for x in c if isinstance(x, dict)) if isinstance(c, list) else str(c)
        ts = d.get('timestamp')
        if kiz:
            kiz_total += 1
            if ts: kiz_ts.append(ts)
            if AUTH.search(t): kiz_auth.append((ts, projekt(f), t[:70]))
        else:
            elo_total += 1
            if ts: elo_ts.append(ts)
            fajta[t.strip()[:52]] += 1
            if AUTH.search(t): elo_auth.append((ts, projekt(f), t[:70]))
            if ISMERT_ALAK and t.strip() not in ISMERT_ALAK:
                uj_alak.append((ts, projekt(f), t.strip()))

elo_ts.sort(); kiz_ts.sort()
print(f"  fajl: {len(files)}   kizart projekt: {sorted(KIZART) if KIZART else '-'}")
print(f"  (a) auth-reszhalmaz, kivetel nelkul .......... {len(elo_auth)}")
print(f"  (b) osszes mezo-jelolt, kivetel nelkul ....... {elo_total}"
      + (f"   | a kizarttal egyutt: {elo_total + kiz_total}" if kiz_total else ""))
print(f"  (c) legutobbi barmilyen, KIVETEL NELKUL ...... {elo_ts[-1] if elo_ts else 'nincs'}")
print(f"  (d) kizarva: {kiz_total}" + (f"  ({', '.join(kiz_ts)})" if kiz_ts else ""))
for ts, p, t in kiz_auth:
    print(f"      ebbol auth: {ts}  [{p}]  {t}")
if elo_auth:
    print("  *** ELO FABAN AUTH-TALALAT ***")
    for ts, p, t in elo_auth:
        print(f"      {ts}  [{p}]  {t}")
# UJ ALAK: nem az auth-SZOT keressuk, hanem az ISMERETLEN alakot jelezzuk (boss msg 8277).
# Indok: egy szo-lista pont azon a szoveg-valtozaton bukik, amire keszult -- a `session HAS
# expired` meg a bovitett listat is elkerulte. Az alak-lista viszont nem zajos: 558 soron
# HAT kulonbozo teljes szoveg all, hetek alatt. Az auth-minta igy KENYELEM, nem kapu.
# NEM valtoztat kilepesi kodot: kiirja, es ranezunk. (Harmadik exit-kod ket forrast csinalna.)
if uj_alak:
    print(f"  *** ISMERETLEN ALAK: {len(uj_alak)} -- nezz ra, es ha rendben, vedd fel az `ismert_alakok` koze ***")
    for ts, p, t in uj_alak[:5]:
        print(f"      {ts}  [{p}]  {t[:110]}")
# MIND a fajta kiirodik, es a fejlec KIMONDJA az osszeget. A `most_common(6)` cap csendes
# egy-elterest adott a (b)-hez kepest (michel merte, 2026-10-05: a kiirt hat sor 549, a (b) 550),
# es a tevedes iranya a MEGNYUGTATO -- az olvaso kevesebb hibat lat, mint amennyi van. A cap
# nelkul a `sum(fajta.values()) == elo_total` SZERKEZETI azonossag (a szamlalo ugyanabban az
# `else:` agban no, mint az `elo_total`), tehat a rovat ettol kezdve ONMAGAT egyezteti a (b)-vel.
# A fejlec NEM azt ALLITJA, hogy az osszeg egyezik, hanem MEGMONDJA. Egy prozai "= (b)" az
# olvasora bizza a kivonast, es pont az a lepes maradt ki eddig is.
_fsum = sum(fajta.values())
print(f"  fajtak (elo fa): {len(fajta)} fajta, osszesen {_fsum}"
      + (f" = (b)" if _fsum == elo_total else
         f"  *** != (b)={elo_total} -- A ROVAT NEM TELJES ***"))
for s, n in fajta.most_common():
    print(f"      {n:5d}  {s}")
# A (d) NEM bukik el: csak all. Kilepesi kod kizarolag az ELO fa auth-talalatara.
_allapot.update(kod=2 if elo_auth else 0,
                jel=f'a={len(elo_auth)}:b={elo_total}:d={kiz_total}:fajl={len(files)}'
                    f':uj_alak={len(uj_alak)}:fajtak={len(fajta)}')
# A `fajtak` CSENDESEN kerul a belyegbe, jelzes NELKUL, es ez szandekos (michel merese, 2026-10-05).
# A kulcs `[:52]`, es a `resets 12pm` token az egyik ismert alakban a 31. karakteren all (a kulcson
# BELUL), a masikban a 81-en (kivul). Amikor a vendor atirja az orat, az elso alak UJ kulcsot kap,
# tehat a fajta-SZAM nő informacio nelkul -- es a fenti osszeg-azonossag erre VAK, mert az osszeg
# helyes marad. A szam-novekedes viszont NEM lelet, tehat hangos jelzes allando hamis pozitiv lenne;
# az ESEMENYT amugy is a megfelelo mechanizmus jelzi: az `uj_alak` ag a TELJES szoveget veti ossze
# (`t.strip() not in ISMERT_ALAK`), tehat az uj ora-ertek ott jon ki, a mar dokumentalt teendovel.
# A belyegbe azert kerul be, hogy a "mikor valtozott" kerdes KESOBB megvalaszolhato legyen.
sys.exit(2 if elo_auth else 0)
