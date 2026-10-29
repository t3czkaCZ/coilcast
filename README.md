# Coilcast

Hadí .io hra s kouzly ve stylu Mario Kart, lobby pro kamarády a boty.
Hra je anglicky a česky. Jazyk se vybere podle prohlížeče a přepíná se tlačítkem CZ/EN v menu.

## Nasazení zdarma: GitHub + Render

### 1. GitHub
1. Přihlas se na github.com a vpravo nahoře dej **+ → New repository**.
2. Jméno `coilcast`, nech **Public** a klikni na **Create repository**.
3. Na stránce nového repozitáře klikni na odkaz **uploading an existing file**.
4. Rozbal `coilcast.zip` a přetáhni do okna **všechno, co je uvnitř**: složky `public`, `server`, `shared`, `tools` a soubory `package.json`, `package-lock.json`, `render.yaml`, `README.md`, `.gitignore`.
   Na Macu se soubor `.gitignore` ve Finderu nezobrazuje. Nevadí, není nutný.
5. Dole klikni na **Commit changes**.

### 2. Render
1. Na render.com se přihlas tlačítkem **GitHub**.
2. Klikni na **New → Blueprint** a vyber repozitář `coilcast`. Pokud ho nevidíš, klikni na **Configure GitHub** a povol Renderu přístup k repozitáři.
3. Render načte `render.yaml`, takže je už vše nastavené (Node, free plán, `npm install`, `npm start`). Klikni na **Deploy Blueprint**.
4. Po pár minutách uvidíš adresu typu `https://coilcast-xxxx.onrender.com`. To je tvoje hra.

Když se Blueprint nechce rozjet, jde to i ručně: **New → Web Service**, vyber repozitář, Build `npm install`, Start `npm start`, Instance **Free**.

### 3. Hraní s kamarády
Otevři adresu z Renderu, klikni na **Create lobby** (Vytvořit lobby) a pošli kamarádům **Copy invite** (Kopírovat pozvánku).

Free server se po 15 minutách bez hráčů uspí. Kdo pak hru otevře první, čeká zhruba minutu, než se probudí.

### Server ve Frankfurtu (nižší ping)
`render.yaml` vytváří server ve Frankfurtu. Render ale neumí přesunout už existující službu do jiného regionu.
Pokud ti hra běží v Oregonu (USA):
1. Na GitHubu nahraj nové soubory (přepiš staré).
2. Na Renderu otevři starou službu → **Settings** → úplně dole **Delete Web Service**.
3. Dej znovu **New → Blueprint** a vyber repozitář. Nová služba vznikne ve Frankfurtu.

Ping vidíš ve hře nad minimapou. Zelená znamená pod 80 ms, žlutá pod 160 ms.

### Úpravy hry později
Uprav soubor přímo na GitHubu (ikona tužky), nebo nahraj novou verzi přes **Add file → Upload files**.
Render si změnu všimne a za pár minut nasadí novou verzi sám.

## Spuštění u sebe
```bash
npm install
npm start          # http://localhost:3000
```

## Struktura

| Soubor | Co dělá |
|---|---|
| `shared/game.js` | Herní logika: pohyb, boti, kouzla, kolize. Běží na serveru i v prohlížeči. |
| `server/index.js` | HTTP + WebSocket server, veřejné arény a soukromé lobby. |
| `public/index.html` | Klient: vykreslování, menu, skiny, XP, jazyky, lobby. |
| `render.yaml` | Nastavení pro Render. |
| `tools/build-single.js` | `npm run build:single` vyrobí `dist/coilcast-offline.html` (jen proti botům). |

## Nastavení (proměnné prostředí)
| Proměnná | Výchozí | Význam |
|---|---|---|
| `ROOM_MAX` | 20 | max. lidí ve veřejné aréně |
| `LOBBY_MAX` | 12 | max. lidí v lobby |

## Síťový kód
- Server počítá hru 40× a hráčům posílá stav 20× za sekundu. Minimapa a žebříček chodí jen 5× za sekundu.
- **Předpověď pohybu:** klient čísluje vstupy a vlastního hada posouvá hned. Server vrací číslo posledního zpracovaného vstupu a klient z jeho stavu dopočítá zbytek. Rozdíl se plynule dorovná, takže had zatočí okamžitě i při vyšším pingu.
- Ostatní hadi se vykreslují s malým zpožděním (85 ms) a plynule mezi snímky.
- Poškozená nebo useknutá zpráva od klienta server neshodí.
- `?debug=1` v adrese zpřístupní v konzoli `window.__cc` (stav sítě a předpovědi).

## Boti
Boti jsou schválně slabší než člověk. Každý má náhodnou „šikovnost“, reaguje pomaleji, občas si nebezpečí nevšimne, kouzla používá opatrně, jeho rakety hůř zatáčejí a roste pomaleji.
Nastavuje se ve funkci `botThink` v `shared/game.js`.

## Klient na herním portálu, server na Renderu
Až hru nahraješ na portál (CrazyGames a podobné), klient se připojí k serveru přes
`index.html?server=wss://coilcast-xxxx.onrender.com/ws`
nebo přes `<script>window.HK_SERVER_URL='wss://…/ws'</script>` vložený před načtením hry.
