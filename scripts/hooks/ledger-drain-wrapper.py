#!/usr/bin/env python3
"""A ledger-drain KEZBESITO burka: a kerdest shell teszi fel, nem egy LLM-kor.

MIERT (2026-09-17, Zsolt jovahagyasa, Telegram 3709):
A `ledger-live-drain` eddig `heartbeat` tipuskent futott: ketpercenkent egy LLM-kor
tette fel a kerdest, TELJES session-kontextussal. Merve (7 nap, a transzkriptek
`usage` mezoibol): ez volt a teljes token-fogyasztas **54,7 szazaleka**, es ebbol
**96 szazalek CACHE-OLVASAS** -- 1,6M token kontextus ujraolvasasa koronkent, 702
token atlagos valaszert. Nem a munka kerult penzbe, hanem a KERDEZES MODJA.

AMIT NEM SZABAD ELRONTANI: ugyanabban a 7 napban 39 bejovo uzenetbol **13 KIZAROLAG
ezen a mechanizmuson at** jutott el a sessionig (a csatorna elnyelte). Az uzenetek
harmada. A kepesseg tehat nem csokkenhet.

A KOCKAZAT, AMI EBBOL KOVETKEZIK: a drain DEDUPAL -- egy `message_id`-t EGYSZER hoz
felszinre (`_record_surfaced` kozvetlenul a stdout utan). Vagyis mire ez a burok
meglatja a blokkot, a szkript MAR elfelejtette. Ha a kezbesites elbukik, az uzenet
VEGLEG elveszne.
**Ezert a burok eloszor TAROL, aztan kezbesit:** a blokk a `store/ledger-drain-fuggo.jsonl`
fajlba kerul, es csak SIKERES `OK id=<n>` utan tunik el onnan. Ami nem ment at, azt a
kovetkezo kor (2 perc) ujraprobalja, es a kilepesi kod nem nulla, amig fuggoben van.

>>> ES EZ A SZERKEZET ONMAGABAN HURKOT TUD CSINALNI -- ELES ESET, 2026-09-17 21:56..22:04,
NEGY PERCCEL A FAJL COMMITJA UTAN (57f8424). Javitva Zsolt jovahagyasaval, Telegram 3724. <<<

A tarolj-elobb-kezbesits-utana szerkezet az ELVESZTEST csereli DUPLIKATUMRA, ha a folyamat
a sikeres kuldes es a nyugta rogzitese kozott hal meg. Ez a helyes csere -- **de csak addig,
amig a halal OKA FUGGETLEN a kezbesitestol.** Aznap nem volt az: a burok a SAJAT, EPP DOLGOZO
sessionombe kezbesit, tehat a kuldes pont akkor lassu, amikor a felszinre hozas tortenik.
A menet: a kuldes 21:58:07-kor sikerult (6283-as uzenet), a futast viszont 21:58:06-kor
megolte a feladat 120 masodperces `timeoutMs`-e, tehat az `OK id=` nyugtat mar nem olvasta ki.
Es mivel a `probak` szamlalo csak a MEMORIABAN nott (a `ment()` a cikluson KIVUL allt),
a lemezen 0 maradt: a kovetkezo kor ugyanazt kezbesitette ujra, ugyanugy elbukott, es igy
tovabb. Harom peldany ment ki, a negyediket kezi torles allitotta meg.
**Es a futas-belyeg, ami epp ez ellen keszult, NEM jelzett: csak TISZTA kilepesnel irodott,
tehat a legerdekesebb eset -- a megolt futas -- eppen nem hagyott nyomot.**

A HAROM JAVITAS, es mindharom ugyanazt az egy hianyt zarja be (a megolt futas ne legyen nema):
1. **A kiserlet a KEZBESITES ELOTT kerul lemezre** (`probak` novelese es `ment()` a kuldes
   ELOTT). Igy egy megolt futas is nyomot hagy, es a szamlalo nem ragad 0-n.
2. **A belyeg a futas ELEJEN irodik** (`fut` allapottal), es a vegen csak a MEZOI frissulnek.
   Ezert egy SIGKILL-lel megolt futas is friss idobelyeget hagy, `fut` vagy
   `kezbesites-folyamatban` allapottal -- ez a ket ertek ONMAGABAN elarulja, hogy a kor
   nem ert veget. SIGTERM-re kulon kezelo ir `megszakitva` allapotot.
3. **A kezbesitesnek SAJAT idokorlatja van (`KEZBESITES_TIMEOUT`), ami KISEBB a feladat
   `timeoutMs`-enel.** Igy a burok maga zarja le a kiserletet, es kepes rogziteni az
   eredmenyt -- nem a scheduler oli meg a rogzites elott.
Es egy negyedik, ami a hurkot akkor is elvagja, ha mindharom fenti kimarad:
4. **`MAX_PROBA` utan a tetel `feladva`, es nem kezbesitunk ra tobbet.** Ilyenkor a kilepesi
   kod nem nulla es a naplo hangos, tehat a tetel nem tunik el -- de nem is arasztja el a
   sessiont. Ket rossz kozul ez a kisebbik: egy ismetlodo, figyelmen kivul hagyhato riasztas
   jobb, mint egy ketpercenkent ujrakezbesitett uzenet.

TESZTELHETOSEG: a harom allomany utja kornyezeti valtozobol felulirhato
(`DRAIN_FUGGO`, `DRAIN_NAPLO`, `DRAIN_BELYEG`). Enelkul a burkot nem lehet kiprobalni
anelkul, hogy az ELES allapotot irna -- es egy javitas, amit csak elesben lehet megnezni,
maga is kockazat.
"""
import json, os, re, signal, subprocess, sys, time

