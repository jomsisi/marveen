#!/usr/bin/env python3
"""Egyiranyu tukrozes: FAJL-alapu memoria-tar -> SQLite `memories` tabla.

MIERT (2026-09-17, Zsolt jovahagyasa, kartya e1cd7381):
Ket memoria-tar el egymas mellett, es a tudasuk szetcsuszott. A FAJL-tar tolt be
magatol minden sessionbe (MEMORY.md index), de csak greppel keresheto es van
merethatara. Az SQLite tabla kulcsszora keresheto es nincs merethatara, de sosem
tolt be magatol -- es az iras rola lemaradt (utolso natv iras 2026-09-14).

Ez a szkript a fajl-tarat tekinti az EGYETLEN iras-helynek, es az uj/valtozott
lapokat atmasolja az SQLite-ba. EGYIRANYU, tehat nincs utkozes.

IDEMPOTENS: az allapot a `store/memoria-tukor-state.json`-ban all, lap-nev ->
{hash, memory_id}. Valtozatlan lap nem ir.

A MASOLT SOROK MEGKULONBOZTETHETOK: agent_id='fajl-tar', es a content elso sora
egy marker. Igy a "ki ir az SQLite-ba" meres kesobb sem keveri ossze oket a
kezzel irt sorokkal.
"""
import argparse, hashlib, json, os, re, subprocess, sys, time

GYOKER = '/root/marveen/marveen/marveen/marveen'
TAR = '/root/.claude/projects/-root-marveen-marveen-marveen-marveen/memory'
ALLAPOT = os.path.join(GYOKER, 'store', 'memoria-tukor-state.json')
KIHAGY = {'MEMORY.md'}
MARKER = 'FAJL-TAR TUKOR'


def frontmatter(szoveg):
    """(meta, torzs). A frontmatter YAML, de csak harom mezo kell, ezert nem
    huzunk be YAML-parsert egy hatsoros fejlechez."""
    if not szoveg.startswith('---'):
        return {}, szoveg
    veg = szoveg.find('\n---', 3)
    if veg < 0:
        return {}, szoveg
    fej, torzs = szoveg[3:veg], szoveg[veg + 4:]
    meta = {}
    for sor in fej.split('\n'):
        m = re.match(r'^\s*(name|description|type)\s*:\s*(.*)$', sor)
        if m:
            meta[m.group(1)] = m.group(2).strip().strip('"\'')
    return meta, torzs.lstrip('\n')


def kulcsszavak(nev, leiras):
    szavak = [w for w in nev.split('-') if len(w) > 2]
    for w in re.findall(r'[A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]{5,}', leiras or ''):
        if w.lower() not in szavak:
            szavak.append(w.lower())
    return ', '.join(szavak[:14])


def allapot_betolt():
    try:
        with open(ALLAPOT) as f:
            return json.load(f)
    except Exception:
        return {}


def dash_api(metodus, ut, torzs):
    """A helperen at megy, mert az ellenorzi a JSON-t ES a HTTP-statuszt."""
    p = subprocess.run(['bash', os.path.join(GYOKER, 'scripts', 'dash-api.sh'), metodus, ut],
                       input=json.dumps(torzs, ensure_ascii=False).encode('utf-8'),
                       capture_output=True, cwd=GYOKER)
    if p.returncode != 0:
        raise RuntimeError(f'{metodus} {ut} bukott: {p.stdout.decode()[:200]} {p.stderr.decode()[:200]}')
    m = re.search(r'\{.*\}', p.stdout.decode(), re.S)
    return json.loads(m.group(0)) if m else {}


