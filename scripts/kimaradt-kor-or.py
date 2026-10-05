#!/usr/bin/env python3
"""Kimaradt korok orszeme: `fired` utemezes + NEM ELO session = neman kihagyott kor.

MIERT (2026-09-17, Zsolt jovahagyasa; a 09-16-i evedd ugyeleti jelentes nyoman):
A `task_runs` `fired` statusza azt rogziti, hogy az utemezo BETETTE a promptot a
tmux-ba -- azt NEM, hogy a session ott volt es elvegezte. 2026-09-16-an a 07:45-os
ugyeleti jelentes `fired` volt, a session viszont halott, es a levél soha nem ment
ki. Semmi nem jelzett: egy `fired` sor pontosan ugy nez ki, mint egy sikeres nape.

AMIT EZ MER, ES AMIT NEM:
Nem tasketol fuggo "nyomot" keres -- sok kor SZANDEKOSAN nema (a drain, a memoria-
heartbeat csendes aga), tehat a "nincs nyom" ott nem hiba. Azt meri, hogy a SESSION
ELT-E abban az idoablakban, barmilyen forrasbol (naplosor, kimeno inter-agent uzenet,
kimeno csatorna-uzenet). Ha a session halott volt, MINDEN akkori `fired` kor kimaradt.

A 90 PERCES KUSZOB MERT, NEM BECSULT (2026-09-09 .. 2026-09-17, 735 idobelyeg):
    nappali resek (06-22):  n=455  median 4,5 perc  p90 43,1 perc
    60 percnel nagyobb: 22   |   90 percnel nagyobb: 1   |   120 felett: 1
Az egyetlen 90 perc feletti nappali res PONTOSAN a 09-15/09-16-i kieses (991 perc).
Tehat a kuszob 8 napon 1 igaz pozitivot es 0 hamisat ad. Az EJSZAKA kimarad: a
05:45 -> 07:03 res minden nap visszaternek, es az normalis.
"""
import sqlite3, datetime, sys, os, json, glob

GYOKER = '/root/marveen/marveen/marveen/marveen'
KUSZOB_PERC = 90
NAPPAL = (6, 22)
NAPOK = 3          # ennyi napra visszamenoleg nez


def command_tipusuak():
    """A `type: command` feladatok NYERS SHELLBEN futnak (LLM es tmux nelkul), tehat
    egy halott session NEM erinti oket -- ezeket ki kell hagyni, kulonben az or
    hamisan jelenti kimaradtnak azt, ami lefutott (pl. az `auto-update` 04:00-kor).
    A tipust a feladat SAJAT configjabol olvassuk, nem listat tartunk karban."""
    ki = set()
    for f in glob.glob(os.path.expanduser('~/.claude/scheduled-tasks/*/task-config.json')):
        try:
            if json.load(open(f)).get('type') == 'command':
                ki.add(os.path.basename(os.path.dirname(f)))
        except Exception:
            pass
    return ki


def main():
    db = sqlite3.connect(os.path.join(GYOKER, 'store', 'claudeclaw.db'))
    most = int(datetime.datetime.now().timestamp())
    tol = most - NAPOK * 86400

    q = """SELECT created_at FROM daily_logs WHERE agent_id='boss' AND created_at > ?
           UNION ALL SELECT created_at FROM agent_messages WHERE from_agent='boss' AND created_at > ?
           UNION ALL SELECT created_at FROM conversation_log
                     WHERE agent_id='boss' AND direction='out' AND created_at > ?"""
    ts = sorted(r[0] for r in db.execute(q, (tol, tol, tol)) if r[0])
    if len(ts) < 10:
        print(f'A MERO NEM LAT: {len(ts)} aktivitas-idobelyeg {NAPOK} napra. '
              'Ez nem csend, hanem elromlott meres.')
        return 2

    kihagyando = command_tipusuak()
    talalat = []
    for a, b in zip(ts, ts[1:]):
        perc = (b - a) / 60.0
        A = datetime.datetime.fromtimestamp(a)
        if perc <= KUSZOB_PERC or not (NAPPAL[0] <= A.hour < NAPPAL[1]):
            continue
        # FELADATONKENT OSSZEVONVA, nem korookent: egy 16 oras kiesesben a
        # `ledger-live-drain` 500-szor tuzel, es az EGY teny, nem 500. Egy 596 soros
        # kimenet nem jelzes, hanem zaj -- ugyanaz az alak, mint a 30 egyforma
        # kanban-komment (rituale), csak a kimeneti oldalon.
        korok = db.execute(
            """SELECT name, COUNT(*),
                      MIN(datetime(ts/1000,'unixepoch','localtime')),
                      MAX(datetime(ts/1000,'unixepoch','localtime'))
               FROM task_runs WHERE status='fired' AND ts/1000 > ? AND ts/1000 < ?
               GROUP BY name ORDER BY COUNT(*) DESC""", (a, b)).fetchall()
        korok = [k for k in korok if k[0] not in kihagyando]
        if korok:
            talalat.append((A, datetime.datetime.fromtimestamp(b), perc, korok))

    if not talalat:
        print(f'TISZTA: {NAPOK} napra visszamenoleg nincs {KUSZOB_PERC} percnel hosszabb '
              f'nappali session-szunet, amiben `fired` kor esett. '
              f'({len(ts)} aktivitas-idobelyeg vizsgalva.)')
        return 0

    print(f'>>> KIMARADT KOROK: {len(talalat)} session-szunet, amiben `fired` utemezes esett <<<')
    for A, B, perc, korok in talalat:
        ossz = sum(k[1] for k in korok)
        ora = perc / 60.0
        print(f'\n  SZUNET {A:%Y-%m-%d %H:%M} -> {B:%Y-%m-%d %H:%M}  '
              f'({ora:.1f} ora)')
        print(f'  {ossz} `fired` sor, {len(korok)} kulonbozo feladat -- a session NEM ELT.')
        print(f'  (a {len(kihagyando)} `type: command` feladat kihagyva: azok session nelkul is futnak)')
        for nev, db_, elso, utolso in korok:
            print(f'     {db_:5d}x  {nev:34s} {elso[11:16]} .. {utolso[11:16]}')
        # A SURU, ONMAGABAN NEMA korok (drain, heartbeat) nem hordoznak kart;
        # a NAPI EGYSZERI feladatok viszont igen -- azokat kulon kiirjuk.
        egyszeri = [k for k in korok if k[1] <= 3]
        if egyszeri:
            print('  EBBOL A NAPI/RITKA FELADATOK (itt a valodi kar):')
            for nev, db_, elso, _ in egyszeri:
                print(f'       {elso}  {nev}')
    print('\nA `fired` az UTEMEZO sikere, nem a vegrehajtase. Ezek a korok NEM futottak le.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