GYOKER = '/root/marveen/marveen/marveen/marveen'
FUGGO = os.environ.get('DRAIN_FUGGO', os.path.join(GYOKER, 'store', 'ledger-drain-fuggo.jsonl'))
NAPLO = os.environ.get('DRAIN_NAPLO', os.path.join(GYOKER, 'store', 'ledger-drain-wrapper.log'))
BELYEG = os.environ.get('DRAIN_BELYEG', os.path.join(GYOKER, 'store', 'ledger-drain-wrapper.allapot'))
DRAIN = os.environ.get('DRAIN_CMD',
                       f'python3 {GYOKER}/scripts/hooks/ledger-live-drain.py')

# A feladat `timeoutMs`-e 120000. A kezbesites sajat korlatja ENNEL kisebb legyen, hogy a
# burok maga zarja le a kiserletet es rogzitse az eredmenyt.
KEZBESITES_TIMEOUT = int(os.environ.get('DRAIN_KEZBESITES_TIMEOUT', '70'))
# A kezbeseito parancs is felulirhato, UGYANAZERT, amiert a `DRAIN_CMD` az: enelkul a
# javitas kritikus resze (a kiserlet lemezre irasa a kuldes ELOTT) csak elesben, valodi
# uzenet-kuldessel lenne kiprobalhato.
KEZBESITO = os.environ.get('DRAIN_KEZBESITO',
                           f'bash {GYOKER}/scripts/agent-msg.sh')
MAX_PROBA = int(os.environ.get('DRAIN_MAX_PROBA', '3'))
# Az idotullepes NEM bukas: a helper varhat a FOGLALT cel-sessionre, mikozben az uzenet mar
# letrejott. A bizonyitek a TAROLO, nem a helper valasza -- ezert a burok visszaolvassa.
# (Felulirhato, hogy a javitas proba-adatbazison is merheto legyen.)
DB = os.environ.get('DRAIN_DB', os.path.join(GYOKER, 'store', 'claudeclaw.db'))


def log(*a):
    with open(NAPLO, 'a', encoding='utf-8') as f:
        f.write(time.strftime('%F %T ') + ' '.join(str(x) for x in a) + '\n')


def betolt():
    try:
        with open(FUGGO, encoding='utf-8') as f:
            return [json.loads(l) for l in f if l.strip()]
    except Exception:
        return []


