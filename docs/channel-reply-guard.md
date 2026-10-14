# channel-reply-guard — Stop hook

## Problem

A Marveen agent that talks to a user over a channel (Telegram / Slack / Discord)
sometimes *generates* its reply as plain text but forgets to call the channel
send-tool. When that happens the answer only lands in the CLI transcript and
**never reaches the user** — the user is left waiting, with no idea whether the
agent is working or stuck.

## What the hook does

`scripts/channel-reply-guard.sh` runs on the `Stop` event. At the end of every
turn it checks:

1. Did the **last user message come from a channel**? (It looks for the
   `<channel source="plugin:telegram...">` / `← telegram` markers.)
2. If so, was there a **channel send-tool call** after that message?
   (Any tool whose name contains `telegram`, `reply`, `slack`, or `discord`.)

If the message was from a channel but **no send-tool was called**, the hook
returns `{"decision":"block"}` with a reminder, so the model sends the reply
before the turn ends.

Heartbeat / scheduled-task prompts (where staying silent is correct) are
explicitly skipped — they may end without a send.

## How to enable it

Add it to the `Stop` hooks in your `.claude/settings.json` (alongside any
existing Stop hooks):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/scripts/channel-reply-guard.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

(Use an absolute path if `${CLAUDE_PROJECT_DIR}` is not available in your setup.)

After editing `settings.json`, open the `/hooks` menu once (or restart the
session) so the hook is picked up.

## Relation to #210

PR #210 stops sub-agents from stealing the Telegram poller and lets heartbeats
answer direct messages — it protects the *inbound* path. This hook protects the
*outbound* path: it guarantees the agent's reply actually leaves through the
channel. The two are complementary.

## A HATOKOR SZUKEBB A NEVENEL -- A NAPLO SZAMAIT IGY KELL OLVASNI (michel merese, 2026-09-30)

A naplo 2267 sorabol MINDOSSZE EGY volt `ATENGED volt csatorna-kuldes`. **Ez nem azt jelenti, hogy
alig valaszolunk csatornan**, hanem hogy a valaszolt korokben az utolso user-esemeny mar a
`tool_result` -- vagyis az or gyakorlatilag csak azt az esetet latja, amikor a csatorna-uzenet
UTAN egyaltalan nem tortent semmi. Ez a Stop hook szerkezetebol kovetkezik, nem elromlott allapot.

**KET TOVABBI KIKOTES, amit ugyanaz a meres hozott:**
1. **A tomoritesi osszefoglalo NEM erkezes.** Az `is_channel` reszszoveg-kereses, es egy
   osszefoglalo IDEZHETI a csatorna-tag alakjat -- 2026-09-30-an michel korenel pontosan ez
   blokkolt hamisan. A kizaras MEZO-alapu (`isCompactSummary`), nem ujabb minta. A kar
   aszimmetrikus volt: a heartbeat-KIVETEL jelolojet a tomorites elmossa, a TUZELO mintat atviszi.
2. **A naplonak van agens-oszlopa** (`CLAUDE_CONFIG_DIR`-bol). Elotte a BLOKKOL sorok nem voltak
   agenshez kothetok, ami egy flotta-szintu ornel onmagaban hiany.
3. **Merest `CHANNEL_GUARD_TESZT=1`-gyel futtass:** az agens-oszlopba `TESZT` kerul. A naplo KOZOS,
   es egy mutacios teszt kilenc sora 2026-09-30-an epp egy MASIK agens darabszamait tolta el.

## A MUTANS-KESZLET (2026-09-30) -- ezekkel kell ujramerni minden valtoztatas utan