def index_orszem(allapot):
    """A KOZOS MEMORY.md elveszett-frissites orszeme (safar leletebol, 2026-09-17).

    A tar KOZOS, es a szokasos iras-minta a READ-MODIFY-WRITE: beolvas, hozzafuz,
    kiir. Ket ilyen iras kozott elveszik az, ami a masik beolvasasa utan kerult be
    -- aznap HAROM tema-sor horog-szovege veszett el igy, es epp az a harom, amelyik
    a legtobb arva lap temajat felsorolta. Semmi nem jelzett.

    Ket olcso jel, es a masodik az erosebb:
      (a) CIM-CSAK sor: `- [Cim](fajl.md)` horog-szoveg nelkul -> egy horog elveszett
      (b) ELTUNT MUTATO: egy cel, ami a MULT futaskor bent volt, most nincs
    Egyik sem mondja meg, KI irta felul; azt mondja meg, hogy TORTENT.
    """
    ut = os.path.join(TAR, 'MEMORY.md')
    try:
        with open(ut, encoding='utf-8') as f:
            sorok = f.read().split('\n')
    except Exception as e:
        return [f'MEMORY.md olvashatatlan: {e}']

    cim_csak = [(i + 1, s) for i, s in enumerate(sorok)
                if re.match(r'^- \[[^\]]+\]\([^)]+\.md\)\s*$', s)]
    # MINDEN link, nem csak a sor-eleji. marci osszevont formatuma (tobb lap EGY sorban,
    # `- [TEMA](tema.md) -- benne: [a](a.md), [b](b.md)`) 2026-09-17-en HAMIS 'eltunt mutato'
    # riasztast adott, mert a sor-elejere horgonyzott minta csak az ELSO linket latta.
    # Ugyanaz a gyoker, mint a `.*`-os cim-csak mintanal: 'egy sor = egy link' feltevés.
    osszes = re.findall(r'\[[^\]]*\]\(([^)]*\.md)\)', '\n'.join(sorok))
    celok = set(osszes)

    jelzes = []
    # DUPLIKALT MUTATO (safar esete, 2026-09-18 08:2x). Az or eddig HALMAZKENT olvasta a
    # mutatokat, tehat a duplikatum szerkezetileg lathatatlan volt: aznap 31 duplikalt sor
    # kerult a kozos indexbe (205 elofordulas 174 egyedire), es EGYETLEN jel sem szolt.
    # A ket meglevo ag mast keres: a CIM-CSAK sor egy elveszett horog-szoveget, az ELTUNT
    # MUTATO egy hianyzo lapot -- a TOBBLET egyiknek sem tunik fel.
    # Az ok nem elirás volt, hanem egy STALE BASELINE-ra epulo "potlas": az append onmagaban
    # nem sert meglevo sort, de a ra epulo ALLITAS mar nem volt igaz.
    # KIVETEL: a MASIK INDEX. A `index-teljes-lapjegyzek.md` nem tartalom-lap, hanem az a
    # jegyzek, ahova a MEMORY.md-bol atfolyo sorok kerulnek -- az osszevont TEMA-sorok
    # MINDEGYIKE oda mutat vissza ("Teljes horog-szoveggel: [lapjegyzek](...)"). Ez a tobblet
    # tehat a KONSZOLIDACIO alakja, nem elveszett frissitesse. Kimerve 2026-09-29: a harmadik
    # atfolyas hat TEMA-sora + az eredeti sor = 7 elofordulas, es az or ezt duplikatumkent
    # jelezte -- vagyis PONT a helyes lepes valtott ki riasztast.
    # A KIVETEL SZUK ES NEVESITETT: minden MAS lapra a duplikatum tovabbra is esemeny.
    INDEX_CELOK = {'index-teljes-lapjegyzek.md'}
    if len(osszes) != len(celok):
        tobbszor = sorted({c for c in osszes if osszes.count(c) > 1} - INDEX_CELOK)
        # a tobblet-szamot is a kivetel NELKUL szamoljuk, kulonben a szam es a lista elter
        tobblet = sum(osszes.count(c) - 1 for c in tobbszor)
    else:
        tobbszor, tobblet = [], 0
    if tobbszor:
        jelzes.append(f'DUPLIKALT MUTATO: {len(tobbszor)} lapra osszesen '
                      f'{tobblet} tobblet-elofordulas')
        for c in tobbszor[:6]:
            jelzes.append(f'   {c} ({osszes.count(c)}x)')
    if cim_csak:
        jelzes.append(f'CIM-CSAK SOR (elveszett horog-szoveg): {len(cim_csak)}')
        for i, s in cim_csak[:6]:
            jelzes.append(f'   {i}. sor: {s[:88]}')

    regi = set((allapot.get('__index__') or {}).get('celok') or [])
    if regi:
        eltunt = regi - celok
        if eltunt:
            jelzes.append(f'ELTUNT MUTATO az elozo futas ota: {len(eltunt)}')
            for c in sorted(eltunt)[:8]:
                jelzes.append(f'   {c}')
    # ---------------------------------------------------------------------------
    # EGYUTTES LEFEDES: olyan lap, amit SEM a MEMORY.md, SEM a lapjegyzek nem linkel.
    # (sanyiba merese, 2026-10-05: 401 lap, 100 a MEMORY.md-bol, 301 CSAK a lapjegyzekbol,
    #  es VALODI arva 0 -- tehat a 10-02-i ketszintu atallas nem vesztett el lapot. Ez az a
    #  szam, amit az atallas UTAN meg kellett volna merni, es eddig egyetlen or sem adta.)
    #
    # MIERT KELL IDE MIND A KET INDEX (michel kriteriuma, ugyanaznap): a kerdes az, hogy
    # MEGVALTOZTATJA-E EGY NEM LATOTT INDEX-SOR A LATOTT SOROKROL HOZOTT ITELETET. Az arva-
    # relacional IGEN: egy nem olvasott mutato ARVANAK mutat egy linkelt lapot. Ezert egy
    # EGY-indexes alak itt DEFEKTUS -- szemben a horog- vagy meret-probaval, ahol minden sor
    # onmagaban iteltetik meg, es a szukebb hatokor csak KISEBB FEDETTSEGET ad.
    # Marci `memoria-index-or.py`-ja pont ezen bukott: 2026-10-05-en ket HAMIS pozitivot adott
    # (dup=1, arva=1), ELLENTETES iranyban, es ezert nem allt ossze egy diagnozissa.
    lapjegyzek = 'index-teljes-lapjegyzek.md'
    celok_mind = set(celok)
    try:
        with open(os.path.join(TAR, lapjegyzek), encoding='utf-8') as f:
            celok_mind |= set(re.findall(r'\[[^\]]*\]\(([^)]*\.md)\)', f.read()))
    except Exception as e:
        # A MASODIK index olvashatatlansaga NEM csendes atengedes: enelkul minden
        # lapjegyzek-only lap arvanak latszana (ma 301), tehat a jel hasznalhatatlan lenne.
        jelzes.append(f'{lapjegyzek} olvashatatlan, az arva-jel KIMARAD: {e}')
        celok_mind = None

    if celok_mind is not None:
        try:
            lapok = {n for n in os.listdir(TAR)
                     if n.endswith('.md') and '.ELOTTE' not in n and '.bak' not in n
                     and n not in ('MEMORY.md', lapjegyzek)}
        except OSError as e:
            jelzes.append(f'a lap-fa nem olvashato, az arva-jel KIMARAD: {e}')
            lapok = None
        if lapok is not None:
            arvak = sorted(lapok - celok_mind)
            # ISMERT arva = ALLAPOT (kiirjuk, nem bukunk el), UJ arva = ESEMENY -- ugyanaz a
            # szerkezet, mint a meret-ornel: egy allando piros egy het alatt hasznalhatatlan.
            ismert = set((allapot.get('__arva__') or {}).get('lapok') or [])
            ujak = [a for a in arvak if a not in ismert]
            print(f'  egyuttes lefedes: {len(lapok)} lap | linkelve {len(lapok & celok_mind)} | '
                  f'arva {len(arvak)} (ebbol UJ {len(ujak)})')
            if ujak:
                jelzes.append(f'UJ ARVA LAP (sem a MEMORY.md, sem a {lapjegyzek} nem linkeli): '
                              f'{len(ujak)}')
                for a in ujak[:8]:
                    jelzes.append(f'   {a}')
            allapot['__arva__'] = {'lapok': arvak}

    allapot['__index__'] = {'celok': sorted(celok), 'sor': len(sorok)}
    return jelzes