def ment(sorok):
    # URES listanal TOROLJUK a fajlt, nem ures fajlt hagyunk: igy a fajl PUSZTA
    # LETEZESE jelenti azt, hogy van kezbesitetlen tetel -- egy ures fajl
    # ugyanugy nezne ki, mint egy fuggo, es a kovetkezo olvaso nem tudna
    # kulonbseget tenni.
    if not sorok:
        try: os.remove(FUGGO)
        except FileNotFoundError: pass
        return
    tmp = FUGGO + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        for s in sorok:
            f.write(json.dumps(s, ensure_ascii=False) + '\n')
    os.replace(tmp, FUGGO)


def kezbesites_igazolas(blokk, tol):
    """Idotullepes utan: LETREJOTT-E megis az uzenet? A tarolo dont, nem a helper valasza.

    MIERT (2026-09-18, Zsolt jovahagyasa; harom masodpeldany egy MAR MEGVALASZOLT kerdesre):
    az `agent-msg.sh` a FOGLALT cel-sessionre VAR, es a burok 70 masodperces korlatja elobb
    jar le, mint ahogy az `OK id=` megjonne. Mind a harom kezbesites MEGTORTENT (6288, 6289,
    6290), es a burok mindharmat bukasnak konyvelte -- vagyis egy MAR MEGVALASZOLT kerdes
    ment fel ujra es ujra. **A drain akkor tuzel, amikor van mit felhozni, vagyis amikor a
    session DOLGOZIK: a nyugta epp abban az allapotban olvashatatlan, amiben a mechanizmus a
    leggyakrabban fut.**

    A blokk elso sora (`OPEN_QUESTION chat_id=... message_id=...`) eleg megkulonbozteto
    kulcsnak; a teljes szoveget azert NEM hasonlitjuk, mert a kezbesitett uzenet a bevezetot
    is tartalmazza.
    """
    kulcs = blokk.split('\n')[0].strip()
    if not kulcs:
        return None
    try:
        import sqlite3
        db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True, timeout=5)
        try:
            sor = db.execute(
                "SELECT id FROM agent_messages WHERE from_agent='boss' AND to_agent='boss' "
                "AND created_at >= ? AND instr(content, ?) > 0 ORDER BY id DESC LIMIT 1",
                (tol, kulcs)).fetchone()
        finally:
            db.close()
        return str(sor[0]) if sor else None
    except Exception as e:
        # FAIL-OPEN A REGI VISELKEDES FELE: ha a visszaolvasas maga bukik, a tetel fuggoben
        # marad es a kovetkezo kor ujraprobalja -- ugyanaz, mint a javitas elott. Egy nema
        # "kezbesitve" itt rosszabb volna, mint egy felesleges ujraproba.
        log(f'IGAZOLAS NEM FUTOTT LE ({e.__class__.__name__}: {e}) -- a tetel fuggoben marad')
        return None


