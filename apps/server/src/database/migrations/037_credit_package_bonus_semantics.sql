-- 套餐积分与赠送积分是叠加关系，赠送积分不得抵扣套餐售价。
-- 同时兼容历史初始种子价格和已调整为 280 元的旧数据；其他管理员自定义套餐不受影响。
UPDATE credit_packages
SET base_credits = 3000,
    bonus_credits = 200,
    price_fen = 30000
WHERE id = '81000000-0000-0000-0000-000000000002'
  AND code = 'standard-3000'
  AND base_credits = 2800
  AND bonus_credits = 200
  AND price_fen IN (4990, 28000);
