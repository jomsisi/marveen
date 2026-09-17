#!/usr/bin/env python3
"""A ledger-drain KEZBESITO burka: a kerdest shell teszi fel, nem egy LLM-kor.

MIERT (2026-09-17, Zsolt jovahagyasa, Telegram 3709):
A `ledger-live-drain` eddig `heartbeat` tipuskent futott: ketpercenkent egy LLM-kor
tette fel a kerdest, TELJES session-kontextussal. Merve (7 nap, a transzkriptek
`usage` mezoibol): ez volt a teljes token-fogyasztas **54,7 szazaleka**, es ebbol
**96 szazalek CACHE-OLVASAS** -- 1,6M token kontextus ujraolvasasa korönkent, 702
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
"""
import json, os, re, subprocess, sys, time

GYOKER = '/root/marveen/marveen/marveen/marveen'
FUGGO = os.path.join(GYOKER, 'store', 'ledger-drain-fuggo.jsonl')
NAPLO = os.path.join(GYOKER, 'store', 'ledger-drain-wrapper.log')
BELYEG = os.path.join(GYOKER, 'store', 'ledger-drain-wrapper.allapot')
DRAIN = os.environ.get('DRAIN_CMD',
                       f'python3 {GYOKER}/scripts/hooks/ledger-live-drain.py')


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


def kezbesit(blokk):
    """Inter-agent uzenet SAJAT MAGAMNAK: a router beteszi a session inputjaba,
    tehat ugyanugy elem meg, mintha a heartbeat hozta volna fel -- csak CSAK AKKOR,
    ha van mit. A szoveg STDIN-en megy (a helper az argumentum-format elutasitja)."""
    uzenet = (
        '[ELVESZETT BEJOVO UZENET -- a ledger-drain hozta felszinre]\n\n'
        'Ez egy korabban ELVESZETT, meg megvalaszolatlan bejovo uzenet a Telegram\n'
        'csatornabol: a csatorna elnyelte, es a rendszer csak most talalta meg.\n'
        'VALASZOLJ RA MOST a reply toollal, a blokkban szereplo chat_id-ra, ugyanugy,\n'
        'mintha eppen most erkezett volna.\n\n'
        + blokk
    )
    p = subprocess.run(['bash', os.path.join(GYOKER, 'scripts', 'agent-msg.sh'),
                        'boss', 'boss', '-'],
                       input=uzenet.encode('utf-8'),
                       capture_output=True, cwd=GYOKER)
    ki = (p.stdout or b'').decode() + (p.stderr or b'').decode()
    m = re.search(r'OK id=(\d+)', ki)
    return (m.group(1) if m else None), ki.strip()[:200]


def belyeg(allapot):
    """Futas-belyeg MINDEN korben, nem csak talalatnal. Egy or, ami ures korben
    semmit nem hagy, kivulrol megkulonboztethetetlen egy elromlottol -- es ez a
    mechanizmus Zsolt uzeneteinek harmadat viszi, tehat a "fut-e egyaltalan"
    kerdesre kell tudni valaszolni. Egyetlen fajl, nem novekvo naplo."""
    try:
        elozo = json.load(open(BELYEG))
    except Exception:
        elozo = {}
    ki = {'utolso_futas': time.strftime('%F %T'),
          'futasok': elozo.get('futasok', 0) + 1,
          'utolso_allapot': allapot,
          'utolso_talalat': elozo.get('utolso_talalat')}
    if allapot == 'talalat':
        ki['utolso_talalat'] = ki['utolso_futas']
    tmp = BELYEG + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(ki, f, ensure_ascii=False, indent=1)
    os.replace(tmp, BELYEG)


def main():
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

    # 3. KEZBESITES, es csak SIKER utan toroljuk a fuggobol.
    maradt, kuldott = [], 0
    for tetel in fuggo:
        tetel['probak'] = tetel.get('probak', 0) + 1
        mid, ki = kezbesit(tetel['blokk'])
        if mid:
            kuldott += 1
            log(f'KEZBESITVE: uzenet {mid} | {tetel["blokk"].split(chr(10))[0]} '
                f'| {tetel["probak"]}. proba')
        else:
            maradt.append(tetel)
            log(f'KEZBESITES BUKOTT ({tetel["probak"]}. proba): {ki}')
    ment(maradt)

    belyeg('talalat' if kuldott else 'kezbesites-bukas')
    if maradt:
        kor = (int(time.time()) - min(t['elso'] for t in maradt)) / 60.0
        log(f'FUGGOBEN: {len(maradt)} tetel, a legregebbi {kor:.0f} perce. '
            'Amig ez nem nulla, a feladat BUKOTTNAK szamit.')
        return 1
    return 0 if kuldott or not kimenet else 0


if __name__ == '__main__':
    sys.exit(main())