def kezbesit(blokk):
    """Inter-agent uzenet SAJAT MAGAMNAK: a router beteszi a session inputjaba,
    tehat ugyanugy elem meg, mintha a heartbeat hozta volna fel -- csak CSAK AKKOR,
    ha van mit. A szoveg STDIN-en megy (a helper az argumentum-format elutasitja).

    IDOKORLATTAL: a cel session lehet epp foglalt, es akkor a helper VAR. Sajat korlat
    nelkul a scheduler oli meg a futast, MIELOTT az eredmenyt rogziteni tudnank."""
    uzenet = (
        '[ELVESZETT BEJOVO UZENET -- a ledger-drain hozta felszinre]\n\n'
        'Ez egy korabban ELVESZETT, meg megvalaszolatlan bejovo uzenet a Telegram\n'
        'csatornabol: a csatorna elnyelte, es a rendszer csak most talalta meg.\n'
        'VALASZOLJ RA MOST a reply toollal, a blokkban szereplo chat_id-ra, ugyanugy,\n'
        'mintha eppen most erkezett volna.\n\n'
        + blokk
    )
    indult = int(time.time()) - 5   # 5 mp csuszas-tures az ora- es iras-kesesre
    try:
        p = subprocess.run(KEZBESITO.split() + ['boss', 'boss', '-'],
                           input=uzenet.encode('utf-8'),
                           capture_output=True, cwd=GYOKER,
                           timeout=KEZBESITES_TIMEOUT)
    except subprocess.TimeoutExpired:
        # A kuldes ATMEHETETT -- ezt 2026-09-18 ota NEM feltetelezzuk, hanem MEGMERJUK.
        # A `probak` szamlalo tovabbra is a hivas ELOTT kerul lemezre, tehat ha a visszaolvasas
        # sem fut le, a regi viselkedes all vissza (fuggoben marad, MAX_PROBA utan felad).
        # A SOR A TIMEOUT PILLANATABAN KELETKEZIK, NEM ELOTTE (kimerve 2026-09-18 08:09:14 --
        # az elso eles kor a javitas utan). A 6291-es uzenet `created_at`-je MASODPERCRE
        # egyezett azzal a pillanattal, amikor a burok visszaolvasott, es igy a sajat esetere
        # "nincs nyoma"-t adott. Ezert az igazolas TURELMI IDOVEL es TOBBSZOR fut.
        mid = None
        for varakozas in (0, 2, 3):
            if varakozas:
                time.sleep(varakozas)
            mid = kezbesites_igazolas(blokk, indult)
            if mid:
                break
        if mid:
            return mid, (f'IDOTULLEPES {KEZBESITES_TIMEOUT}s, DE A TAROLO SZERINT KIMENT '
                         f'(uzenet {mid}) -- a nyugtat nem lattuk, a kezbesitest igen')
        return None, f'IDOTULLEPES {KEZBESITES_TIMEOUT}s -- a taroloban sincs nyoma'
    ki = (p.stdout or b'').decode() + (p.stderr or b'').decode()
    m = re.search(r'OK id=(\d+)', ki)
    return (m.group(1) if m else None), ki.strip()[:200]


def belyeg(allapot, novel=False):
    """Futas-belyeg MINDEN korben, nem csak talalatnal. Egy or, ami ures korben
    semmit nem hagy, kivulrol megkulonboztethetetlen egy elromlottol -- es ez a
    mechanizmus Zsolt uzeneteinek harmadat viszi, tehat a "fut-e egyaltalan"
    kerdesre kell tudni valaszolni. Egyetlen fajl, nem novekvo naplo.

    `novel=True` CSAK a futas elejen: a szamlalo koronkent egyszer no, a tobbi
    hivas ugyanannak a futasnak az ALLAPOTAT irja at. Ezert egy megolt futas is
    friss idobelyeget hagy, `fut`/`kezbesites-folyamatban` allapottal."""
    try:
        elozo = json.load(open(BELYEG))
    except Exception:
        elozo = {}
    ki = {'utolso_futas': elozo.get('utolso_futas') if not novel else time.strftime('%F %T'),
          'futasok': elozo.get('futasok', 0) + (1 if novel else 0),
          'utolso_allapot': allapot,
          'utolso_talalat': elozo.get('utolso_talalat')}
    if novel:
        ki['utolso_futas'] = time.strftime('%F %T')
    if allapot == 'talalat':
        ki['utolso_talalat'] = ki['utolso_futas']
    tmp = BELYEG + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(ki, f, ensure_ascii=False, indent=1)
    os.replace(tmp, BELYEG)


def _sigterm(signum, frame):
    """A scheduler eloszor SIGTERM-et kuld. Ez az egyetlen pillanat, amikor meg
    tudunk irni valamit -- SIGKILL-re mar nem."""
    try:
        belyeg('megszakitva')
        log('MEGSZAKITVA (SIGTERM) -- a belyeg allapota: megszakitva')
    finally:
        os._exit(1)


