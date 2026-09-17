const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = fs.readFileSync(path.join(__dirname, "../src/database/migrations/049_script_library.sql"), "utf8");
const categoriesMigration = fs.readFileSync(path.join(__dirname, "../src/database/migrations/050_script_library_categories.sql"), "utf8");
const hotCategoryMigration = fs.readFileSync(path.join(__dirname, "../src/database/migrations/052_hot_fans_script_category.sql"), "utf8");
const service = fs.readFileSync(path.join(__dirname, "../src/script-library/script-library.service.ts"), "utf8");
const controller = fs.readFileSync(path.join(__dirname, "../src/script-library/script-library.controller.ts"), "utf8");
const seed = fs.readFileSync(path.join(__dirname, "../src/scripts/seed-script-library.ts"), "utf8");
const reversalSeeds = fs.readFileSync(path.join(__dirname, "../src/scripts/hot-reversal-scripts.ts"), "utf8");

test("script library persists categories, normalized scripts, pricing and idempotent usages", () => {
  for (const table of ["script_library_config", "script_library_categories", "script_library_scripts", "script_library_usages"]) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(migration, /canonical_snapshot JSON NOT NULL/);
  assert.match(migration, /UNIQUE KEY uq_script_library_usages_user_key \(user_id, idempotency_key\)/);
  assert.match(migration, /'scripts\.manage'/);
});

test("library project creation checks the quote, available balance and writes one ledger consumption", () => {
  assert.match(service, /expectedCredits!==cost/);
  assert.match(service, /FOR UPDATE/);
  assert.match(service, /可用积分不足/);
  assert.match(service, /SCRIPT_LIBRARY_CONSUMPTION/);
  assert.match(service, /category,credits_consumed[\s\S]*'SCRIPT_LIBRARY'/);
  assert.match(controller, /create-project/);
  assert.match(controller, /idempotency_key/);
});

test("script library dependencies use explicit Nest injection metadata", () => {
  assert.equal((controller.match(/@Inject\(ScriptLibraryService\)/g) || []).length, 2);
  assert.match(service, /@Inject\(DatabaseService\)/);
  assert.match(service, /@Inject\(AuditService\)/);
});

test("script library initializes mainstream fiction and short-drama categories", () => {
  for (const category of ["现代都市", "甜宠言情", "豪门总裁", "逆袭复仇", "家庭情感", "女性成长", "古装言情", "重生穿越", "悬疑刑侦", "玄幻仙侠", "系统脑洞", "科幻末世", "年代乡村", "职场商战", "青春校园", "喜剧轻松"]) {
    assert.match(categoriesMigration, new RegExp(category));
  }
});

test("hot scripts are imported from the repository and always rank before regular scripts", () => {
  assert.match(hotCategoryMigration, /'hot-fans'/);
  assert.match(hotCategoryMigration, /'热门爆粉'/);
  assert.match(seed, /resolve\(__dirname, "\.\.\/\.\.\/\.\.\/\.\.\/剧本"\)/);
  assert.match(seed, /new Set\(\["\.txt", "\.docx"\]\)/);
  assert.match(seed, /seedHotScripts/);
  assert.match(service, /CASE WHEN c\.code='hot-fans' THEN 0 ELSE 1 END/);
  assert.match(service, /c\.code category_code/);
});

test("regular scripts use the same four-part normalized format as imported hot scripts", () => {
  for (const marker of ["一、项目剧情", "二、全局角色库", "三、全局场景库", "四、分镜列表", "人物锁定：", "口播台词：", "约束："]) {
    assert.match(seed, new RegExp(marker));
  }
  assert.match(seed, /--regular-only/);
  assert.match(seed, /UPDATE script_library_scripts SET duration_seconds=\?,summary=\?,content=\?,canonical_json=/);
  assert.match(seed, /Validated \$\{scripts\.length\} normalized regular scripts/);
  assert.match(seed, /const fixedShotSeconds = 10/);
  assert.match(seed, /source_time_range: \{ start: index \* fixedShotSeconds, end: \(index \+ 1\) \* fixedShotSeconds \}/);
  assert.match(seed, /script\.canonical\.shots\.length !== expectedShotCount/);
  assert.match(seed, /shot\.duration !== fixedShotSeconds/);
  assert.match(seed, /节奏设计：\$\{shot\.timing_plan\}/);
  assert.match(seed, /actionBeatCount < 4/);
  assert.match(seed, /0～3秒：/);
  assert.match(seed, /3～7秒：/);
  assert.match(seed, /7～10秒：/);
});

test("hot library retires requested scripts and adds ten double-reversal originals", () => {
  for (const title of ["渡骸", "齐心拉车", "零点回声", "末世重生：夺回空间手链与疯狂囤货", "天山胜利隧道建设传奇"]) {
    assert.match(reversalSeeds, new RegExp(title));
  }
  for (const title of ["护士被诬换药害人", "保洁叔被诬偷助学金", "直播助理被诬泄密", "寡妇被诬兑水卖奶", "古玩学徒被诬调包", "老厨师被诬下毒", "救援志愿者被诬吞款", "女研究员被诬删数据", "伴娘被诬偷婚镯", "护工被诬虐待老人"]) {
    assert.match(reversalSeeds, new RegExp(title));
  }
  assert.match(reversalSeeds, /第一条反证/);
  assert.match(reversalSeeds, /再次反咬/);
  assert.match(reversalSeeds, /终极反转/);
  assert.match(seed, /DELETE FROM script_library_scripts WHERE category_id=\?/);
  assert.match(seed, /script\.canonical\.shots\.length !== 12/);
});
