const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const modal = fs.readFileSync(path.join(__dirname, '../src/components/PromotionPosterModal.tsx'), 'utf8');
const poster = fs.readFileSync(path.join(__dirname, '../src/promotionPoster.ts'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
const commands = fs.readFileSync(path.join(__dirname, '../src-tauri/src/commands.rs'), 'utf8');
const tauri = fs.readFileSync(path.join(__dirname, '../src-tauri/src/lib.rs'), 'utf8');

test('account credits are rendered separately with a larger value', () => {
  assert.match(app, /className="account-identity-credit"/);
  assert.match(styles, /\.account-identity-credit strong[^}]*font-size: 15px/);
});

test('home promotion action is placed before system settings and opens a custom modal', () => {
  const header = app.slice(app.indexOf('<header className="welcome-header">'), app.indexOf('</header>', app.indexOf('<header className="welcome-header">')));
  assert.ok(header.indexOf('推广赚钱') < header.indexOf('systemSettings'));
  assert.match(app, /<PromotionPosterModal onClose=/);
  assert.match(modal, /我的专属推广链接/);
  assert.match(modal, /一键复制/);
});

test('eight preset posters are available and only the first four receive QR codes', () => {
  for (let index = 1; index <= 8; index += 1) {
    const name = String(index).padStart(3, '0');
    assert.match(modal, new RegExp(`poster${name} from .*${name}\\.png`));
    assert.ok(fs.existsSync(path.join(__dirname, `../../../assets/images/poster/${name}.png`)));
  }
  assert.match(poster, /QR_PROMOTION_POSTER_COUNT = 4/);
  assert.match(modal, /预设海报 001–004 含专属二维码；自定义海报保持原图/);
});

test('poster library and preview use a two-column workspace with a two-card library grid', () => {
  assert.match(modal, /className="promotion-poster-workspace"/);
  assert.ok(modal.indexOf('className="promotion-poster-picker"') < modal.indexOf('className="promotion-poster-preview"'));
  assert.match(styles, /\.promotion-poster-workspace[^}]*grid-template-columns: minmax\(330px, \.72fr\) minmax\(380px, 1\.28fr\)/);
  assert.match(styles, /\.promotion-poster-grid[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test('local posters can be selected, persisted, listed and previewed', () => {
  assert.match(modal, /添加本地海报/);
  assert.match(modal, /choosePromotionPosterFile\(\)/);
  assert.match(modal, /importPromotionPoster\(sourcePath\)/);
  assert.match(modal, /readPromotionPosterDataUrl\(poster\.customPath\)/);
  assert.match(commands, /pub fn list_promotion_posters/);
  assert.match(commands, /pub fn import_promotion_poster/);
  assert.match(commands, /pub fn read_promotion_poster_data_url/);
  assert.match(tauri, /commands::list_promotion_posters/);
  assert.match(tauri, /commands::import_promotion_poster/);
  assert.match(tauri, /commands::read_promotion_poster_data_url/);
});

test('each QR poster uses its measured white region and reserves a prompt line', () => {
  assert.match(poster, /1: \{ sourceWidth: 1536, sourceHeight: 2736, x: 599, y: 2286, width: 338, height: 341 \}/);
  assert.match(poster, /2: \{ sourceWidth: 1584, sourceHeight: 2816, x: 581, y: 2256, width: 421, height: 425 \}/);
  assert.match(poster, /3: \{ sourceWidth: 1584, sourceHeight: 2816, x: 540, y: 2093, width: 503, height: 505 \}/);
  assert.match(poster, /4: \{ sourceWidth: 1536, sourceHeight: 2736, x: 499, y: 1962, width: 537, height: 540 \}/);
  assert.match(poster, /PROMOTION_QR_PROMPT = "扫描二维码下载注册"/);
  assert.match(poster, /region\.height - outerPadding \* 2 - textGap - fontSize/);
  assert.match(poster, /context\.fillText\(PROMOTION_QR_PROMPT/);
  assert.match(modal, /<QRCodeCanvas[^>]*size=\{512\}/);
});

test('generated PNG posters use the native save command', () => {
  assert.match(commands, /pub fn save_png_file/);
  assert.match(commands, /data:image\/png;base64/);
  assert.match(tauri, /commands::save_png_file/);
});