def main():
    signal.signal(signal.SIGTERM, _sigterm)
    # A belyeg MINDJART az elejen, hogy egy megolt futas is friss idobelyeget hagyjon.
    belyeg('fut', novel=True)

    # 1. A DRAIN LEFUTTATASA -- ez a 99,7 szazalekban ures, es ingyen van.
    try:
        p = subprocess.run(DRAIN, shell=True, capture_output=True, timeout=60, cwd=GYOKER)
        kimenet = (p.stdout or b'').decode('utf-8', 'replace').strip()
    except Exception as e:
        log('A DRAIN FUTTATASA BUKOTT:', str(e)[:200])
        belyeg('drain-bukas')
        return 1

    fuggo = betolt()

    # 2. ELOSZOR TAROL, AZTAN KEZBESIT. A drain dedupal, tehat ha ezt kihagynank es
    #    a kuldes bukna, az uzenet VEGLEG elveszne.
    if kimenet.startswith('OPEN_QUESTION'):
        fuggo.append({'blokk': kimenet, 'elso': int(time.time()), 'probak': 0})
        ment(fuggo)
        log('UJ TALALAT, tarolva:', kimenet.split('\n')[0])

    if not fuggo:
        belyeg('ures')
        return 0

    # 3. KEZBESITES. A KISERLET A KULDES ELOTT KERUL LEMEZRE (2026-09-17-i hurok):
    #    ha a futast megolik a kuldes kozben, a szamlalo akkor sem ragad 0-n.
    belyeg('kezbesites-folyamatban')
    maradt, kuldott, feladva = [], 0, 0
    for i, tetel in enumerate(fuggo):
        # ELOSZOR AZT KERDEZD MEG, HOGY AZ ELOZO PROBA NEM MENT-E AT (2026-09-18, negy
        # masodpeldany egy MAR MEGVALASZOLT kerdesre). A timeout utani azonnali visszaolvasas
        # ELES KORBEN HAROMSZOR IS NULLAT ADOTT: a sorok `created_at`-je (6291, 6292, 6293)
        # masodpercre egyezett azzal a pillanattal, amikor a burok mar feladta. Egy turelmi
        # ido ezt csak szukiti, nem zarja be -- a KOVETKEZO kor viszont ket perccel kesobb
        # jon, es akkor a sor BIZTOSAN ott van. Ezert a dontes nem a kuldes UTAN szuletik,
        # hanem ELOTTE: ha mar van sor az elso tarolas ota, a tetel UJRAKULDES NELKUL kerul ki.
        if tetel.get('probak', 0) > 0:
            mid = kezbesites_igazolas(tetel['blokk'], tetel['elso'] - 5)
            if mid:
                kuldott += 1
                log(f'MAR KIKEZBESITVE (uzenet {mid}), a nyugtat csak nem lattuk: '
                    f'{tetel["blokk"].split(chr(10))[0]} | {tetel["probak"]}. proba utan, '
                    'UJRAKULDES NELKUL kiveve')
                ment(maradt + fuggo[i + 1:])
                continue

        if tetel.get('feladva'):
            maradt.append(tetel)
            feladva += 1
            continue
        if tetel.get('probak', 0) >= MAX_PROBA:
            tetel['feladva'] = True
            maradt.append(tetel)
            feladva += 1
            ment(maradt + fuggo[i + 1:])
            log(f'FELADVA {MAX_PROBA} proba utan, TOBBET NEM KEZBESITEM: '
                f'{tetel["blokk"].split(chr(10))[0]} -- a tetel BENT MARAD, a kilepesi kod '
                'nem nulla. Lehet, hogy MAR kikezbesitettuk es csak a nyugtat nem lattuk.')
            continue

        tetel['probak'] = tetel.get('probak', 0) + 1
        ment(maradt + [tetel] + fuggo[i + 1:])   # <- a KISERLET lemezen, MIELOTT kuldenenk
        mid, ki = kezbesit(tetel['blokk'])
        if mid:
            kuldott += 1
            log(f'KEZBESITVE: uzenet {mid} | {tetel["blokk"].split(chr(10))[0]} '
                f'| {tetel["probak"]}. proba')
        else:
            maradt.append(tetel)
            log(f'KEZBESITES BUKOTT ({tetel["probak"]}. proba): {ki}')
    ment(maradt)

    belyeg('talalat' if kuldott else ('feladva' if feladva else 'kezbesites-bukas'))
    if maradt:
        kor = (int(time.time()) - min(t['elso'] for t in maradt)) / 60.0
        log(f'FUGGOBEN: {len(maradt)} tetel ({feladva} feladva), a legregebbi {kor:.0f} perce. '
            'Amig ez nem nulla, a feladat BUKOTTNAK szamit.')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
