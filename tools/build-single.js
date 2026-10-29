// Sestaví jeden samostatný HTML soubor (offline proti botům) – vhodný pro itch.io nebo jako náhled.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const game = fs.readFileSync(path.join(root, 'shared/game.js'), 'utf8');
html = html.replace('<script src="game.js"></script><!--inline-game-->', () => '<script>window.HK_OFFLINE_ONLY=true;\n' + game + '\n</script>');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/coilcast-offline.html'), html);
console.log('dist/coilcast-offline.html hotovo');

// varianta pro Claude artefakt (bez <html>/<head>/<body>, ty doplní hostitel)
const art = html.replace(/<!doctype html>\s*/i, '').replace(/<html[^>]*>\s*/i, '').replace(/<\/html>\s*/i, '')
  .replace(/<\/?head>\s*/gi, '').replace(/<\/?body>\s*/gi, '').replace(/^.*<!--strip-->\s*$/gm, '');
fs.writeFileSync(path.join(root, 'dist/artifact.html'), art);