# A HIANYZO FAJL OSZTALYA TIPIKUSAN ATNEVEZES, es a lap_orszem docstringje ezt ki is mondja --
# megis exit 1-et okozott, tehat a feladat 2026-09-17 ota MINDEN NAP bukottnak latszott. Egy
# allando piros elrejti a kovetkezo, IGAZI jelzest (es epp ma kotottunk be melle egy harmadikat).
# Ugyanaz a kezeles, mint a `tema-hatokor` tartos elutasitasanal: ISMERT arva = ALLAPOT (kiirjuk,
# nem bukunk el rajta), UJ arva = ESEMENY (exit 1).
# A jegyzekbe csak KIMERT tetel kerulhet: meg kell nevezni, hova lett a lap, es miert nem kar.
ISMERT_ARVA = {
    'haromb-l-egyet-mutacio':
        'atnevezve -> harombol-egyet-mutacio.md (a regi nevben az `o` helyen kotojel allt); '
        'a lap EL, csak a tukor-sora (memories id=1073) arva. A sor TORLESE data_delete -> '
        'level 1, Zsolt donti; addig allapot. Kartya: memoria-tukor-arva-sor-1073',
    'zzz-hook-proba-torlendo':
        'egy hook-proba maradvanya, a lap SZANDEKOSAN lett torolve -- nem elveszett frissites. '
        'A tukor-sora es az allapot-fajl bejegyzese megmaradt, es 2026-09-29-ig MINDEN NAP '
        'exit 1-et adott a feladatnak. AMIERT EZ NEM KOZOMBOS: aznap kerult a feladatba a '
        'harmadik ag (`utemezett-meret-or`), es egy ALLANDOAN PIROS feladatban egy uj or '
        'jelzese nem kulonboztetheto meg a megszokott bukastol -- a sajat riasztasunk nyelte '
        'volna el. A sorok TORLESE tovabbra is data_delete -> level 1; addig allapot.',
}