```
M0  valtozatlan eles transcript ............................ atenged
M1  tomorites, ami IDEZI a csatorna-minta alakjat .......... atenged   (a hamis pozitiv, javitva)
M2  valodi csatorna-uzenet, kuldes NELKUL .................. BLOKKOL   (pozitiv kontroll)
M3  valodi csatorna-uzenet + kuldes ........................ atenged
M4  heartbeat/scheduled-task, tomorites nelkul ............. atenged
M5  valodi csatorna-uzenet, kuldes nelkul, UTANA tomorites . BLOKKOL   (a `continue` helyet meri)
```
**Az M5 az egyetlen, ami a `continue` HELYET meri** (a `role == "user"` vizsgalat ELOTT kell allnia).
A kezenfekvo alternativa -- "ha az utolso user-esemeny tomorites, engedd at a kort" -- az M1-en
ugyanugy helyes, az M5-on viszont ATENGED, tehat egy megvalaszolatlan csatorna-uzenet csendben
elveszik. Kivulrol a ket alak megkulonbozhetetlen.

**A merest `CHANNEL_GUARD_TESZT=1`-gyel futtasd**, es a REGI szkriptet is futtasd le ugyanazon a
bemeneten: kulonben csak azt tudod, hogy az UJ helyesen viselkedik, nem azt, hogy a REGI elsul.

## A NAPLO SZAMAINAK MEROESZKOZE: A DONTES-OSZLOP, NEM A SZO (2026-09-30, ket agens meresebol)

**A `grep 'BLOKKOL'` alak NEM HASZNALHATO, es az ok maga a dokumentacio:** a naploba irt
MEGJEGYZES-sorok IDEZIK a szot, tehat sajat talalatot adnak. Merve:
```
a 'BLOKKOL' szo barhol a sorban ..... 14
a DONTES-OSZLOP == 'BLOKKOL' ........ 12
a kulonbseg ......................... 2  = a ket MEGJEGYZES sor
```
**Minden tovabbi helyesbito jelolo EGGYEL tovabb tolja a naiv lekerdezest a valoditol** -- vagyis egy
magyarazo sor a naploban nem semleges, hanem a MERO BEMENETE. Ezert all ez a mondat ITT es nem a
naploban: **a magyarazat a korpuszon KIVUL a helye, amirol szol.** (Ugyanaz az alak, mint amikor egy
negativ kontroll ERTEKE bekerul a sajat korpuszaba.)

**AZ ERVENYES SZURO HAROM TAGU**, es a `MEGJEGYZES-2` sor is ezt irja elo:
```
dontes-oszlop == 'BLOKKOL'   (3 mezos sornal a 2., 4 mezosnel a 3.)
ES az agens-oszlop != 'TESZT'
ES essen ki a 2026-09-30T09:25:59 - 09:26:01 ablak
-> BLOKKOL 5, 'volt csatorna-kuldes' 1
```
**Az elso tag TOTALIS, kimerve:** a fajlban CSAK 3 es 4 mezos sor van (2271 + 19), harmadik alak
nincs -- tehat a szuro nem tud csendben kihagyni sort. **Ez egyben az ELAVULASI PROBA: ha felbukkan
egy 5 mezos sor, a jelolo elavult.**

## A MEZO FEDESE TELJES, ES A JAVITAS HANGOSAN BUKIK (michel merese a SAJAT transcriptjen)

Egy mezore epulo kizarasnal a kerdes nem az, hogy a mezo LETEZIK-e, hanem hogy MINDEN peldanyt
jelol-e. Azon a transcripten, ahol a hamis pozitiv TENYLEG megtortent:
```
isCompactSummary mezovel jelolt esemeny ................ 3   (idx 3529, 6946, 10144)
szoveg-alapon felismert osszefoglalo (fuggetlen mero) .. 3   (UGYANAZ a harom idx)
egyezes ................................................ 3/3
```
**ES EGY JO TULAJDONSAG, amit ritka rogziteni:** ha egy kesobbi verzio atnevezi vagy elhagyja a
mezot, a kizaras csendben megszunik -- de akkor az or a REGI viselkedeshez ter vissza, vagyis idezett
mintara BLOKKOL. **Az avulas tehat a hamis POZITIV iranyaba visz, nem a hamis negativ irányába**, es
igy HANGOS. A mezore csereles tobbsege ennek az ellenkezoje.