def lap_orszem():
    """A LAP-FAJLOK elveszett-frissites orszeme (marci leletebol, 2026-09-18).

    A `MEMORY.md`-re 2026-09-17 ota all az APPEND-szabaly es ket gepi jel. A LAP-fajlokra
    eddig SEMMI nem allt, pedig ugyanaz a mechanizmus: kozos konyvtar, tobb iro, es egy
    `cat > lap.md` ugyanugy elvisz mindent, mint egy elveszett frissites az indexen. Aznap a
    boss neman felulirta marci frissen irt lapjat; az EGYETLEN nyom ket mutato-sor volt a
    `MEMORY.md`-ben, es az is csak azert, mert MINDKETTEN irtak indexsort is.

    A JEL: a legutobb TUKROZOTT torzsbol eltunt-e sor. Az append (a szokasos bovites) nem
    vesz el sort, tehat csendes; egy felulirasnal viszont a regi szoveg sorai hianyoznak.

    >>> ES AMIT EZ SZERKEZETILEG NEM TUD MEGFOGNI, KIMERVE: <<<
    a tukor NAPONTA fut (08:40). Ha egy lap a ket futas KOZOTT keletkezik ES iródik felul --
    mint a `gondolatjel-tiltas-hatokore` 2026-09-18-an --, akkor a tukorben NULLA sora van,
    tehat nincs mihez hasonlitani. Az aznapi esetet ez az or NEM fogta volna meg. Amit fog:
    a ket futas kozott ELVESZETT tartalmat egy MAR tukrozott lapon.
    A same-day create-and-overwrite eset ellen a vedelem az IRAS oldalan all (nezd meg
    `ls`-sel, letezik-e a lap, es ha igen, APPENDELJ), nem itt.

    A KIMENET KETFELE, mert a teendo is mas: ELTUNT SOR (lehet elveszett frissites) es
    HIANYZO FAJL (tipikusan atnevezes -- a tukor-sor ilyenkor elavult, nem a lap veszett el).
    """
    try:
        import sqlite3
        db = sqlite3.connect(f'file:{os.path.join(GYOKER, "store", "claudeclaw.db")}?mode=ro', uri=True)
        sorok = db.execute("SELECT content FROM memories WHERE agent_id='fajl-tar'").fetchall()
        db.close()
    except Exception as e:
        return [f'a lap-orszem NEM FUTOTT LE ({e.__class__.__name__}: {e})'], []

    eltunt, hianyzo = [], []
    for (c,) in sorok:
        m = re.match(r'\[' + MARKER + r': ([^\]]+)\]\n(.*)', c or '', re.S)
        if not m:
            continue
        nev, regi = m.group(1), m.group(2)
        if nev.startswith('__'):
            continue                      # az index sora, arra a masik or nez
        ut = os.path.join(TAR, nev + '.md')
        if not os.path.exists(ut):
            hianyzo.append(nev)
            continue
        try:
            _, torzs_uj = frontmatter(open(ut, encoding="utf-8").read())
        except Exception:
            continue
        # Az ELSO tukrozott sor a `description` ujraepitve (lasd a tukrozes alakjat), tehat
        # nem a torzs resze -- enelkul MINDEN lap egy eltunt sort mutatna. (Kimerve: 320/320.)
        regi_sorok = [l for l in regi.split('\n')[1:] if l.strip()]
        uj_halmaz = set(l for l in torzs_uj.split('\n') if l.strip())
        hiany = [l for l in regi_sorok if l not in uj_halmaz]
        if hiany:
            eltunt.append((nev, len(hiany), len(regi_sorok)))

    jelzes = []
    if eltunt:
        jelzes.append(f'LAPBOL ELTUNT SOR (elveszett frissites?): {len(eltunt)} lap')
        for nev, k, ossz in sorted(eltunt, key=lambda x: -x[1])[:6]:
            jelzes.append(f'   {nev}: {k} sor a tukrozott {ossz}-bol')
    ismert = [n for n in hianyzo if n in ISMERT_ARVA]
    ujak = [n for n in hianyzo if n not in ISMERT_ARVA]
    if ujak:
        jelzes.append(f'TUKROZOTT LAP FAJLJA NINCS MEG (atnevezes?): {len(ujak)}')
        for nev in sorted(ujak)[:6]:
            jelzes.append(f'   {nev}')
    allapot = [f'{n}: {ISMERT_ARVA[n]}' for n in sorted(ismert)]
    return jelzes, allapot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--limit', type=int, default=0,
                    help='csak ennyi lapot ir (a mechanizmus probajahoz, nem uzemszeruen)')
    args = ap.parse_args()

    allapot = allapot_betolt()
    uj, valt, valtozatlan, hiba = [], [], 0, []
    tartos_elutasitas = []

    for fajl in sorted(os.listdir(TAR)):
        if not fajl.endswith('.md') or fajl in KIHAGY:
            continue
        ut = os.path.join(TAR, fajl)
        with open(ut, encoding='utf-8') as f:
            szoveg = f.read()
        meta, torzs = frontmatter(szoveg)
        nev = meta.get('name') or fajl[:-3]
        leiras = meta.get('description', '')
        mtime = int(os.path.getmtime(ut))
        h = hashlib.sha256(szoveg.encode('utf-8')).hexdigest()[:16]

        regi = allapot.get(nev)
        if nev.startswith('__'):
            continue
        if regi and regi.get('hash') == h:
            if regi.get('elutasitva'):
                tartos_elutasitas.append((nev, regi['elutasitva']))
            else:
                valtozatlan += 1
            continue

        tartalom = (f'[{MARKER}: {nev}]\n'
                    f'{leiras}\n\n{torzs}').strip()
        rekord = {'nev': nev, 'hash': h, 'mtime': mtime,
                  'tartalom': tartalom, 'kulcsszavak': kulcsszavak(nev, leiras),
                  'memory_id': (regi or {}).get('memory_id')}
        (valt if regi else uj).append(rekord)

    print(f'lap a tarban   : {len([f for f in os.listdir(TAR) if f.endswith(".md") and f not in KIHAGY])}')
    print(f'UJ             : {len(uj)}')
    print(f'VALTOZOTT      : {len(valt)}')
    print(f'valtozatlan    : {valtozatlan}')
    if args.limit:
        uj, valt = uj[:args.limit], valt[:max(0, args.limit - len(uj))]
        print(f'--limit {args.limit}: ebbol a korbol uj {len(uj)}, valtozott {len(valt)}')
    if args.dry_run:
        for r in (uj + valt)[:8]:
            print(f'   {r["nev"][:46]:46s} {time.strftime("%Y-%m-%d %H:%M", time.localtime(r["mtime"]))}')
        print('\nDRY RUN, nem irtam semmit.')
        return 0

    for r in uj:
        try:
            v = dash_api('POST', '/api/memories',
                         {'agent_id': 'fajl-tar', 'content': r['tartalom'],
                          'category': 'shared', 'keywords': r['kulcsszavak']})
            allapot[r['nev']] = {'hash': r['hash'], 'memory_id': v.get('id'), 'mtime': r['mtime']}
        except Exception as e:
            ok = str(e)[:120]
            # Ha UGYANAZ az ok, mint legutobb, az ALLAPOT, nem esemeny -- akkor is,
            # ha a lap kozben valtozott. Egy tema-lap folyamatosan bovul (wikilinkek),
            # tehat minden korben ujraprobalna, es minden korben ugyanugy bukna:
            # exit 1-gyel a feladat naponta bukottnak latszana. UJ ok viszont esemeny.
            elozo = (allapot.get(r['nev']) or {}).get('elutasitva')
            if elozo == ok:
                tartos_elutasitas.append((r['nev'], ok))
            else:
                hiba.append((r['nev'], str(e)[:90]))
            allapot[r['nev']] = {'hash': r['hash'], 'memory_id': None,
                                 'mtime': r['mtime'], 'elutasitva': ok}
    for r in valt:
        try:
            if r['memory_id']:
                dash_api('PUT', f'/api/memories/{r["memory_id"]}',
                         {'content': r['tartalom'], 'keywords': r['kulcsszavak']})
                allapot[r['nev']] = {'hash': r['hash'], 'memory_id': r['memory_id'], 'mtime': r['mtime']}
            else:
                v = dash_api('POST', '/api/memories',
                             {'agent_id': 'fajl-tar', 'content': r['tartalom'],
                              'category': 'shared', 'keywords': r['kulcsszavak']})
                allapot[r['nev']] = {'hash': r['hash'], 'memory_id': v.get('id'), 'mtime': r['mtime']}
        except Exception as e:
            ok = str(e)[:120]
            # Ugyanaz az ag, mint az UJ lapoknal: azonos ok -> ALLAPOT, uj ok -> ESEMENY.
            elozo = (allapot.get(r['nev']) or {}).get('elutasitva')
            if elozo == ok:
                tartos_elutasitas.append((r['nev'], ok))
            else:
                hiba.append((r['nev'], str(e)[:90]))
            allapot[r['nev']] = {'hash': r['hash'], 'memory_id': r['memory_id'],
                                 'mtime': r['mtime'], 'elutasitva': ok}

    index_jelzes = index_orszem(allapot)

    # AZ INDEX MAGA IS ATMEGY -- KULONBEN AZ OR DETEKTAL, DE NINCS MIBOL VISSZAALLITANI
    # (safar merte ki 2026-09-17: a kozos memoria-tar EGYIK ejszakai mentesben sincs benne,
    # a `claudeclaw.db` viszont MINDKETTOBEN. A lapok igy a tukrozes miatt visszaallithatok,
    # de a MEMORY.md nem lap, tehat nem ment at -- es a mai veszteseg EPP az indexben tortent.
    # Egy or es egy visszaallitasi pont ket kulon dolog, es konnyu az elsot a masodiknak erezni.)
    if not args.limit:
        try:
            with open(os.path.join(TAR, 'MEMORY.md'), encoding='utf-8') as f:
                ix = f.read()
            ih = hashlib.sha256(ix.encode('utf-8')).hexdigest()[:16]
            ir = allapot.get('__memory_md__') or {}
            if ir.get('hash') != ih:
                tart = f'[{MARKER}: __index__ (MEMORY.md)]\n\n{ix}'
                if ir.get('memory_id'):
                    dash_api('PUT', f'/api/memories/{ir["memory_id"]}',
                             {'content': tart, 'keywords': 'MEMORY.md, index, mutato, tukor'})
                    mid = ir['memory_id']
                else:
                    mid = dash_api('POST', '/api/memories',
                                   {'agent_id': 'fajl-tar', 'content': tart, 'category': 'shared',
                                    'keywords': 'MEMORY.md, index, mutato, tukor'}).get('id')
                allapot['__memory_md__'] = {'hash': ih, 'memory_id': mid}
                print(f'\nINDEX ATMASOLVA (visszaallitasi pont): memory_id={mid}, '
                      f'{len(ix)} karakter / {len(ix.encode())} bajt')
            else:
                print('\nindex valtozatlan, visszaallitasi pont megvan '
                      f'(memory_id={ir.get("memory_id")})')
        except Exception as e:
            print(f'\nINDEX-TUKROZES BUKOTT: {str(e)[:140]}')
            index_jelzes.append(f'az index tukrozese bukott: {str(e)[:100]}')

    tmp = ALLAPOT + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(allapot, f, ensure_ascii=False, indent=1)
    os.replace(tmp, ALLAPOT)

    sikeres_uj = len([r for r in uj if (allapot.get(r['nev']) or {}).get('memory_id')])
    sikeres_valt = len([r for r in valt if not (allapot.get(r['nev']) or {}).get('elutasitva')])
    print(f'\nbeirva: uj {sikeres_uj} | valtozott {sikeres_valt} | UJ HIBA {len(hiba)}')
    for nev, e in hiba[:10]:
        print(f'   UJ HIBA {nev}: {e}')

    # A TARTOS ELUTASITAS ALLAPOT, NEM ESEMENY (2026-09-17). A `tema-hatokor` lap
    # a dashboard injekcio-szurojenek `bash -c` mintajara illeszkedik -- egy sajat,
    # DOKUMENTALO lapunk bukik el a sajat kapunkon. Amig a lap VALTOZATLAN, ez nem
    # uj informacio: ha exit 1-et adnank ra, a feladat minden nap bukottnak latszana,
    # es egy allando hamis riasztas hasznalhatatlanna teszi a jelzest.
    # Uj vagy megvaltozott lap elutasitasa viszont ESEMENY -> exit 1.
    if index_jelzes:
        print('\n>>> INDEX-ORSZEM (a KOZOS MEMORY.md): <<<')
        for s in index_jelzes:
            print('   ' + s)

    lap_jelzes, lap_allapot = lap_orszem()
    if lap_allapot:
        print(f'\nismert arva tukor-sor (ALLAPOT, nem esemeny): {len(lap_allapot)}')
        for s_ in lap_allapot:
            print('   ' + s_)
    if lap_jelzes:
        print('\n>>> LAP-ORSZEM (a lap-fajlok elveszett-frissitese): <<<')
        for s in lap_jelzes:
            print('   ' + s)

    if tartos_elutasitas:
        print(f'\ntartosan elutasitva (valtozatlan lap, NEM uj informacio): {len(tartos_elutasitas)}')
        for nev, e in tartos_elutasitas:
            print(f'   {nev}: {e[:100]}')
    return 1 if (hiba or index_jelzes or lap_jelzes) else 0


if __name__ == '__main__':
    sys.exit(main())
